// © Infinitum Corporation®. All rights reserved.

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuditLog, type AuditRepository, type AuditEntry, type MerkleCheckpoint } from "./index.js";
import { checkpointSigningBytes, createEd25519SignerFromPem, createEphemeralEd25519Signer, createOpenBaoTransitSigner } from "./signer.js";

class MemoryAuditRepository implements AuditRepository {
  entries: AuditEntry[] = [];
  points: MerkleCheckpoint[] = [];

  async append(build: Parameters<AuditRepository["append"]>[0]) {
    const last = this.entries.at(-1) ?? null;
    const built = await build({ last, nextSeq: (last?.seq ?? 0) + 1, hashes: this.entries.map((entry) => entry.hash) });
    this.entries.push(built.entry);
    this.points.push(built.checkpoint);
    return built;
  }

  list(): Promise<AuditEntry[]> {
    return Promise.resolve(structuredClone(this.entries));
  }

  checkpoints(): Promise<MerkleCheckpoint[]> {
    return Promise.resolve(structuredClone(this.points));
  }

  sealBlank(): Promise<void> {
    return Promise.resolve();
  }
}

describe("Ed25519 checkpoint signers", () => {
  it("verifies a PEM key and an OpenBao transit signature with the public key only", async () => {
    const local = createEphemeralEd25519Signer();
    const pem = await local.publicKeyPem();
    const message = checkpointSigningBytes({ throughSeq: 1, leafCount: 1, merkleRoot: "abc", computedAt: "2026-11-07T00:00:00.000Z" });
    const signature = await local.sign(message);
    const privatePem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const signer = createEd25519SignerFromPem(privatePem);
    const publicPem = await signer.publicKeyPem();
    const openbao = createOpenBaoTransitSigner({
      address: "http://openbao.internal:8200",
      token: "test-token",
      keyName: "eidetic-audit",
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/keys/eidetic-audit")) {
          return new Response(JSON.stringify({ data: { type: "ed25519", latest_version: 1, keys: { "1": { public_key: publicPem } } } }), { status: 200 });
        }
        const body = JSON.parse(String(init?.body)) as { input: string };
        const raw = sign(null, Buffer.from(body.input, "base64"), createPrivateKey(privatePem));
        return new Response(JSON.stringify({ data: { signature: `vault:v1:${Buffer.from(raw).toString("base64")}` } }), { status: 200 });
      },
    });
    const log = new AuditLog(new MemoryAuditRepository(), openbao);
    await log.record({
      actorId: "actor-auditor",
      action: "search",
      recordedAt: "2026-11-07T00:00:00.000Z",
      attestation: { outcome: "recorded", matchRan: false, message: "signed by transit" },
    });
    expect((await log.verify()).ok).toBe(true);
    const exported = await log.export();
    expect(exported.publicKeyPem).toBe(publicPem);
    expect(exported.checkpoints[0].signature.startsWith("ed25519:")).toBe(true);
    expect(signature.startsWith("ed25519:")).toBe(true);
    expect(pem.includes("BEGIN PUBLIC KEY")).toBe(true);
  });
});
