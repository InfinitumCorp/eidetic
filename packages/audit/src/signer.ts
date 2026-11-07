// © Infinitum Corporation®. All rights reserved.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson } from "@eidetic/contracts";

export interface CheckpointSigner {
  readonly algorithm: "ed25519";
  publicKeyPem(): Promise<string>;
  sign(message: Uint8Array): Promise<string>;
}

export function checkpointSigningBytes(checkpoint: {
  computedAt: string;
  leafCount: number;
  merkleRoot: string;
  throughSeq: number;
}): Uint8Array {
  return Buffer.from(
    canonicalJson({
      computedAt: checkpoint.computedAt,
      leafCount: checkpoint.leafCount,
      merkleRoot: checkpoint.merkleRoot,
      throughSeq: checkpoint.throughSeq,
    }),
  );
}

export function verifyEd25519Signature(message: Uint8Array, signatureField: string, publicKeyPem: string): boolean {
  if (!signatureField.startsWith("ed25519:")) return false;
  try {
    const raw = Buffer.from(signatureField.slice("ed25519:".length), "base64url");
    return verify(null, message, publicKeyPem, raw);
  } catch {
    return false;
  }
}

export function createEphemeralEd25519Signer(): CheckpointSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return signerFromKeys(privateKey, publicKey);
}

export function createEd25519SignerFromPem(pem: string): CheckpointSigner {
  const privateKey = createPrivateKey(pem);
  return signerFromKeys(privateKey, createPublicKey(privateKey));
}

function signerFromKeys(privateKey: KeyObject, publicKey: KeyObject): CheckpointSigner {
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    algorithm: "ed25519",
    publicKeyPem: () => Promise.resolve(publicKeyPem),
    sign(message: Uint8Array) {
      const raw = sign(null, message, privateKey);
      return Promise.resolve(`ed25519:${Buffer.from(raw).toString("base64url")}`);
    },
  };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * OpenBao Transit signer. OpenBao is the MPL-2.0 open-source fork of Vault.
 * The transit key must be type=ed25519. Verifiers keep only the public key.
 */
export function createOpenBaoTransitSigner(options: {
  address: string;
  token: string;
  keyName: string;
  fetchImpl?: FetchLike;
}): CheckpointSigner {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.address.replace(/\/$/, "");
  let cachedPem: string | null = null;
  return {
    algorithm: "ed25519",
    async publicKeyPem() {
      if (cachedPem) return cachedPem;
      const response = await fetchImpl(`${base}/v1/transit/keys/${options.keyName}`, {
        headers: { "X-Vault-Token": options.token },
      });
      if (!response.ok) {
        throw new Error("OpenBao transit key lookup failed. The checkpoint was not signed.");
      }
      const body = (await response.json()) as {
        data?: { type?: string; latest_version?: number; keys?: Record<string, { public_key?: string }> };
      };
      if (body.data?.type && body.data.type !== "ed25519") {
        throw new Error("OpenBao transit key must be type ed25519. HMAC keys are not accepted.");
      }
      const version = String(body.data?.latest_version ?? 1);
      const pem = body.data?.keys?.[version]?.public_key;
      if (!pem?.includes("BEGIN PUBLIC KEY")) {
        throw new Error("OpenBao transit key did not include an Ed25519 public key.");
      }
      cachedPem = pem;
      return pem;
    },
    async sign(message: Uint8Array) {
      const response = await fetchImpl(`${base}/v1/transit/sign/${options.keyName}`, {
        method: "POST",
        headers: { "X-Vault-Token": options.token, "content-type": "application/json" },
        body: JSON.stringify({ input: Buffer.from(message).toString("base64") }),
      });
      if (!response.ok) throw new Error("OpenBao transit sign failed. The checkpoint was not written.");
      const body = (await response.json()) as { data?: { signature?: string } };
      const vaultSignature = body.data?.signature ?? "";
      const parts = vaultSignature.split(":");
      if (parts.length !== 3 || parts[0] !== "vault" || !parts[2]) {
        throw new Error("OpenBao returned an unexpected transit signature.");
      }
      const raw = Buffer.from(parts[2], "base64");
      return `ed25519:${raw.toString("base64url")}`;
    },
  };
}
