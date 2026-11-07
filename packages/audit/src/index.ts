// © Infinitum Corporation®. All rights reserved.

import {
  canonicalJson,
  sealAttestation,
  sha256Hex,
  type AuditAttestation,
} from "@eidetic/contracts";

export const GENESIS = "0".repeat(64);

export type AuditAction = "enroll" | "withdraw" | "search" | "review" | "purpose_upsert" | "bias_evaluation";

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
}

export interface AuditAppendContext {
  last: AuditEntry | null;
  nextSeq: number;
  hashes: string[];
}

export interface AuditRepository {
  append(
    build: (context: AuditAppendContext) => { entry: AuditEntry; checkpoint: MerkleCheckpoint },
  ): Promise<{ entry: AuditEntry; checkpoint: MerkleCheckpoint }>;
  list(): Promise<AuditEntry[]>;
  checkpoints(): Promise<MerkleCheckpoint[]>;
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

export function verifyChain(entries: AuditEntry[], checkpoints: MerkleCheckpoint[]): VerifyResult {
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

export class AuditLog {
  constructor(private readonly repository: AuditRepository) {}

  async record(input: {
    actorId: string;
    action: AuditAction;
    recordedAt: string;
    attestation: AuditAttestation;
  }): Promise<{ entry: AuditEntry; checkpoint: MerkleCheckpoint }> {
    const attestation = sealAttestation(input.attestation);
    return this.repository.append(({ last, nextSeq, hashes }) => {
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
      return {
        entry,
        checkpoint: {
          throughSeq: nextSeq,
          leafCount: leaves.length,
          merkleRoot: merkleRoot(leaves),
          computedAt: input.recordedAt,
        },
      };
    });
  }

  async verify(): Promise<VerifyResult> {
    return verifyChain(await this.repository.list(), await this.repository.checkpoints());
  }

  list(): Promise<AuditEntry[]> {
    return this.repository.list();
  }
}
