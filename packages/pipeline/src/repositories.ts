// © Infinitum Corporation®. All rights reserved.

import type { AuditLog } from "@eidetic/audit";
import type { FairnessReport } from "@eidetic/bias";
import type {
  Actor,
  ConsentGrant,
  LegalBasis,
  PurposeDefinition,
  ReviewRecord,
  SearchRecord,
  StoredCandidate,
  SubjectRecord,
  TemplatePointer,
} from "@eidetic/contracts";

export interface ActorRepository {
  findByTokenHash(tokenHash: string): Promise<Actor | null>;
  get(id: string): Promise<Actor | null>;
  insert(actor: Actor & { tokenHash: string }): Promise<void>;
}

export interface PurposeRepository {
  get(code: string): Promise<PurposeDefinition | null>;
  list(): Promise<PurposeDefinition[]>;
  upsert(purpose: PurposeDefinition): Promise<void>;
}

export interface SubjectRepository {
  get(cid: string): Promise<SubjectRecord | null>;
  list(): Promise<SubjectRecord[]>;
  insert(subject: SubjectRecord): Promise<void>;
  update(subject: SubjectRecord): Promise<void>;
}

export interface ConsentRepository {
  insert(consent: ConsentGrant): Promise<void>;
  listForSubject(cid: string): Promise<ConsentGrant[]>;
  withdrawAll(cid: string, at: string): Promise<void>;
  listEligible(purposeCode: string, datasetId: string, legalBasis: LegalBasis): Promise<SubjectRecord[]>;
}

export interface TemplateRepository {
  insert(pointer: TemplatePointer): Promise<void>;
  activeForCid(cid: string): Promise<TemplatePointer | null>;
  activeForCids(cids: string[]): Promise<TemplatePointer[]>;
  markPurged(cid: string, at: string): Promise<void>;
}

export interface SearchRepository {
  insert(search: SearchRecord): Promise<void>;
  get(id: string): Promise<SearchRecord | null>;
  markDecided(id: string): Promise<void>;
  /** Searches this actor started at or after `since`: those that counted, and those refused for the rate limit. */
  countSince(actorId: string, since: string): Promise<{ counted: number; rateLimited: number }>;
}

export interface CandidateRepository {
  insertMany(candidates: StoredCandidate[]): Promise<void>;
  listForSearch(searchId: string): Promise<StoredCandidate[]>;
}

export interface ReviewRepository {
  insert(review: ReviewRecord): Promise<void>;
  get(id: string): Promise<ReviewRecord | null>;
  list(status?: "pending" | "decided"): Promise<ReviewRecord[]>;
  save(review: ReviewRecord): Promise<void>;
}

export interface BiasRepository {
  save(releaseId: string, report: FairnessReport, at: string): Promise<void>;
  get(releaseId: string): Promise<FairnessReport | null>;
}

export interface Repositories {
  actors: ActorRepository;
  purposes: PurposeRepository;
  subjects: SubjectRepository;
  consents: ConsentRepository;
  templates: TemplateRepository;
  searches: SearchRepository;
  candidates: CandidateRepository;
  reviews: ReviewRepository;
  bias: BiasRepository;
  audit: AuditLog;
}
