// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import type { AuditAttestation } from "@eidetic/contracts";
import { AuditLog, exportAuditLog, verifyChain, verifyExportDocument, type AuditEntry, type AuditRepository, type MerkleCheckpoint } from "./index.js";

class MemoryAuditRepository implements AuditRepository {
  entries: AuditEntry[] = [];
  points: MerkleCheckpoint[] = [];

  append(build: Parameters<AuditRepository["append"]>[0]) {
    const last = this.entries.at(-1) ?? null;
    return build({ last, nextSeq: (last?.seq ?? 0) + 1, hashes: this.entries.map((entry) => entry.hash) }).then((built) => {
      this.entries.push(built.entry);
      this.points.push(built.checkpoint);
      return built;
    });
  }

  list(): Promise<AuditEntry[]> {
    return Promise.resolve(structuredClone(this.entries));
  }

  checkpoints(): Promise<MerkleCheckpoint[]> {
    return Promise.resolve(structuredClone(this.points));
  }

  sealBlank(throughSeq: number, signature: string): Promise<void> {
    const checkpoint = this.points.find((item) => item.throughSeq === throughSeq);
    if (checkpoint && !checkpoint.signature.startsWith("ed25519:")) checkpoint.signature = signature;
    return Promise.resolve();
  }
}

const attestation = (message: string): AuditAttestation => ({
  outcome: "recorded",
  matchRan: false,
  message,
  subjectCid: "cid://infinitum/fixture-avery-quinn",
});

describe("hash-chained audit log", () => {
  it("links entries and detects tampering", async () => {
    const repository = new MemoryAuditRepository();
    const log = new AuditLog(repository);
    await log.record({ actorId: "actor-admin", action: "enroll", recordedAt: "2026-11-07T12:00:00.000Z", attestation: attestation("enrolled") });
    await log.record({ actorId: "actor-operator", action: "search", recordedAt: "2026-11-07T12:01:00.000Z", attestation: { ...attestation("searched"), outcome: "allowed", matchRan: true, candidateCount: 1, topConfidence: 0.97 } });
    const proof = await log.verify();
    expect(proof.ok).toBe(true);
    expect(proof.entries).toBe(2);
    expect(proof.merkleRoot).toMatch(/^[a-f0-9]{64}$/);
    const tampered = await repository.list();
    tampered[0].attestation.message = "rewritten";
    expect(verifyChain(tampered, await repository.checkpoints(), "missing-public-key").ok).toBe(false);
  });

  it("refuses to append a biometric payload", async () => {
    const repository = new MemoryAuditRepository();
    const log = new AuditLog(repository);
    await expect(
      log.record({
        actorId: "actor-admin",
        action: "search",
        recordedAt: "2026-11-07T12:00:00.000Z",
        attestation: { ...attestation("bad"), templateRef: "templates/secret" } as AuditAttestation,
      }),
    ).rejects.toThrow(/DoNotLog/);
    expect(repository.entries).toHaveLength(0);
  });

  it("signs checkpoints and refuses biometric keys in an export", async () => {
    const repository = new MemoryAuditRepository();
    const log = new AuditLog(repository);
    await log.record({ actorId: "actor-admin", action: "enroll", recordedAt: "2026-11-07T12:00:00.000Z", attestation: attestation("enrolled") });
    const exported = await log.export();
    expect(exported.checkpoints[0].signature.startsWith("ed25519:")).toBe(true);
    expect(exported.algorithm).toBe("ed25519");
    expect(verifyExportDocument(exported).ok).toBe(true);
    const tampered = structuredClone(exported);
    tampered.checkpoints[0].signature = `ed25519:${"A".repeat(40)}`;
    expect(verifyExportDocument(tampered).ok).toBe(false);
    const swapped = structuredClone(exported);
    swapped.publicKeyPem = "not-the-pinned-key";
    expect(verifyExportDocument(swapped, { publicKeyPem: exported.publicKeyPem }).errors.join(" ")).toMatch(/pinned/);
    expect(() => exportAuditLog([{ ...repository.entries[0], attestation: { ...attestation("x"), embedding: [1] } as AuditEntry["attestation"] }], [], "not-a-key")).toThrow(/DoNotLog|refused/);
  });
});
