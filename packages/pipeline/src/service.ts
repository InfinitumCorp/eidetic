// © Infinitum Corporation®. All rights reserved.

import type { MerkleCheckpoint, TrillianCheckpointPort } from "@eidetic/audit";
import { evaluateFairness, evaluateFixtureFairness, type EvaluationCase, type FairnessReport } from "@eidetic/bias";
import { buildConsentReceipt, type FidesConsentPort } from "@eidetic/consent";
import {
  CID_PATTERN,
  CODE_PATTERN,
  EideticError,
  LEGAL_BASES,
  LocalPatternRedactor,
  OUT_OF_SCOPE_PATTERN,
  ROLES,
  assertRecordAttributes,
  clipMessage,
  consentIsLive,
  type Actor,
  type AuditAttestation,
  type DenialCode,
  type Edition,
  type EvidenceItem,
  type LegalBasis,
  type PurposeDefinition,
  type Role,
  type TextRedactor,
} from "@eidetic/contracts";
import type { MatcherAdapter } from "@eidetic/matcher";
import { evaluateMilEdition } from "@eidetic/mil";
import type { PolicyDecider } from "@eidetic/policy";
import type { Repositories } from "./repositories.js";

export interface IdFactory {
  id: (prefix: string) => string;
  cid: () => string;
}

export interface AuditReceipt {
  seq: number;
  hash: string;
  merkleRoot: string;
}

export interface SubjectView {
  cid: string;
  displayName: string;
  status: "active" | "withdrawn";
  enrolledAt: string;
  withdrawnAt: string | null;
  recordAttributes: Record<string, string>;
  consents: Array<{
    purposeCode: string;
    datasetIds: string[];
    legalBasis: LegalBasis;
    status: "granted" | "withdrawn";
    expiresAt: string | null;
    /** True when the grant is still marked granted but its expiry has passed. */
    expired: boolean;
    receiptHash: string;
  }>;
  template: { present: boolean; quality: number | null };
}

export interface SearchResult {
  searchId: string;
  reviewId: string;
  status: "pending_review";
  finalDecision: null;
  matchRan: true;
  message: string;
  model: MatcherAdapter["model"];
  candidates: Array<{
    cid: string;
    displayName: string;
    confidence: number;
    rank: number;
    evidence: EvidenceItem[];
    consentStatus: "granted";
  }>;
  audit: AuditReceipt;
}

export interface ReviewSummary {
  reviewId: string;
  status: "pending" | "decided";
  decision: "confirm" | "reject" | "inconclusive" | null;
  finalDecision: "confirm" | "reject" | "inconclusive" | null;
  searchId: string;
  purposeCode: string;
  datasetId: string;
  legalBasis: LegalBasis;
  edition: Edition;
  createdAt: string;
  topConfidence: number | null;
  topCid: string | null;
  subjectName: string | null;
  searchedBy: { id: string; displayName: string };
}

export interface ReviewDetail extends ReviewSummary {
  notes: string | null;
  selectedCid: string | null;
  candidates: SearchResult["candidates"];
}

export interface DecisionResult {
  reviewId: string;
  searchId: string;
  finalDecision: "confirm" | "reject" | "inconclusive";
  selectedCid: string | null;
  matchRan: false;
  message: string;
  audit: AuditReceipt;
}

interface ServiceDeps {
  repos: Repositories;
  transaction: <T>(fn: (repos: Repositories) => Promise<T>) => Promise<T>;
  matcher: MatcherAdapter;
  policy: PolicyDecider;
  redactor: TextRedactor;
  fides: FidesConsentPort;
  trillian: TrillianCheckpointPort;
  milEnabled: boolean;
  now: () => Date;
  ids: IdFactory;
}

export class EideticService {
  constructor(private readonly deps: ServiceDeps) {}

  async enroll(input: {
    actor: Actor;
    displayName: string;
    image: Uint8Array;
    cid?: string;
    purposes: Array<{ purposeCode: string; datasetIds: string[]; expiresAt?: string }>;
    legalBasis: LegalBasis;
    recordAttributes?: Record<string, string>;
  }): Promise<{ cid: string; status: "active"; templateStored: true; quality: number; displayName: string; receipts: Array<{ purposeCode: string; receiptHash: string }> }> {
    this.requireRole(input.actor, "admin", "Only an admin can record enrollment and consent.");
    const displayName = cleanName(input.displayName);
    const attributes = assertRecordAttributes(input.recordAttributes);
    if (input.purposes.length === 0) {
      throw new EideticError("CONSENT_REQUIRED", "Enrollment needs at least one purpose the subject agreed to.", 422, false);
    }
    const cid = input.cid ?? this.deps.ids.cid();
    if (!CID_PATTERN.test(cid)) {
      throw new EideticError("VALIDATION", "A Cumulus://ID™ style subject id must look like cid://infinitum/<id>.", 422, false);
    }
    for (const requested of input.purposes) {
      const purpose = await this.requirePurpose(requested.purposeCode);
      if (!purpose.legalBases.includes(input.legalBasis)) {
        throw new EideticError("LEGAL_BASIS_REJECTED", `Purpose ${purpose.code} does not allow legal basis ${input.legalBasis}.`, 422, false);
      }
      if (requested.datasetIds.length === 0 || requested.datasetIds.some((datasetId) => !purpose.datasetIds.includes(datasetId))) {
        throw new EideticError("DATASET_OUT_OF_SCOPE", `Consent datasets must already belong to purpose ${purpose.code}.`, 422, false);
      }
    }
    const enrolledAt = this.deps.now();
    const expiries = input.purposes.map((requested) => {
      if (!requested.expiresAt) return null;
      const at = new Date(requested.expiresAt);
      if (Number.isNaN(at.getTime())) {
        throw new EideticError("VALIDATION", `Consent expiry for ${requested.purposeCode} is not a valid date.`, 422, false);
      }
      if (at.getTime() <= enrolledAt.getTime()) {
        throw new EideticError("VALIDATION", `Consent expiry for ${requested.purposeCode} has to be in the future.`, 422, false);
      }
      return at.toISOString();
    });
    const expiryFor = (requested: (typeof input.purposes)[number]) => expiries[input.purposes.indexOf(requested)] ?? null;

    const existing = await this.deps.repos.subjects.get(cid);
    const existingTemplate = existing ? await this.deps.repos.templates.activeForCid(cid) : null;
    const needTemplate = !existing || existing.status === "withdrawn" || !existingTemplate;
    let created: { templateRef: string; quality: number } | null = null;
    try {
      if (needTemplate) created = await this.deps.matcher.enroll(input.image);
      const now = enrolledAt.toISOString();
      const existingConsents = existing ? await this.deps.repos.consents.listForSubject(cid) : [];
      // An expired grant does not cover a new request, so re-enrolling renews it.
      const fresh = input.purposes.filter((requested) => {
        return !existingConsents.some(
          (consent) =>
            consentIsLive(consent, now) &&
            consent.purposeCode === requested.purposeCode &&
            consent.legalBasis === input.legalBasis &&
            sameSet(consent.datasetIds, requested.datasetIds),
        );
      });
      const receipts = fresh.map((requested) => {
        const receipt = buildConsentReceipt({
          cid,
          purposeCode: requested.purposeCode,
          datasetIds: requested.datasetIds,
          legalBasis: input.legalBasis,
          status: "granted",
          at: now,
          expiresAt: expiryFor(requested),
        });
        return { requested, hash: receipt.proof.payloadHash, receipt };
      });
      for (const item of receipts) await this.deps.fides.pushPreference(item.receipt);

      const checkpoint = await this.deps.transaction(async (tx) => {
        const subject = {
          cid,
          displayName,
          status: "active" as const,
          recordAttributes: attributes,
          enrolledAt: existing?.enrolledAt ?? now,
          withdrawnAt: null,
        };
        if (!existing) await tx.subjects.insert(subject);
        else await tx.subjects.update(subject);
        if (created) {
          await tx.templates.insert({
            id: this.deps.ids.id("tpl"),
            cid,
            storeKey: created.templateRef,
            quality: created.quality,
            modelName: this.deps.matcher.model.name,
            modelVersion: this.deps.matcher.model.version,
            createdAt: now,
            purgedAt: null,
          });
        }
        let last: MerkleCheckpoint | null = null;
        for (const item of receipts) {
          await tx.consents.insert({
            id: this.deps.ids.id("con"),
            cid,
            purposeCode: item.requested.purposeCode,
            datasetIds: item.requested.datasetIds,
            legalBasis: input.legalBasis,
            status: "granted",
            grantedAt: now,
            withdrawnAt: null,
            expiresAt: expiryFor(item.requested),
            receiptHash: item.hash,
          });
          const recorded = await tx.audit.record({
            actorId: input.actor.id,
            action: "enroll",
            recordedAt: now,
            attestation: {
              outcome: "recorded",
              matchRan: false,
              subjectCid: cid,
              purposeCode: item.requested.purposeCode,
              datasetId: item.requested.datasetIds[0],
              legalBasis: input.legalBasis,
              sealedStorePurged: false,
              receiptHash: item.hash,
              model: `${this.deps.matcher.model.name}@${this.deps.matcher.model.version}`,
              message: "Consent recorded. The biometric template stays in the sealed store and is not part of this attestation.",
            },
          });
          last = recorded.checkpoint;
        }
        return last;
      });
      if (checkpoint) await this.submit(checkpoint);
      const template = created ?? existingTemplate;
      return {
        cid,
        status: "active",
        templateStored: true,
        quality: template?.quality ?? 0,
        displayName,
        receipts: receipts.map((item) => ({ purposeCode: item.requested.purposeCode, receiptHash: item.hash })),
      };
    } catch (error) {
      if (created) await this.deps.matcher.purge(created.templateRef);
      throw error;
    }
  }

  async withdraw(actor: Actor, cid: string): Promise<SubjectView> {
    this.requireRole(actor, "admin", "Only an admin can record a consent withdrawal.");
    const subject = await this.deps.repos.subjects.get(cid);
    if (!subject) throw new EideticError("NOT_FOUND", "No enrolled subject uses that CID.", 404, false);
    const active = await this.deps.repos.templates.activeForCid(cid);
    if (active) await this.deps.matcher.purge(active.storeKey);
    const now = this.deps.now().toISOString();
    const checkpoint = await this.deps.transaction(async (tx) => {
      await tx.subjects.update({ ...subject, status: "withdrawn", withdrawnAt: subject.withdrawnAt ?? now });
      await tx.consents.withdrawAll(cid, now);
      await tx.templates.markPurged(cid, now);
      const recorded = await tx.audit.record({
        actorId: actor.id,
        action: "withdraw",
        recordedAt: now,
        attestation: {
          outcome: "recorded",
          matchRan: false,
          subjectCid: cid,
          sealedStorePurged: true,
          message: "Consent withdrawn. Sealed templates were purged. This attestation has no biometric payload.",
        },
      });
      return recorded.checkpoint;
    });
    await this.submit(checkpoint);
    return this.subjectView(cid);
  }

  async createPurpose(actor: Actor, purpose: PurposeDefinition): Promise<PurposeDefinition> {
    this.requireRole(actor, "admin", "Only an admin can publish a purpose.");
    if (!CODE_PATTERN.test(purpose.code) || purpose.datasetIds.some((datasetId) => !CODE_PATTERN.test(datasetId))) {
      throw new EideticError("VALIDATION", "Purpose and dataset codes use lowercase snake case.", 422, false);
    }
    if (purpose.legalBases.length === 0 || purpose.datasetIds.length === 0 || purpose.allowedRoles.length === 0) {
      throw new EideticError("VALIDATION", "A purpose needs a legal basis, a dataset, and a role.", 422, false);
    }
    if (purpose.legalBases.some((basis) => !LEGAL_BASES.includes(basis)) || purpose.allowedRoles.some((role) => !ROLES.includes(role))) {
      throw new EideticError("VALIDATION", "Purpose roles and legal bases must use the known sets.", 422, false);
    }
    if (
      OUT_OF_SCOPE_PATTERN.test(purpose.code) ||
      OUT_OF_SCOPE_PATTERN.test(purpose.title) ||
      OUT_OF_SCOPE_PATTERN.test(purpose.description) ||
      purpose.datasetIds.some((datasetId) => OUT_OF_SCOPE_PATTERN.test(datasetId))
    ) {
      throw new EideticError("FORBIDDEN", "That purpose is outside civilian and business consent-based use.", 403, false);
    }
    const mil = evaluateMilEdition(purpose.edition, this.deps.milEnabled);
    if (mil.blocked) throw new EideticError(mil.code, mil.message, 403, false);
    const now = this.deps.now().toISOString();
    const checkpoint = await this.deps.transaction(async (tx) => {
      await tx.purposes.upsert(purpose);
      const recorded = await tx.audit.record({
        actorId: actor.id,
        action: "purpose_upsert",
        recordedAt: now,
        attestation: {
          outcome: "recorded",
          matchRan: false,
          purposeCode: purpose.code,
          edition: purpose.edition,
          message: `Purpose ${purpose.code} was published for ${purpose.edition} use.`,
        },
      });
      return recorded.checkpoint;
    });
    await this.submit(checkpoint);
    return purpose;
  }

  async search(input: {
    actor: Actor;
    purposeCode: string;
    legalBasis: LegalBasis;
    datasetId: string;
    edition: Edition;
    image: Uint8Array;
    subjectCid?: string;
    recordHints?: Record<string, string>;
  }): Promise<SearchResult> {
    const hints = assertRecordAttributes(input.recordHints);
    if (!input.purposeCode.trim()) {
      await this.recordDenial(input, "PURPOSE_REQUIRED", "Search refused. A purpose is required. The match did not run.");
      throw new EideticError("PURPOSE_REQUIRED", "Search refused. A purpose is required. The match did not run.", 403, false);
    }
    const purpose = await this.deps.repos.purposes.get(input.purposeCode);
    const consent = await this.consentGate(input);
    const decision = await this.deps.policy.decide({
      actor: input.actor,
      purpose,
      legalBasis: input.legalBasis,
      datasetId: input.datasetId,
      edition: input.edition,
      milEnabled: this.deps.milEnabled,
      consent,
    });
    if (!decision.allow) {
      await this.recordDenial(input, decision.code, decision.message);
      throw new EideticError(decision.code, decision.message, 403, false);
    }

    let eligible = await this.deps.repos.consents.listEligible(
      input.purposeCode,
      input.datasetId,
      input.legalBasis,
      this.deps.now().toISOString(),
    );
    if (input.subjectCid) eligible = eligible.filter((subject) => subject.cid === input.subjectCid);
    const pointers = await this.deps.repos.templates.activeForCids(eligible.map((subject) => subject.cid));
    const byCid = new Map(pointers.map((pointer) => [pointer.cid, pointer]));
    const gallerySubjects = eligible.filter((subject) => byCid.has(subject.cid));
    if (gallerySubjects.length === 0) {
      const code: DenialCode = eligible.length === 0 ? "CONSENT_REQUIRED" : "TEMPLATE_MISSING";
      const message =
        code === "CONSENT_REQUIRED"
          ? "Search refused. No subject has granted consent for this purpose and dataset. The match did not run."
          : "Search refused. Consented subjects have no active sealed template. The match did not run.";
      await this.recordDenial(input, code, message);
      throw new EideticError(code, message, 403, false);
    }

    const quality = await Promise.resolve(this.deps.matcher.assess(input.image));
    if (!quality.accept) {
      const message = clipMessage(quality.reasons.join(" "));
      await this.recordDenial(input, "CAPTURE_REJECTED", message);
      throw new EideticError("CAPTURE_REJECTED", message, 422, false);
    }
    const report = await this.deps.matcher.match({
      probe: input.image,
      gallery: gallerySubjects.map((subject) => ({
        cid: subject.cid,
        templateRef: byCid.get(subject.cid)!.storeKey,
        recordAttributes: subject.recordAttributes,
      })),
      topK: 3,
      recordHints: hints,
    });
    const names = new Map(gallerySubjects.map((subject) => [subject.cid, subject.displayName]));
    const now = this.deps.now().toISOString();
    const searchId = this.deps.ids.id("sch");
    const reviewId = this.deps.ids.id("rev");
    const persisted = await this.deps.transaction(async (tx) => {
      await tx.searches.insert({
        id: searchId,
        actorId: input.actor.id,
        purposeCode: input.purposeCode,
        legalBasis: input.legalBasis,
        datasetId: input.datasetId,
        edition: input.edition,
        subjectCid: input.subjectCid ?? null,
        status: "pending_review",
        denialCode: null,
        modelName: report.model.name,
        modelVersion: report.model.version,
        createdAt: now,
      });
      await tx.candidates.insertMany(
        report.candidates.map((candidate) => ({
          id: this.deps.ids.id("can"),
          searchId,
          cid: candidate.cid,
          confidence: candidate.confidence,
          rank: candidate.rank,
          evidence: candidate.evidence,
          createdAt: now,
        })),
      );
      await tx.reviews.insert({
        id: reviewId,
        searchId,
        status: "pending",
        decision: null,
        selectedCid: null,
        notes: null,
        reviewerId: null,
        decidedAt: null,
        createdAt: now,
      });
      const recorded = await tx.audit.record({
        actorId: input.actor.id,
        action: "search",
        recordedAt: now,
        attestation: {
          outcome: "allowed",
          matchRan: true,
          purposeCode: input.purposeCode,
          datasetId: input.datasetId,
          legalBasis: input.legalBasis,
          edition: input.edition,
          subjectCid: input.subjectCid,
          searchId,
          reviewId,
          candidateCount: report.candidates.length,
          topConfidence: report.candidates[0]?.confidence,
          model: `${report.model.name}@${report.model.version}`,
          message: "Search recorded. Results stay unconfirmed until a reviewer decides.",
        },
      });
      return recorded.checkpoint;
    });
    await this.submit(persisted);
    return {
      searchId,
      reviewId,
      status: "pending_review",
      finalDecision: null,
      matchRan: true,
      message: "Match results are unconfirmed. A reviewer has to decide. Confidence is not a final decision.",
      model: report.model,
      candidates: report.candidates.map((candidate) => ({
        cid: candidate.cid,
        displayName: names.get(candidate.cid) ?? candidate.cid,
        confidence: candidate.confidence,
        rank: candidate.rank,
        evidence: candidate.evidence,
        consentStatus: "granted" as const,
      })),
      audit: { seq: persisted.throughSeq, hash: (await this.deps.repos.audit.list()).at(-1)?.hash ?? "", merkleRoot: persisted.merkleRoot },
    };
  }

  async decide(input: {
    actor: Actor;
    reviewId: string;
    decision: "confirm" | "reject" | "inconclusive";
    selectedCid?: string;
    notes: string;
  }): Promise<DecisionResult> {
    if (input.actor.role !== "reviewer") {
      throw new EideticError("FORBIDDEN", "Only a reviewer can record a human decision.", 403, false);
    }
    if (input.notes.trim().length < 8 || input.notes.length > 2000) {
      throw new EideticError("DECISION_INVALID", "A decision needs a note between 8 and 2000 characters.", 422, false);
    }
    const review = await this.deps.repos.reviews.get(input.reviewId);
    if (!review) throw new EideticError("NOT_FOUND", "That review is not on the desk.", 404, false);
    if (review.status !== "pending") {
      throw new EideticError("REVIEW_ALREADY_DECIDED", "This review already has a human decision.", 409, false);
    }
    const search = await this.deps.repos.searches.get(review.searchId);
    if (!search) throw new EideticError("NOT_FOUND", "The search behind this review is missing.", 404, false);
    if (search.actorId === input.actor.id) {
      throw new EideticError("SEPARATION_OF_DUTIES", "The person who ran the search cannot decide it.", 403, false);
    }
    const candidates = await this.deps.repos.candidates.listForSearch(search.id);
    if (input.decision === "confirm") {
      if (!input.selectedCid || !candidates.some((candidate) => candidate.cid === input.selectedCid)) {
        throw new EideticError("DECISION_INVALID", "Confirmation has to name one of the unconfirmed candidates.", 422, false);
      }
      const subject = await this.deps.repos.subjects.get(input.selectedCid);
      const consents = subject ? await this.deps.repos.consents.listForSubject(subject.cid) : [];
      const at = this.deps.now().toISOString();
      const covers = (consent: (typeof consents)[number]) =>
        consent.purposeCode === search.purposeCode &&
        consent.legalBasis === search.legalBasis &&
        consent.datasetIds.includes(search.datasetId);
      const stillGranted = subject?.status === "active" && consents.some((consent) => covers(consent) && consentIsLive(consent, at));
      if (!stillGranted) {
        const lapsed = subject?.status === "active" && consents.some((consent) => covers(consent) && consent.status === "granted");
        const refusal: DenialCode = lapsed ? "CONSENT_EXPIRED" : "CONSENT_WITHDRAWN";
        const message = lapsed
          ? "Confirmation refused. The subject's consent expired before a person confirmed the match."
          : "Confirmation refused. The subject withdrew consent before a person confirmed the match.";
        const checkpoint = await this.deps.transaction(async (tx) => {
          const recorded = await tx.audit.record({
            actorId: input.actor.id,
            action: "review",
            recordedAt: this.deps.now().toISOString(),
            attestation: {
              outcome: "denied",
              matchRan: false,
              code: refusal,
              searchId: search.id,
              reviewId: review.id,
              subjectCid: input.selectedCid,
              message,
            },
          });
          return recorded.checkpoint;
        });
        await this.submit(checkpoint);
        throw new EideticError(refusal, message, 403, false);
      }
    }

    const now = this.deps.now().toISOString();
    const redacted = this.deps.redactor.redact(input.notes.trim());
    const auditNotes = redacted.length > 0 ? clipMessage(redacted) : "[redacted]";
    const selectedCid = input.decision === "confirm" ? input.selectedCid ?? null : null;
    const checkpoint = await this.deps.transaction(async (tx) => {
      await tx.reviews.save({
        ...review,
        status: "decided",
        decision: input.decision,
        selectedCid,
        notes: input.notes.trim(),
        reviewerId: input.actor.id,
        decidedAt: now,
      });
      await tx.searches.markDecided(search.id);
      const recorded = await tx.audit.record({
        actorId: input.actor.id,
        action: "review",
        recordedAt: now,
        attestation: {
          outcome: "recorded",
          matchRan: false,
          searchId: search.id,
          reviewId: review.id,
          decision: input.decision,
          subjectCid: selectedCid ?? undefined,
          notes: auditNotes,
          message: "Reviewer recorded a human decision. The match score was not treated as a final decision.",
        },
      });
      return recorded.checkpoint;
    });
    await this.submit(checkpoint);
    const head = (await this.deps.repos.audit.list()).at(-1);
    return {
      reviewId: review.id,
      searchId: search.id,
      finalDecision: input.decision,
      selectedCid,
      matchRan: false,
      message: "A reviewer recorded the decision. The similarity score was not the decision.",
      audit: { seq: checkpoint.throughSeq, hash: head?.hash ?? "", merkleRoot: checkpoint.merkleRoot },
    };
  }

  async listPurposes(): Promise<PurposeDefinition[]> {
    return this.deps.repos.purposes.list();
  }

  async listSubjects(): Promise<SubjectView[]> {
    const subjects = await this.deps.repos.subjects.list();
    return Promise.all(subjects.map((subject) => this.subjectView(subject.cid)));
  }

  async listReviews(status?: "pending" | "decided"): Promise<ReviewSummary[]> {
    const reviews = await this.deps.repos.reviews.list(status);
    const summaries: ReviewSummary[] = [];
    for (const review of reviews) {
      const detail = await this.reviewSummary(review.id);
      if (detail) summaries.push(detail);
    }
    return summaries.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  }

  async getReview(reviewId: string): Promise<ReviewDetail> {
    const summary = await this.reviewSummary(reviewId);
    if (!summary) throw new EideticError("NOT_FOUND", "That review is not on the desk.", 404, false);
    const review = await this.deps.repos.reviews.get(reviewId);
    const candidates = await this.candidateViews(summary.searchId);
    return { ...summary, notes: review?.notes ?? null, selectedCid: review?.selectedCid ?? null, candidates };
  }

  async listAudit() {
    return this.deps.repos.audit.list();
  }

  verifyAudit() {
    return this.deps.repos.audit.verify();
  }

  async runBias(actor: Actor, releaseId: string, cases: EvaluationCase[]): Promise<FairnessReport> {
    this.requireRole(actor, "admin", "Only an admin can record a bias evaluation.");
    const report = evaluateFairness({
      releaseId,
      model: `${this.deps.matcher.model.name}@${this.deps.matcher.model.version}`,
      cases,
    });
    const now = this.deps.now().toISOString();
    const checkpoint = await this.deps.transaction(async (tx) => {
      await tx.bias.save(releaseId, report, now);
      const recorded = await tx.audit.record({
        actorId: actor.id,
        action: "bias_evaluation",
        recordedAt: now,
        attestation: {
          outcome: "recorded",
          matchRan: false,
          releaseId,
          message: `Bias evaluation ${releaseId} recorded from supplied cohort labels. Demographics were not inferred from biometrics.`,
        },
      });
      return recorded.checkpoint;
    });
    await this.submit(checkpoint);
    return report;
  }

  async runFixtureBias(
    actor: Actor,
    releaseId: string,
    cases: Array<{ id: string; fixtureId: string; expectedCid: string | null; predictedCid: string | null; confidence: number }>,
  ): Promise<FairnessReport> {
    this.requireRole(actor, "admin", "Only an admin can record a bias evaluation.");
    const report = evaluateFixtureFairness({
      releaseId,
      model: `${this.deps.matcher.model.name}@${this.deps.matcher.model.version}`,
      cases,
    });
    const now = this.deps.now().toISOString();
    const checkpoint = await this.deps.transaction(async (tx) => {
      await tx.bias.save(releaseId, report, now);
      const recorded = await tx.audit.record({
        actorId: actor.id,
        action: "bias_evaluation",
        recordedAt: now,
        attestation: {
          outcome: "recorded",
          matchRan: false,
          releaseId,
          message: `Bias evaluation ${releaseId} used synthetic fixture cohort metadata. No face was classified.`,
        },
      });
      return recorded.checkpoint;
    });
    await this.submit(checkpoint);
    return report;
  }

  async getBias(releaseId: string): Promise<FairnessReport> {
    const report = await this.deps.repos.bias.get(releaseId);
    if (!report) throw new EideticError("NOT_FOUND", "No bias evaluation is stored for that release.", 404, false);
    return report;
  }

  private async reviewSummary(reviewId: string): Promise<ReviewSummary | null> {
    const review = await this.deps.repos.reviews.get(reviewId);
    if (!review) return null;
    const search = await this.deps.repos.searches.get(review.searchId);
    if (!search) return null;
    const candidates = await this.deps.repos.candidates.listForSearch(search.id);
    const top = candidates.find((candidate) => candidate.rank === 1) ?? null;
    const subject = top ? await this.deps.repos.subjects.get(top.cid) : null;
    const actor = await this.deps.repos.actors.get(search.actorId);
    return {
      reviewId: review.id,
      status: review.status,
      decision: review.decision,
      finalDecision: review.status === "decided" ? review.decision : null,
      searchId: search.id,
      purposeCode: search.purposeCode,
      datasetId: search.datasetId,
      legalBasis: search.legalBasis,
      edition: search.edition,
      createdAt: review.createdAt,
      topConfidence: top?.confidence ?? null,
      topCid: top?.cid ?? null,
      subjectName: subject?.displayName ?? null,
      searchedBy: { id: search.actorId, displayName: actor?.displayName ?? search.actorId },
    };
  }

  private async candidateViews(searchId: string): Promise<SearchResult["candidates"]> {
    const candidates = await this.deps.repos.candidates.listForSearch(searchId);
    const views: SearchResult["candidates"] = [];
    for (const candidate of candidates) {
      const subject = await this.deps.repos.subjects.get(candidate.cid);
      views.push({
        cid: candidate.cid,
        displayName: subject?.displayName ?? candidate.cid,
        confidence: candidate.confidence,
        rank: candidate.rank,
        evidence: candidate.evidence,
        consentStatus: "granted",
      });
    }
    return views;
  }

  private async subjectView(cid: string): Promise<SubjectView> {
    const subject = await this.deps.repos.subjects.get(cid);
    if (!subject) throw new EideticError("NOT_FOUND", "No enrolled subject uses that CID.", 404, false);
    const consents = await this.deps.repos.consents.listForSubject(cid);
    const template = await this.deps.repos.templates.activeForCid(cid);
    const at = this.deps.now().toISOString();
    return {
      cid: subject.cid,
      displayName: subject.displayName,
      status: subject.status,
      enrolledAt: subject.enrolledAt,
      withdrawnAt: subject.withdrawnAt,
      recordAttributes: subject.recordAttributes,
      consents: consents.map((consent) => ({
        purposeCode: consent.purposeCode,
        datasetIds: consent.datasetIds,
        legalBasis: consent.legalBasis,
        status: consent.status,
        expiresAt: consent.expiresAt,
        expired: consent.status === "granted" && !consentIsLive(consent, at),
        receiptHash: consent.receiptHash,
      })),
      template: { present: Boolean(template), quality: template?.quality ?? null },
    };
  }

  private async recordDenial(
    input: { actor: Actor; purposeCode: string; legalBasis: LegalBasis; datasetId: string; edition: Edition; subjectCid?: string },
    code: DenialCode,
    message: string,
  ): Promise<void> {
    const now = this.deps.now().toISOString();
    const searchId = this.deps.ids.id("sch");
    const attestation: AuditAttestation = {
      outcome: "denied",
      matchRan: false,
      code,
      legalBasis: input.legalBasis,
      edition: input.edition,
      searchId,
      message: clipMessage(message),
    };
    if (input.purposeCode) attestation.purposeCode = input.purposeCode;
    if (input.datasetId) attestation.datasetId = input.datasetId;
    if (input.subjectCid) attestation.subjectCid = input.subjectCid;
    const checkpoint = await this.deps.transaction(async (tx) => {
      await tx.searches.insert({
        id: searchId,
        actorId: input.actor.id,
        purposeCode: input.purposeCode || "unspecified",
        legalBasis: input.legalBasis,
        datasetId: input.datasetId || "unspecified",
        edition: input.edition,
        subjectCid: input.subjectCid ?? null,
        status: "denied",
        denialCode: code,
        modelName: null,
        modelVersion: null,
        createdAt: now,
      });
      const recorded = await tx.audit.record({
        actorId: input.actor.id,
        action: "search",
        recordedAt: now,
        attestation,
      });
      return recorded.checkpoint;
    });
    await this.submit(checkpoint);
  }

  private async consentGate(input: {
    purposeCode: string;
    legalBasis: LegalBasis;
    datasetId: string;
    subjectCid?: string;
  }): Promise<{ state: "granted" | "withdrawn" | "expired" | "missing" | "not_enrolled"; label?: string } | undefined> {
    if (!input.subjectCid) return undefined;
    const subject = await this.deps.repos.subjects.get(input.subjectCid);
    if (!subject) return { state: "not_enrolled" };
    if (subject.status === "withdrawn") return { state: "withdrawn", label: subject.displayName };
    const consents = await this.deps.repos.consents.listForSubject(subject.cid);
    const at = this.deps.now().toISOString();
    const matching = consents.filter(
      (consent) =>
        consent.status === "granted" &&
        consent.purposeCode === input.purposeCode &&
        consent.legalBasis === input.legalBasis &&
        consent.datasetIds.includes(input.datasetId),
    );
    if (matching.some((consent) => consentIsLive(consent, at))) return { state: "granted", label: subject.displayName };
    if (matching.length > 0) return { state: "expired", label: subject.displayName };
    const withdrawn = consents.some((consent) => consent.purposeCode === input.purposeCode && consent.status === "withdrawn");
    return withdrawn ? { state: "withdrawn", label: subject.displayName } : { state: "missing", label: subject.displayName };
  }

  private async requirePurpose(code: string): Promise<PurposeDefinition> {
    const purpose = await this.deps.repos.purposes.get(code);
    if (!purpose || !purpose.active) {
      throw new EideticError("PURPOSE_UNKNOWN", `Purpose ${code} is not an active enrolled purpose.`, 403, false);
    }
    return purpose;
  }

  private requireRole(actor: Actor, role: Role, message: string): void {
    if (actor.role !== role) throw new EideticError("FORBIDDEN", message, 403, false);
  }

  private async submit(checkpoint: MerkleCheckpoint): Promise<void> {
    await this.deps.trillian.submit({
      merkleRoot: checkpoint.merkleRoot,
      leafCount: checkpoint.leafCount,
      throughSeq: checkpoint.throughSeq,
    });
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80 || /[\u0000-\u001f]/.test(trimmed)) {
    throw new EideticError("VALIDATION", "Display name must be 1–80 visible characters.", 422, false);
  }
  return trimmed;
}

function sameSet(left: string[], right: string[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

export const defaultRedactor = new LocalPatternRedactor();
