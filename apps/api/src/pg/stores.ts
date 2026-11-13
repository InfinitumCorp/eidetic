// © Infinitum Corporation®. All rights reserved.

import type { Pool, PoolClient } from "pg";
import { AuditLog, type AuditEntry, type AuditRepository, type CheckpointSigner, type MerkleCheckpoint } from "@eidetic/audit";
import type { FairnessReport } from "@eidetic/bias";
import type {
  Actor,
  ConsentGrant,
  EvidenceItem,
  LegalBasis,
  PurposeDefinition,
  ReviewRecord,
  Role,
  SearchRecord,
  StoredCandidate,
  SubjectRecord,
  TemplatePointer,
} from "@eidetic/contracts";
import type { Repositories } from "@eidetic/pipeline";
import { asSql, type Sql } from "./pool.js";

export function createRepositories(sql: Sql, signer: CheckpointSigner): Repositories {
  const audit: AuditRepository = {
    async append(build) {
      await sql.query("SELECT id FROM audit_lock WHERE id = 1 FOR UPDATE");
      const listed = await sql.query("SELECT * FROM audit_entries ORDER BY seq ASC");
      const entries = listed.rows.map(mapAudit);
      const last = entries.at(-1) ?? null;
      const built = await build({
        last,
        nextSeq: (last?.seq ?? 0) + 1,
        hashes: entries.map((entry) => entry.hash),
      });
      await sql.query(
        `INSERT INTO audit_entries (seq, recorded_at, actor_id, action, attestation, payload_hash, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          built.entry.seq,
          built.entry.recordedAt,
          built.entry.actorId,
          built.entry.action,
          JSON.stringify(built.entry.attestation),
          built.entry.payloadHash,
          built.entry.prevHash,
          built.entry.hash,
        ],
      );
      await sql.query(
        `INSERT INTO audit_checkpoints (through_seq, leaf_count, merkle_root, computed_at, signature)
         VALUES ($1, $2, $3, $4, $5)`,
        [built.checkpoint.throughSeq, built.checkpoint.leafCount, built.checkpoint.merkleRoot, built.checkpoint.computedAt, built.checkpoint.signature],
      );
      return built;
    },
    async list() {
      const result = await sql.query("SELECT * FROM audit_entries ORDER BY seq ASC");
      return result.rows.map(mapAudit);
    },
    async page(query) {
      // One row past the limit tells us whether an older page exists.
      const result = await sql.query(
        `SELECT * FROM audit_entries
         WHERE ($1::bigint IS NULL OR seq < $1) AND ($2::text IS NULL OR action = $2)
         ORDER BY seq DESC LIMIT $3`,
        [query.beforeSeq ?? null, query.action ?? null, query.limit + 1],
      );
      const rows = result.rows.map(mapAudit);
      const entries = rows.slice(0, query.limit);
      return { entries, nextBefore: rows.length > query.limit ? (entries.at(-1)?.seq ?? null) : null };
    },
    async checkpoints() {
      const result = await sql.query("SELECT * FROM audit_checkpoints ORDER BY through_seq ASC");
      return result.rows.map(mapCheckpoint);
    },
    async sealBlank(throughSeq, signature) {
      await sql.query("UPDATE audit_checkpoints SET signature = $2 WHERE through_seq = $1 AND signature NOT LIKE 'ed25519:%'", [throughSeq, signature]);
    },
  };

  return {
    actors: {
      async findByTokenHash(tokenHash) {
        const result = await sql.query("SELECT id, display_name, role FROM actors WHERE token_hash = $1", [tokenHash]);
        return result.rows[0] ? mapActor(result.rows[0]) : null;
      },
      async get(id) {
        const result = await sql.query("SELECT id, display_name, role FROM actors WHERE id = $1", [id]);
        return result.rows[0] ? mapActor(result.rows[0]) : null;
      },
      async insert(actor) {
        await sql.query(
          "INSERT INTO actors (id, display_name, role, token_hash) VALUES ($1, $2, $3, $4)",
          [actor.id, actor.displayName, actor.role, actor.tokenHash],
        );
      },
    },
    purposes: {
      async get(code) {
        const result = await sql.query("SELECT * FROM purposes WHERE code = $1", [code]);
        return result.rows[0] ? mapPurpose(result.rows[0]) : null;
      },
      async list() {
        const result = await sql.query("SELECT * FROM purposes ORDER BY code ASC");
        return result.rows.map(mapPurpose);
      },
      async upsert(purpose) {
        await sql.query(
          `INSERT INTO purposes (code, title, description, edition, legal_bases, dataset_ids, allowed_roles, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (code) DO UPDATE SET
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             edition = EXCLUDED.edition,
             legal_bases = EXCLUDED.legal_bases,
             dataset_ids = EXCLUDED.dataset_ids,
             allowed_roles = EXCLUDED.allowed_roles,
             active = EXCLUDED.active`,
          [
            purpose.code,
            purpose.title,
            purpose.description,
            purpose.edition,
            purpose.legalBases,
            purpose.datasetIds,
            purpose.allowedRoles,
            purpose.active,
          ],
        );
      },
    },
    subjects: {
      async get(cid) {
        const result = await sql.query("SELECT * FROM subjects WHERE cid = $1", [cid]);
        return result.rows[0] ? mapSubject(result.rows[0]) : null;
      },
      async list() {
        const result = await sql.query("SELECT * FROM subjects ORDER BY enrolled_at ASC");
        return result.rows.map(mapSubject);
      },
      async insert(subject) {
        await sql.query(
          `INSERT INTO subjects (cid, display_name, status, record_attributes, enrolled_at, withdrawn_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [subject.cid, subject.displayName, subject.status, JSON.stringify(subject.recordAttributes), subject.enrolledAt, subject.withdrawnAt],
        );
      },
      async update(subject) {
        await sql.query(
          `UPDATE subjects
           SET display_name = $2, status = $3, record_attributes = $4::jsonb, enrolled_at = $5, withdrawn_at = $6
           WHERE cid = $1`,
          [subject.cid, subject.displayName, subject.status, JSON.stringify(subject.recordAttributes), subject.enrolledAt, subject.withdrawnAt],
        );
      },
    },
    consents: {
      async insert(consent) {
        await sql.query(
          `INSERT INTO consents (id, cid, purpose_code, dataset_ids, legal_basis, status, granted_at, withdrawn_at, receipt_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            consent.id,
            consent.cid,
            consent.purposeCode,
            consent.datasetIds,
            consent.legalBasis,
            consent.status,
            consent.grantedAt,
            consent.withdrawnAt,
            consent.receiptHash,
            consent.expiresAt,
          ],
        );
      },
      async listForSubject(cid) {
        const result = await sql.query("SELECT * FROM consents WHERE cid = $1 ORDER BY granted_at ASC", [cid]);
        return result.rows.map(mapConsent);
      },
      async withdrawAll(cid, at) {
        await sql.query(
          "UPDATE consents SET status = 'withdrawn', withdrawn_at = $2 WHERE cid = $1 AND status = 'granted'",
          [cid, at],
        );
      },
      async withdrawPurpose(cid, purposeCode, at) {
        const result = await sql.query(
          "UPDATE consents SET status = 'withdrawn', withdrawn_at = $3 WHERE cid = $1 AND purpose_code = $2 AND status = 'granted'",
          [cid, purposeCode, at],
        );
        return result.rowCount ?? 0;
      },
      async listEligible(purposeCode, datasetId, legalBasis, at) {
        const result = await sql.query(
          `SELECT DISTINCT ON (s.cid) s.*
           FROM subjects s
           JOIN consents c ON c.cid = s.cid
           WHERE s.status = 'active'
             AND c.status = 'granted'
             AND c.purpose_code = $1
             AND c.legal_basis = $2
             AND $3 = ANY (c.dataset_ids)
             AND (c.expires_at IS NULL OR c.expires_at > $4)
           ORDER BY s.cid`,
          [purposeCode, legalBasis, datasetId, at],
        );
        return result.rows.map(mapSubject);
      },
    },
    templates: {
      async insert(pointer) {
        await sql.query(
          `INSERT INTO template_pointers (id, cid, store_key, quality, model_name, model_version, created_at, purged_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [pointer.id, pointer.cid, pointer.storeKey, pointer.quality, pointer.modelName, pointer.modelVersion, pointer.createdAt, pointer.purgedAt],
        );
      },
      async activeForCid(cid) {
        const rows = await this.activeForCids([cid]);
        return rows[0] ?? null;
      },
      async activeForCids(cids) {
        if (cids.length === 0) return [];
        const result = await sql.query(
          `SELECT DISTINCT ON (cid) *
           FROM template_pointers
           WHERE cid = ANY ($1::text[]) AND purged_at IS NULL
           ORDER BY cid, created_at DESC`,
          [cids],
        );
        return result.rows.map(mapTemplate);
      },
      async markPurged(cid, at) {
        await sql.query("UPDATE template_pointers SET purged_at = $2 WHERE cid = $1 AND purged_at IS NULL", [cid, at]);
      },
    },
    searches: {
      async insert(search) {
        await sql.query(
          `INSERT INTO searches (
             id, actor_id, purpose_code, legal_basis, dataset_id, edition, subject_cid, status, denial_code, model_name, model_version, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            search.id,
            search.actorId,
            search.purposeCode,
            search.legalBasis,
            search.datasetId,
            search.edition,
            search.subjectCid,
            search.status,
            search.denialCode,
            search.modelName,
            search.modelVersion,
            search.createdAt,
          ],
        );
      },
      async get(id) {
        const result = await sql.query("SELECT * FROM searches WHERE id = $1", [id]);
        return result.rows[0] ? mapSearch(result.rows[0]) : null;
      },
      async markDecided(id) {
        await sql.query("UPDATE searches SET status = 'decided' WHERE id = $1", [id]);
      },
      async countSince(actorId, since) {
        const result = await sql.query(
          `SELECT count(*) FILTER (WHERE denial_code IS DISTINCT FROM 'RATE_LIMITED')::int AS counted,
                  count(*) FILTER (WHERE denial_code = 'RATE_LIMITED')::int AS rate_limited
           FROM searches WHERE actor_id = $1 AND created_at >= $2`,
          [actorId, since],
        );
        const row = result.rows[0] ?? {};
        return { counted: Number(row.counted ?? 0), rateLimited: Number(row.rate_limited ?? 0) };
      },
    },
    candidates: {
      async insertMany(candidates) {
        for (const candidate of candidates) {
          await sql.query(
            `INSERT INTO match_candidates (id, search_id, cid, confidence, rank, evidence, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [candidate.id, candidate.searchId, candidate.cid, candidate.confidence, candidate.rank, JSON.stringify(candidate.evidence), candidate.createdAt],
          );
        }
      },
      async listForSearch(searchId) {
        const result = await sql.query("SELECT * FROM match_candidates WHERE search_id = $1 ORDER BY rank ASC", [searchId]);
        return result.rows.map(mapCandidate);
      },
    },
    reviews: {
      async insert(review) {
        await sql.query(
          `INSERT INTO reviews (id, search_id, status, decision, selected_cid, notes, reviewer_id, decided_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [review.id, review.searchId, review.status, review.decision, review.selectedCid, review.notes, review.reviewerId, review.decidedAt, review.createdAt],
        );
      },
      async get(id) {
        const result = await sql.query("SELECT * FROM reviews WHERE id = $1", [id]);
        return result.rows[0] ? mapReview(result.rows[0]) : null;
      },
      async list(status) {
        const result = status
          ? await sql.query("SELECT * FROM reviews WHERE status = $1 ORDER BY created_at DESC", [status])
          : await sql.query("SELECT * FROM reviews ORDER BY created_at DESC");
        return result.rows.map(mapReview);
      },
      async save(review) {
        await sql.query(
          `UPDATE reviews
           SET status = $2, decision = $3, selected_cid = $4, notes = $5, reviewer_id = $6, decided_at = $7
           WHERE id = $1`,
          [review.id, review.status, review.decision, review.selectedCid, review.notes, review.reviewerId, review.decidedAt],
        );
      },
    },
    bias: {
      async save(releaseId, report, at) {
        await sql.query(
          `INSERT INTO bias_reports (release_id, report, created_at)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (release_id) DO UPDATE SET report = EXCLUDED.report, created_at = EXCLUDED.created_at`,
          [releaseId, JSON.stringify(report), at],
        );
      },
      async get(releaseId) {
        const result = await sql.query("SELECT report FROM bias_reports WHERE release_id = $1", [releaseId]);
        return result.rows[0] ? (jsonValue(result.rows[0].report) as FairnessReport) : null;
      },
    },
    audit: new AuditLog(audit, signer),
  };
}

export async function withTransaction<T>(pool: Pool, fn: (repos: Repositories) => Promise<T>, signer: CheckpointSigner): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(createRepositories(asSql(client), signer));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function mapActor(row: Record<string, unknown>): Actor {
  return { id: text(row, "id"), displayName: text(row, "display_name"), role: text(row, "role") as Role };
}

function mapPurpose(row: Record<string, unknown>): PurposeDefinition {
  return {
    code: text(row, "code"),
    title: text(row, "title"),
    description: text(row, "description"),
    edition: text(row, "edition") as PurposeDefinition["edition"],
    legalBases: textArray(row.legal_bases) as PurposeDefinition["legalBases"],
    datasetIds: textArray(row.dataset_ids),
    allowedRoles: textArray(row.allowed_roles) as PurposeDefinition["allowedRoles"],
    active: row.active === true,
  };
}

function mapSubject(row: Record<string, unknown>): SubjectRecord {
  return {
    cid: text(row, "cid"),
    displayName: text(row, "display_name"),
    status: text(row, "status") as SubjectRecord["status"],
    recordAttributes: jsonObject(row.record_attributes),
    enrolledAt: timestamp(row, "enrolled_at"),
    withdrawnAt: timestampOrNull(row, "withdrawn_at"),
  };
}

function mapConsent(row: Record<string, unknown>): ConsentGrant {
  return {
    id: text(row, "id"),
    cid: text(row, "cid"),
    purposeCode: text(row, "purpose_code"),
    datasetIds: textArray(row.dataset_ids),
    legalBasis: text(row, "legal_basis") as LegalBasis,
    status: text(row, "status") as ConsentGrant["status"],
    grantedAt: timestamp(row, "granted_at"),
    withdrawnAt: timestampOrNull(row, "withdrawn_at"),
    receiptHash: text(row, "receipt_hash"),
    expiresAt: timestampOrNull(row, "expires_at"),
  };
}

function mapTemplate(row: Record<string, unknown>): TemplatePointer {
  return {
    id: text(row, "id"),
    cid: text(row, "cid"),
    storeKey: text(row, "store_key"),
    quality: numberValue(row.quality),
    modelName: text(row, "model_name"),
    modelVersion: text(row, "model_version"),
    createdAt: timestamp(row, "created_at"),
    purgedAt: timestampOrNull(row, "purged_at"),
  };
}

function mapSearch(row: Record<string, unknown>): SearchRecord {
  return {
    id: text(row, "id"),
    actorId: text(row, "actor_id"),
    purposeCode: text(row, "purpose_code"),
    legalBasis: text(row, "legal_basis") as LegalBasis,
    datasetId: text(row, "dataset_id"),
    edition: text(row, "edition") as SearchRecord["edition"],
    subjectCid: typeof row.subject_cid === "string" ? row.subject_cid : null,
    status: text(row, "status") as SearchRecord["status"],
    denialCode: typeof row.denial_code === "string" ? row.denial_code : null,
    modelName: typeof row.model_name === "string" ? row.model_name : null,
    modelVersion: typeof row.model_version === "string" ? row.model_version : null,
    createdAt: timestamp(row, "created_at"),
  };
}

function mapCandidate(row: Record<string, unknown>): StoredCandidate {
  return {
    id: text(row, "id"),
    searchId: text(row, "search_id"),
    cid: text(row, "cid"),
    confidence: numberValue(row.confidence),
    rank: numberValue(row.rank),
    evidence: jsonValue(row.evidence) as EvidenceItem[],
    createdAt: timestamp(row, "created_at"),
  };
}

function mapReview(row: Record<string, unknown>): ReviewRecord {
  return {
    id: text(row, "id"),
    searchId: text(row, "search_id"),
    status: text(row, "status") as ReviewRecord["status"],
    decision: typeof row.decision === "string" ? (row.decision as ReviewRecord["decision"]) : null,
    selectedCid: typeof row.selected_cid === "string" ? row.selected_cid : null,
    notes: typeof row.notes === "string" ? row.notes : null,
    reviewerId: typeof row.reviewer_id === "string" ? row.reviewer_id : null,
    decidedAt: timestampOrNull(row, "decided_at"),
    createdAt: timestamp(row, "created_at"),
  };
}

function mapAudit(row: Record<string, unknown>): AuditEntry {
  return {
    seq: numberValue(row.seq),
    recordedAt: text(row, "recorded_at"),
    actorId: text(row, "actor_id"),
    action: text(row, "action") as AuditEntry["action"],
    attestation: jsonValue(row.attestation) as AuditEntry["attestation"],
    payloadHash: text(row, "payload_hash"),
    prevHash: text(row, "prev_hash"),
    hash: text(row, "hash"),
  };
}

function mapCheckpoint(row: Record<string, unknown>): MerkleCheckpoint {
  return {
    throughSeq: numberValue(row.through_seq),
    leafCount: numberValue(row.leaf_count),
    merkleRoot: text(row, "merkle_root"),
    computedAt: text(row, "computed_at"),
    signature: typeof row.signature === "string" ? row.signature : "",
  };
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected text in ${key}`);
  return value;
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected text array");
  return value as string[];
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  throw new Error("Expected number");
}

function timestamp(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error(`Expected timestamp in ${key}`);
}

function timestampOrNull(row: Record<string, unknown>, key: string): string | null {
  if (row[key] == null) return null;
  return timestamp(row, key);
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function jsonObject(value: unknown): Record<string, string> {
  const parsed = jsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}
