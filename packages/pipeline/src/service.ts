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
import type { GeoRoutingAnnotation, PolicyDecider, PolicyDecision } from "@eidetic/policy";
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

export type CandidateConsent = "granted" | "withdrawn" | "expired";

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
    /** The candidate's consent for this search's purpose, legal basis and dataset, as of when it is read. */
    consentStatus: CandidateConsent;
  }>;
  audit: AuditReceipt;
  geoRouting?: GeoRoutingAnnotation;
}

export interface SubjectAccessReport {
  generatedAt: string;
  generatedBy: { id: string; role: Role };
  subject: SubjectView;
  /** Audit entries that name this subject or list them as a match candidate, oldest first. */
  activity: Array<{
    seq: number;
    recordedAt: string;
    action: string;
    actorId: string;
    involvement: "named" | "candidate";
    outcome: string;
    message: string;
    purposeCode?: string;
    datasetId?: string;
    decision?: string;
    hash: string;
  }>;
  /** The audit entry that records this export. */
  audit: { seq: number; hash: string };
  note: string;
}

/** Counts over a recent window, read from the audit log. No subject identifiers, only codes and totals. */
export interface UsageStats {
  since: string;
  hours: number;
  searches: { total: number; ran: number; refused: number };
  byPurpose: Array<{ purposeCode: string; ran: number; refused: number }>;
  refusalsByCode: Array<{ code: string; count: number }>;
  decisions: { confirm: number; reject: number; inconclusive: number; refused: number };
  pendingReviews: number;
}

export interface ConsentSweepResult {
  checkedAt: string;
  /** Subjects whose sealed template was purged because no consent grant is live any more. */
  purged: Array<{ cid: string; seq: number; hash: string }>;
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
  /**
   * Optional cyber-routing annotation. When omitted, search behaves as before.
   * The callback must not change allow or deny. Identity matching ignores it.
   */
  annotatePolicy?: (
    decision: PolicyDecision,
    routing: { ip?: string; domain?: string } | undefined,
  ) => PolicyDecision & { geoRouting?: GeoRoutingAnnotation };
  /** Most searches one actor may start in a rolling hour. Unset or 0 means no limit. */
  searchLimitPerHour?: number;
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

  /**
   * Withdraw consent for one purpose and keep the rest. Searches under that purpose stop finding the person at
   * once. If no granted consent is left, this is a full withdrawal: the sealed template is purged and the subject
   * is marked withdrawn, in the same transaction and the same audit entry.
   */
  async withdrawPurpose(actor: Actor, cid: string, purposeCode: string): Promise<SubjectView> {
    this.requireRole(actor, "admin", "Only an admin can record a consent withdrawal.");
    const subject = await this.deps.repos.subjects.get(cid);
    if (!subject) throw new EideticError("NOT_FOUND", "No enrolled subject uses that CID.", 404, false);
    if (subject.status !== "active") {
      throw new EideticError("CONSENT_WITHDRAWN", "This subject already withdrew all consent.", 409, false);
    }
    const consents = await this.deps.repos.consents.listForSubject(cid);
    if (!consents.some((consent) => consent.purposeCode === purposeCode && consent.status === "granted")) {
      throw new EideticError("NOT_FOUND", "This subject has no granted consent for that purpose.", 404, false);
    }
    const remaining = consents.filter((consent) => consent.purposeCode !== purposeCode && consent.status === "granted");
    const last = remaining.length === 0;
    const template = last ? await this.deps.repos.templates.activeForCid(cid) : null;
    if (template) await this.deps.matcher.purge(template.storeKey);
    const now = this.deps.now().toISOString();
    const checkpoint = await this.deps.transaction(async (tx) => {
      await tx.consents.withdrawPurpose(cid, purposeCode, now);
      if (last) {
        await tx.subjects.update({ ...subject, status: "withdrawn", withdrawnAt: subject.withdrawnAt ?? now });
        await tx.templates.markPurged(cid, now);
      }
      const recorded = await tx.audit.record({
        actorId: actor.id,
        action: "withdraw",
        recordedAt: now,
        attestation: {
          outcome: "recorded",
          matchRan: false,
          subjectCid: cid,
          purposeCode,
          ...(last ? { sealedStorePurged: true } : {}),
          message: last
            ? "Consent for the last purpose withdrawn. Sealed templates were purged. This attestation has no biometric payload."
            : "Consent withdrawn for one purpose. Other consents and the sealed template stay. This attestation has no biometric payload.",
        },
      });
      return recorded.checkpoint;
    });
    await this.submit(checkpoint);
    return this.subjectView(cid);
  }

  /**
   * Everything ei·det·ic™ holds about one person, for a subject access request: their consents and every
   * audit entry that names them or lists them as a match candidate. Templates are reported as present or
   * absent only. The export itself is written to the audit log.
   */
  async subjectAccess(actor: Actor, cid: string): Promise<SubjectAccessReport> {
    if (actor.role !== "admin" && actor.role !== "auditor") {
      throw new EideticError("FORBIDDEN", "Only an admin or an auditor can export a subject access report.", 403, false);
    }
    const subject = await this.subjectView(cid);
    const entries = await this.deps.repos.audit.list();
    const candidateSearches = new Map<string, boolean>();
    const wasCandidate = async (searchId: string | undefined): Promise<boolean> => {
      if (!searchId) return false;
      let hit = candidateSearches.get(searchId);
      if (hit === undefined) {
        hit = (await this.deps.repos.candidates.listForSearch(searchId)).some((candidate) => candidate.cid === cid);
        candidateSearches.set(searchId, hit);
      }
      return hit;
    };
    const activity: SubjectAccessReport["activity"] = [];
    for (const entry of entries) {
      const attestation = entry.attestation;
      let involvement: "named" | "candidate" | null = null;
      if (attestation.subjectCid === cid) involvement = "named";
      else if ((entry.action === "search" || entry.action === "review") && (await wasCandidate(attestation.searchId))) {
        involvement = "candidate";
      }
      if (!involvement) continue;
      activity.push({
        seq: entry.seq,
        recordedAt: entry.recordedAt,
        action: entry.action,
        actorId: entry.actorId,
        involvement,
        outcome: attestation.outcome,
        message: attestation.message,
        purposeCode: attestation.purposeCode,
        datasetId: attestation.datasetId,
        decision: attestation.decision,
        hash: entry.hash,
      });
    }
    const now = this.deps.now().toISOString();
    const checkpoint = await this.deps.transaction(async (tx) => {
      const recorded = await tx.audit.record({
        actorId: actor.id,
        action: "subject_access",
        recordedAt: now,
        attestation: {
          outcome: "recorded",
          matchRan: false,
          subjectCid: cid,
          message: "Subject access report exported. It lists consents and audit activity. No template or image left the sealed store.",
        },
      });
      return recorded.checkpoint;
    });
    await this.submit(checkpoint);
    const head = (await this.deps.repos.audit.list()).at(-1);
    return {
      generatedAt: now,
      generatedBy: { id: actor.id, role: actor.role },
      subject,
      activity,
      audit: { seq: head?.seq ?? 0, hash: head?.hash ?? "" },
      note: "Biometric templates are reported as present or absent. Their bytes are never exported.",
    };
  }

  /**
   * Purge the sealed template of every active subject whose consent grants have all lapsed or been withdrawn.
   * The subject record and consent history stay, so the person can re-enroll. Each purge is audited.
   */
  async sweepLapsedConsent(actor: Actor): Promise<ConsentSweepResult> {
    this.requireRole(actor, "admin", "Only an admin can purge templates for lapsed consent.");
    const at = this.deps.now().toISOString();
    const purged: ConsentSweepResult["purged"] = [];
    for (const subject of await this.deps.repos.subjects.list()) {
      if (subject.status !== "active") continue;
      const template = await this.deps.repos.templates.activeForCid(subject.cid);
      if (!template) continue;
      const consents = await this.deps.repos.consents.listForSubject(subject.cid);
      if (consents.some((consent) => consentIsLive(consent, at))) continue;
      await this.deps.matcher.purge(template.storeKey);
      const recorded = await this.deps.transaction(async (tx) => {
        await tx.templates.markPurged(subject.cid, at);
        return tx.audit.record({
          actorId: actor.id,
          action: "consent_lapsed",
          recordedAt: at,
          attestation: {
            outcome: "recorded",
            matchRan: false,
            subjectCid: subject.cid,
            sealedStorePurged: true,
            message: "Every consent grant for this subject has lapsed. The sealed template was purged. Re-enrollment needs fresh consent.",
          },
        });
      });
      await this.submit(recorded.checkpoint);
      purged.push({ cid: subject.cid, seq: recorded.entry.seq, hash: recorded.entry.hash });
    }
    return { checkedAt: at, purged };
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
    routing?: { ip?: string; domain?: string };
  }): Promise<SearchResult> {
    const hints = assertRecordAttributes(input.recordHints);
    await this.enforceSearchLimit(input);
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
    const annotated = this.deps.annotatePolicy?.(decision, input.routing) ?? decision;
    const note = (annotated as PolicyDecision & { geoRouting?: GeoRoutingAnnotation }).geoRouting;
    const geoRouting = annotated.allow === decision.allow && note?.usedForIdentityMatch === false ? note : undefined;
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
      ...(geoRouting ? { geoRouting } : {}),
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
    // A purpose retired after the search no longer authorizes naming anyone. Reject and inconclusive stay open,
    // so the review can still be closed.
    if (input.decision === "confirm") {
      const purpose = await this.deps.repos.purposes.get(search.purposeCode);
      if (!purpose?.active) {
        const message = "Confirmation refused. The purpose behind this search was retired before a person confirmed the match.";
        const checkpoint = await this.deps.transaction(async (tx) => {
          const recorded = await tx.audit.record({
            actorId: input.actor.id,
            action: "review",
            recordedAt: this.deps.now().toISOString(),
            attestation: {
              outcome: "denied",
              matchRan: false,
              code: "PURPOSE_INACTIVE",
              searchId: search.id,
              reviewId: review.id,
              purposeCode: search.purposeCode,
              message,
            },
          });
          return recorded.checkpoint;
        });
        await this.submit(checkpoint);
        throw new EideticError("PURPOSE_INACTIVE", message, 403, false);
      }
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

  /**
   * The whole log as a signed, verifiable export (the same document `pnpm audit:export` writes). Taking the
   * export is recorded, and the returned file includes that entry, so it shows who pulled it. Biometric fields are
   * refused on the way out, and a refused export records nothing.
   */
  async exportAudit(actor: Actor) {
    if (actor.role !== "admin" && actor.role !== "auditor") {
      throw new EideticError("FORBIDDEN", "Only an admin or an auditor can export the audit log.", 403, false);
    }
    // Build the export once before recording anything: if the guard refuses it, the log must not claim an export.
    await this.deps.repos.audit.export();
    const now = this.deps.now().toISOString();
    const checkpoint = await this.deps.transaction(async (tx) => {
      const recorded = await tx.audit.record({
        actorId: actor.id,
        action: "audit_export",
        recordedAt: now,
        attestation: {
          outcome: "recorded",
          matchRan: false,
          message: "Audit log exported as a signed document. This attestation has no biometric payload.",
        },
      });
      return recorded.checkpoint;
    });
    await this.submit(checkpoint);
    return this.deps.repos.audit.export();
  }

  /**
   * How the desk was used over the last `hours`: searches that ran or were refused (by purpose and by refusal
   * code), review decisions, and the open review queue. Read from the audit log, so it counts what was recorded.
   */
  async usageStats(actor: Actor, hours = 24): Promise<UsageStats> {
    if (actor.role !== "admin" && actor.role !== "auditor") {
      throw new EideticError("FORBIDDEN", "Usage figures are for admins and auditors.", 403, false);
    }
    const window = Math.min(Math.max(Math.trunc(hours), 1), 24 * 90);
    const since = new Date(this.deps.now().getTime() - window * 60 * 60 * 1000).toISOString();
    const entries = (await this.deps.repos.audit.list()).filter((entry) => entry.recordedAt >= since);
    const purposes = new Map<string, { ran: number; refused: number }>();
    const codes = new Map<string, number>();
    const searches = { total: 0, ran: 0, refused: 0 };
    const decisions = { confirm: 0, reject: 0, inconclusive: 0, refused: 0 };
    for (const entry of entries) {
      const attestation = entry.attestation;
      if (entry.action === "search") {
        searches.total += 1;
        const ran = attestation.outcome === "allowed";
        if (ran) searches.ran += 1;
        else searches.refused += 1;
        const key = attestation.purposeCode ?? "(none)";
        const row = purposes.get(key) ?? { ran: 0, refused: 0 };
        if (ran) row.ran += 1;
        else row.refused += 1;
        purposes.set(key, row);
        if (!ran && attestation.code) codes.set(attestation.code, (codes.get(attestation.code) ?? 0) + 1);
      } else if (entry.action === "review") {
        if (attestation.outcome === "denied") decisions.refused += 1;
        else if (attestation.decision === "confirm" || attestation.decision === "reject" || attestation.decision === "inconclusive") {
          decisions[attestation.decision] += 1;
        }
      }
    }
    return {
      since,
      hours: window,
      searches,
      byPurpose: [...purposes.entries()]
        .map(([purposeCode, row]) => ({ purposeCode, ...row }))
        .sort((a, b) => b.ran + b.refused - (a.ran + a.refused) || a.purposeCode.localeCompare(b.purposeCode)),
      refusalsByCode: [...codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      decisions,
      pendingReviews: (await this.listReviews("pending")).length,
    };
  }

  async listAudit() {
    return this.deps.repos.audit.list();
  }

  /** The log a page at a time, newest first, so a long log never ships whole to a desk. */
  async pageAudit(query: { limit?: number; beforeSeq?: number; action?: string }) {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 500);
    return this.deps.repos.audit.page({ limit, beforeSeq: query.beforeSeq, action: query.action });
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
    const search = await this.deps.repos.searches.get(searchId);
    const at = this.deps.now().toISOString();
    const views: SearchResult["candidates"] = [];
    for (const candidate of candidates) {
      const subject = await this.deps.repos.subjects.get(candidate.cid);
      views.push({
        cid: candidate.cid,
        displayName: subject?.displayName ?? candidate.cid,
        confidence: candidate.confidence,
        rank: candidate.rank,
        evidence: candidate.evidence,
        consentStatus: search ? await this.candidateConsent(candidate.cid, search, at) : "withdrawn",
      });
    }
    return views;
  }

  /** Live consent for one candidate against the search it came from. Anything other than "granted" blocks confirmation. */
  private async candidateConsent(
    cid: string,
    search: { purposeCode: string; legalBasis: LegalBasis; datasetId: string },
    at: string,
  ): Promise<CandidateConsent> {
    const subject = await this.deps.repos.subjects.get(cid);
    if (!subject || subject.status !== "active") return "withdrawn";
    const grants = (await this.deps.repos.consents.listForSubject(cid)).filter(
      (consent) =>
        consent.status === "granted" &&
        consent.purposeCode === search.purposeCode &&
        consent.legalBasis === search.legalBasis &&
        consent.datasetIds.includes(search.datasetId),
    );
    if (grants.some((consent) => consentIsLive(consent, at))) return "granted";
    return grants.length > 0 ? "expired" : "withdrawn";
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

  /**
   * A per-actor ceiling on searches in a rolling hour, so one account cannot sweep the gallery.
   * Counted from the searches table, so it holds across restarts and API instances.
   * Only the first refusal in a window is audited, so a flood of refused calls cannot flood the log.
   */
  /**
   * How many searches this account has left in the rolling hour. `limit` is null when no limit is set.
   * Refused attempts count too, the same way the limit counts them.
   */
  async searchAllowance(actor: Actor): Promise<{ limit: number | null; used: number; remaining: number | null; windowMinutes: number }> {
    const limit = this.deps.searchLimitPerHour ?? 0;
    const since = new Date(this.deps.now().getTime() - 60 * 60 * 1000).toISOString();
    const recent = await this.deps.repos.searches.countSince(actor.id, since);
    if (limit <= 0) return { limit: null, used: recent.counted, remaining: null, windowMinutes: 60 };
    return { limit, used: recent.counted, remaining: Math.max(0, limit - recent.counted), windowMinutes: 60 };
  }

  private async enforceSearchLimit(input: {
    actor: Actor;
    purposeCode: string;
    legalBasis: LegalBasis;
    datasetId: string;
    edition: Edition;
    subjectCid?: string;
  }): Promise<void> {
    const limit = this.deps.searchLimitPerHour ?? 0;
    if (limit <= 0) return;
    const since = new Date(this.deps.now().getTime() - 60 * 60 * 1000).toISOString();
    const recent = await this.deps.repos.searches.countSince(input.actor.id, since);
    if (recent.counted < limit) return;
    const message = `Search refused. This account reached ${limit} searches in the last hour. The match did not run. Try again later.`;
    if (recent.rateLimited === 0) await this.recordDenial(input, "RATE_LIMITED", message);
    throw new EideticError("RATE_LIMITED", message, 429, false);
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
