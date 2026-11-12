// © Infinitum Corporation®. All rights reserved.

import { AuditLog, type AuditEntry, type AuditRepository, type MerkleCheckpoint } from "@eidetic/audit";
import type { FairnessReport } from "@eidetic/bias";
import { consentIsLive } from "@eidetic/contracts";
import type {
  Actor,
  ConsentGrant,
  PurposeDefinition,
  ReviewRecord,
  SearchRecord,
  StoredCandidate,
  SubjectRecord,
  TemplatePointer,
} from "@eidetic/contracts";
import type { Repositories } from "./repositories.js";

export class MemoryDatabase {
  readonly actors: Array<Actor & { tokenHash: string }> = [];
  readonly purposes: PurposeDefinition[] = [];
  readonly subjects: SubjectRecord[] = [];
  readonly consents: ConsentGrant[] = [];
  readonly templates: TemplatePointer[] = [];
  readonly searches: SearchRecord[] = [];
  readonly candidates: StoredCandidate[] = [];
  readonly reviews: ReviewRecord[] = [];
  readonly bias: Array<{ releaseId: string; report: FairnessReport; createdAt: string }> = [];
  readonly auditEntries: AuditEntry[] = [];
  readonly checkpoints: MerkleCheckpoint[] = [];
  readonly repos: Repositories;

  constructor() {
    this.repos = {
      actors: {
        findByTokenHash: async (tokenHash) => {
          const actor = this.actors.find((item) => item.tokenHash === tokenHash);
          return actor ? publicActor(actor) : null;
        },
        get: async (id) => {
          const actor = this.actors.find((item) => item.id === id);
          return actor ? publicActor(actor) : null;
        },
        insert: async (actor) => {
          this.actors.push(actor);
        },
      },
      purposes: {
        get: async (code) => this.purposes.find((item) => item.code === code) ?? null,
        list: async () => this.purposes.map((item) => structuredClone(item)),
        upsert: async (purpose) => {
          const index = this.purposes.findIndex((item) => item.code === purpose.code);
          if (index === -1) this.purposes.push(purpose);
          else this.purposes[index] = purpose;
        },
      },
      subjects: {
        get: async (cid) => this.subjects.find((item) => item.cid === cid) ?? null,
        list: async () => this.subjects.map((item) => structuredClone(item)),
        insert: async (subject) => {
          this.subjects.push(subject);
        },
        update: async (subject) => {
          const index = this.subjects.findIndex((item) => item.cid === subject.cid);
          if (index === -1) throw new Error("subject missing");
          this.subjects[index] = subject;
        },
      },
      consents: {
        insert: async (consent) => {
          this.consents.push(consent);
        },
        listForSubject: async (cid) => this.consents.filter((item) => item.cid === cid).map((item) => structuredClone(item)),
        withdrawAll: async (cid, at) => {
          for (const consent of this.consents) {
            if (consent.cid === cid && consent.status === "granted") {
              consent.status = "withdrawn";
              consent.withdrawnAt = at;
            }
          }
        },
        listEligible: async (purposeCode, datasetId, legalBasis, at) => {
          const seen = new Map<string, SubjectRecord>();
          for (const consent of this.consents) {
            if (!consentIsLive(consent, at) || consent.purposeCode !== purposeCode || consent.legalBasis !== legalBasis) continue;
            if (!consent.datasetIds.includes(datasetId)) continue;
            const subject = this.subjects.find((item) => item.cid === consent.cid && item.status === "active");
            if (subject) seen.set(subject.cid, structuredClone(subject));
          }
          return [...seen.values()];
        },
      },
      templates: {
        insert: async (pointer) => {
          this.templates.push(pointer);
        },
        activeForCid: async (cid) => latestActive(this.templates, [cid])[0] ?? null,
        activeForCids: async (cids) => latestActive(this.templates, cids),
        markPurged: async (cid, at) => {
          for (const pointer of this.templates) {
            if (pointer.cid === cid && pointer.purgedAt === null) pointer.purgedAt = at;
          }
        },
      },
      searches: {
        insert: async (search) => {
          this.searches.push(search);
        },
        get: async (id) => this.searches.find((item) => item.id === id) ?? null,
        markDecided: async (id) => {
          const search = this.searches.find((item) => item.id === id);
          if (!search) throw new Error("search missing");
          search.status = "decided";
        },
        countSince: async (actorId, since) => {
          const mine = this.searches.filter((item) => item.actorId === actorId && item.createdAt >= since);
          const rateLimited = mine.filter((item) => item.denialCode === "RATE_LIMITED").length;
          return { counted: mine.length - rateLimited, rateLimited };
        },
      },
      candidates: {
        insertMany: async (candidates) => {
          this.candidates.push(...candidates);
        },
        listForSearch: async (searchId) =>
          this.candidates
            .filter((item) => item.searchId === searchId)
            .sort((left, right) => left.rank - right.rank)
            .map((item) => structuredClone(item)),
      },
      reviews: {
        insert: async (review) => {
          this.reviews.push(review);
        },
        get: async (id) => this.reviews.find((item) => item.id === id) ?? null,
        list: async (status) => this.reviews.filter((item) => !status || item.status === status).map((item) => structuredClone(item)),
        save: async (review) => {
          const index = this.reviews.findIndex((item) => item.id === review.id);
          if (index === -1) throw new Error("review missing");
          this.reviews[index] = review;
        },
      },
      bias: {
        save: async (releaseId, report, at) => {
          const index = this.bias.findIndex((item) => item.releaseId === releaseId);
          const row = { releaseId, report, createdAt: at };
          if (index === -1) this.bias.push(row);
          else this.bias[index] = row;
        },
        get: async (releaseId) => this.bias.find((item) => item.releaseId === releaseId)?.report ?? null,
      },
      audit: new AuditLog(new MemoryAuditRepository(this)),
    };
  }

  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return fn(this.repos);
  }
}

function publicActor(actor: Actor & { tokenHash: string }): Actor {
  return { id: actor.id, displayName: actor.displayName, role: actor.role };
}

function latestActive(templates: TemplatePointer[], cids: string[]): TemplatePointer[] {
  const wanted = new Set(cids);
  const best = new Map<string, TemplatePointer>();
  for (const pointer of templates) {
    if (!wanted.has(pointer.cid) || pointer.purgedAt) continue;
    const current = best.get(pointer.cid);
    if (!current || current.createdAt < pointer.createdAt) best.set(pointer.cid, pointer);
  }
  return [...best.values()].map((item) => structuredClone(item));
}

class MemoryAuditRepository implements AuditRepository {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: MemoryDatabase) {}

  append(build: Parameters<AuditRepository["append"]>[0]) {
    const run = this.chain.then(async () => {
      const last = this.db.auditEntries.at(-1) ?? null;
      const built = await build({
        last,
        nextSeq: (last?.seq ?? 0) + 1,
        hashes: this.db.auditEntries.map((entry) => entry.hash),
      });
      this.db.auditEntries.push(built.entry);
      this.db.checkpoints.push(built.checkpoint);
      return built;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  list(): Promise<AuditEntry[]> {
    return Promise.resolve(structuredClone(this.db.auditEntries));
  }

  checkpoints(): Promise<MerkleCheckpoint[]> {
    return Promise.resolve(structuredClone(this.db.checkpoints));
  }

  sealBlank(throughSeq: number, signature: string): Promise<void> {
    const checkpoint = this.db.checkpoints.find((item) => item.throughSeq === throughSeq);
    if (checkpoint && !checkpoint.signature.startsWith("ed25519:")) checkpoint.signature = signature;
    return Promise.resolve();
  }
}
