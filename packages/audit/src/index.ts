// © Infinitum Corporation®. All rights reserved.

import {
  canonicalJson,
  sealAttestation,
  sha256Hex,
  type AuditAttestation,
} from "@eidetic/contracts";
import {
  checkpointSigningBytes,
  createEphemeralEd25519Signer,
  verifyEd25519Signature,
  type CheckpointSigner,
} from "./signer.js";

export {
  checkpointSigningBytes,
  createEd25519SignerFromPem,
  createEphemeralEd25519Signer,
  createOpenBaoTransitSigner,
  verifyEd25519Signature,
  type CheckpointSigner,
} from "./signer.js";

export const GENESIS = "0".repeat(64);

export type AuditAction = "enroll" | "withdraw" | "search" | "review" | "purpose_upsert" | "bias_evaluation" | "subject_access";

export interface AuditEntry {
  seq: number;
  recordedAt: string;
  actorId: string;
  action: AuditAction;
  attestation: AuditAttestation;
  payloadHash: string;
  prevHash: string;
  hash: string;
}

export interface MerkleCheckpoint {
  throughSeq: number;
  leafCount: number;
  merkleRoot: string;
  computedAt: string;
  signature: string;
}

export interface AuditAppendContext {
  last: AuditEntry | null;
  nextSeq: number;
  hashes: string[];
}

export interface AuditRepository {
  append(
    build: (context: AuditAppendContext) => Promise<{ entry: AuditEntry; checkpoint: MerkleCheckpoint }>,
  ): Promise<{ entry: AuditEntry; checkpoint: MerkleCheckpoint }>;
  list(): Promise<AuditEntry[]>;
  checkpoints(): Promise<MerkleCheckpoint[]>;
  sealBlank(throughSeq: number, signature: string): Promise<void>;
}

export interface TrillianCheckpoint {
  merkleRoot: string;
  leafCount: number;
  throughSeq: number;
}

export interface TrillianCheckpointPort {
  submit(checkpoint: TrillianCheckpoint): Promise<{ status: "not_configured" }>;
}

export class LocalTrillianCheckpointPort implements TrillianCheckpointPort {
  submit(): Promise<{ status: "not_configured" }> {
    return Promise.resolve({ status: "not_configured" });
  }
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256Hex("eidetic-empty");
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      if (index + 1 === level.length) next.push(level[index]);
      else next.push(sha256Hex(level[index] + level[index + 1]));
    }
    level = next;
  }
  return level[0];
}

export function entryHash(prevHash: string, core: { seq: number; recordedAt: string; actorId: string; action: string; payloadHash: string }): string {
  return sha256Hex(`${prevHash}\n${canonicalJson(core)}`);
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  entries: number;
  checkpoints: number;
  head: string | null;
  merkleRoot: string | null;
}

export function verifyChain(entries: AuditEntry[], checkpoints: MerkleCheckpoint[], publicKeyPem: string): VerifyResult {
  const errors: string[] = [];
  let previous = GENESIS;
  for (const entry of entries) {
    let sealed: AuditAttestation;
    try {
      sealed = sealAttestation(entry.attestation);
    } catch (error) {
      errors.push(`seq ${entry.seq} failed attestation sealing: ${(error as Error).message}`);
      previous = entry.hash;
      continue;
    }
    const payloadHash = sha256Hex(canonicalJson(sealed));
    if (payloadHash !== entry.payloadHash) errors.push(`seq ${entry.seq} payload hash mismatch`);
    if (entry.prevHash !== previous) errors.push(`seq ${entry.seq} previous hash mismatch`);
    const recomputed = entryHash(entry.prevHash, {
      seq: entry.seq,
      recordedAt: entry.recordedAt,
      actorId: entry.actorId,
      action: entry.action,
      payloadHash: entry.payloadHash,
    });
    if (recomputed !== entry.hash) errors.push(`seq ${entry.seq} entry hash mismatch`);
    previous = entry.hash;
  }
  for (const checkpoint of checkpoints) {
    const leaves = entries.filter((entry) => entry.seq <= checkpoint.throughSeq).map((entry) => entry.hash);
    if (leaves.length !== checkpoint.leafCount) errors.push(`checkpoint ${checkpoint.throughSeq} leaf count mismatch`);
    if (merkleRoot(leaves) !== checkpoint.merkleRoot) errors.push(`checkpoint ${checkpoint.throughSeq} merkle root mismatch`);
    const signed = verifyEd25519Signature(checkpointSigningBytes(checkpoint), checkpoint.signature, publicKeyPem);
    if (!signed) errors.push(`checkpoint ${checkpoint.throughSeq} signature mismatch`);
  }
  if (entries.length > 0 && checkpoints.length > 0) {
    const tip = checkpoints[checkpoints.length - 1];
    if (tip.throughSeq !== entries[entries.length - 1].seq) errors.push("tip checkpoint does not cover the log head");
  }
  return {
    ok: errors.length === 0,
    errors,
    entries: entries.length,
    checkpoints: checkpoints.length,
    head: entries.at(-1)?.hash ?? null,
    merkleRoot: checkpoints.at(-1)?.merkleRoot ?? null,
  };
}

export interface AuditExport {
  version: 1;
  product: "ei·det·ic™";
  algorithm: "ed25519";
  publicKeyPem: string;
  entries: AuditEntry[];
  checkpoints: MerkleCheckpoint[];
}

const EXPORT_FORBIDDEN_KEY = /image|template|embedding|vector|biometric|pixel|photo|probe|face|weight|descriptor|gallery/i;

export function exportAuditLog(entries: AuditEntry[], checkpoints: MerkleCheckpoint[], publicKeyPem: string): AuditExport {
  const payload: AuditExport = {
    version: 1,
    product: "ei·det·ic™",
    algorithm: "ed25519",
    publicKeyPem,
    entries: entries.map((entry) => ({ ...entry, attestation: sealAttestation(entry.attestation) })),
    checkpoints,
  };
  rejectBiometricKeys(payload);
  return payload;
}

export function verifyExportDocument(document: unknown, options?: { publicKeyPem?: string }): VerifyResult {
  if (!document || typeof document !== "object") {
    return { ok: false, errors: ["export is empty"], entries: 0, checkpoints: 0, head: null, merkleRoot: null };
  }
  rejectBiometricKeys(document);
  const body = document as Partial<AuditExport>;
  const pinned = options?.publicKeyPem?.trim();
  const embedded = body.publicKeyPem?.trim();
  if (!embedded && !pinned) {
    return { ok: false, errors: ["export has no Ed25519 public key"], entries: 0, checkpoints: 0, head: null, merkleRoot: null };
  }
  const errors: string[] = [];
  if (pinned && embedded && pinned !== embedded) errors.push("export public key does not match the pinned verifier key");
  const result = verifyChain(body.entries ?? [], body.checkpoints ?? [], pinned || embedded || "");
  return { ...result, ok: result.ok && errors.length === 0, errors: [...errors, ...result.errors] };
}

function rejectBiometricKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectBiometricKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (EXPORT_FORBIDDEN_KEY.test(key)) {
      throw new Error(`Audit export refused "${key}". Biometric payloads are not part of the public log.`);
    }
    rejectBiometricKeys(nested);
  }
}

export class AuditLog {
  private readonly signer: CheckpointSigner;

  constructor(private readonly repository: AuditRepository, signer?: CheckpointSigner) {
    this.signer = signer ?? createEphemeralEd25519Signer();
  }

  async record(input: {
    actorId: string;
    action: AuditAction;
    recordedAt: string;
    attestation: AuditAttestation;
  }): Promise<{ entry: AuditEntry; checkpoint: MerkleCheckpoint }> {
    const attestation = sealAttestation(input.attestation);
    return this.repository.append(async ({ last, nextSeq, hashes }) => {
      const payloadHash = sha256Hex(canonicalJson(attestation));
      const prevHash = last?.hash ?? GENESIS;
      const core = {
        seq: nextSeq,
        recordedAt: input.recordedAt,
        actorId: input.actorId,
        action: input.action,
        payloadHash,
      };
      const hash = entryHash(prevHash, core);
      const entry: AuditEntry = { ...core, attestation, prevHash, hash };
      const leaves = [...hashes, hash];
      const unsigned = {
        throughSeq: nextSeq,
        leafCount: leaves.length,
        merkleRoot: merkleRoot(leaves),
        computedAt: input.recordedAt,
      };
      const signature = await this.signer.sign(checkpointSigningBytes(unsigned));
      return { entry, checkpoint: { ...unsigned, signature } };
    });
  }

  async verify(): Promise<VerifyResult> {
    return verifyChain(await this.repository.list(), await this.repository.checkpoints(), await this.signer.publicKeyPem());
  }

  async export(): Promise<AuditExport> {
    return exportAuditLog(await this.repository.list(), await this.repository.checkpoints(), await this.signer.publicKeyPem());
  }

  /** Replace HMAC or blank checkpoint signatures with Ed25519. An existing Ed25519 signature is left untouched. */
  async signLegacy(): Promise<number> {
    const checkpoints = await this.repository.checkpoints();
    let signed = 0;
    for (const checkpoint of checkpoints) {
      if (checkpoint.signature.startsWith("ed25519:")) continue;
      await this.repository.sealBlank(checkpoint.throughSeq, await this.signer.sign(checkpointSigningBytes(checkpoint)));
      signed += 1;
    }
    return signed;
  }

  list(): Promise<AuditEntry[]> {
    return this.repository.list();
  }
}
