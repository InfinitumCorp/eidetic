// © Infinitum Corporation®. All rights reserved.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * GNSS navigation-message authentication (OSNMA-style, TESLA scheme).
 *
 * This is DEFENSIVE: it verifies that received navigation data is authentic,
 * so a spoofer that fabricates nav messages is caught. It never forges, signs,
 * or transmits anything.
 *
 * The scheme has two guarantees, both checked here:
 *
 *   1. Key authenticity — disclosed TESLA keys form a one-way hash chain whose
 *      head is a trusted anchor (in real OSNMA the anchor/root is delivered
 *      under a digital signature; here the caller supplies the trusted anchor).
 *      For a key disclosed at index i, H applied i times must reproduce K0.
 *
 *   2. Data authenticity — each nav-data record carries a MAC computed with the
 *      (later-disclosed) key for its epoch. Once the key is disclosed and shown
 *      authentic, the MAC over the buffered data must verify.
 *
 * A spoofer cannot predict future keys (pre-images of a one-way chain), so it
 * cannot forge a MAC that will verify against the authentic chain.
 */

export type HashName = "sha256";

export interface AuthConfig {
  hash: HashName;
  /** MAC tag length in bytes to compare (truncated HMAC). */
  tagBytes: number;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = { hash: "sha256", tagBytes: 16 };

/** One application of the chain hash. */
function hashOnce(key: Buffer, hash: HashName): Buffer {
  return createHash(hash).update(key).digest();
}

/** Apply the chain hash `steps` times (H^steps(key)). */
export function hashChain(key: Buffer, steps: number, hash: HashName = "sha256"): Buffer {
  if (steps < 0 || !Number.isInteger(steps)) {
    throw new RangeError("steps must be a non-negative integer");
  }
  let out = key;
  for (let i = 0; i < steps; i++) out = hashOnce(out, hash);
  return out;
}

function equalBuffers(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify that a key disclosed at `index` chains back to the trusted `anchor`
 * (K0). The anchor is the head of the chain; the key at index i satisfies
 * H^i(K_i) == K0.
 */
export function verifyKeyAgainstAnchor(
  disclosedKey: Buffer,
  index: number,
  anchor: Buffer,
  hash: HashName = "sha256",
): boolean {
  if (index < 0 || !Number.isInteger(index)) return false;
  return equalBuffers(hashChain(disclosedKey, index, hash), anchor);
}

/** Compute the MAC over nav data with a given key (truncated HMAC-SHA256). */
export function computeMac(
  navData: Buffer,
  key: Buffer,
  config: AuthConfig = DEFAULT_AUTH_CONFIG,
): Buffer {
  const full = createHmac(config.hash, key).update(navData).digest();
  return full.subarray(0, config.tagBytes);
}

/** Verify a MAC tag over nav data (constant-time compare). */
export function verifyMac(
  navData: Buffer,
  key: Buffer,
  tag: Buffer,
  config: AuthConfig = DEFAULT_AUTH_CONFIG,
): boolean {
  return equalBuffers(computeMac(navData, key, config), tag);
}

/** A buffered, not-yet-authenticated nav-data record for one epoch. */
export interface NavRecord {
  index: number;
  navData: Buffer;
  tag: Buffer;
}

export interface VerificationResult {
  index: number;
  /** Did the disclosed key chain back to the trusted anchor? */
  keyAuthentic: boolean;
  /** Records that verified against the authentic key. */
  authentic: NavRecord[];
  /** Records that failed the MAC check (tampered / spoofed). */
  rejected: NavRecord[];
}

/**
 * Stateful authenticator. Seed with a trusted anchor (K0). As the receiver
 * discloses the key for an index, call `verify` with that key and any buffered
 * records for that index. Records whose MAC does not verify are rejected as
 * inauthentic (the hallmark of a nav-message spoof).
 */
export class NavMessageAuthenticator {
  private readonly anchor: Buffer;
  private readonly config: AuthConfig;

  constructor(anchor: Buffer, config: AuthConfig = DEFAULT_AUTH_CONFIG) {
    if (anchor.length === 0) throw new Error("anchor key must not be empty");
    this.anchor = anchor;
    this.config = config;
  }

  verify(index: number, disclosedKey: Buffer, records: readonly NavRecord[]): VerificationResult {
    const keyAuthentic = verifyKeyAgainstAnchor(
      disclosedKey,
      index,
      this.anchor,
      this.config.hash,
    );
    const authentic: NavRecord[] = [];
    const rejected: NavRecord[] = [];
    if (keyAuthentic) {
      for (const r of records) {
        if (r.index === index && verifyMac(r.navData, disclosedKey, r.tag, this.config)) {
          authentic.push(r);
        } else {
          rejected.push(r);
        }
      }
    } else {
      // An inauthentic key authenticates nothing; every record is suspect.
      rejected.push(...records);
    }
    return { index, keyAuthentic, authentic, rejected };
  }
}

/**
 * Build a valid TESLA chain for TESTING the verifier (anchor + per-index keys).
 * Generates keys K_length..K_0 by repeated hashing from a seed; K0 is the
 * anchor. This is test scaffolding for the DEFENSIVE verifier — it fabricates
 * nothing on the air and signs no real messages.
 */
export function buildTestChain(
  seed: Buffer,
  length: number,
  hash: HashName = "sha256",
): { anchor: Buffer; keys: Buffer[] } {
  // keys[i] is the key disclosed at index i; keys[0] hashes to... anchor == keys[0]'s 0-chain.
  // Construct so that H^i(keys[i]) === anchor.
  const top = hashChain(seed, 1, hash); // K_length
  const keys: Buffer[] = new Array(length + 1);
  keys[length] = top;
  for (let i = length - 1; i >= 0; i--) {
    keys[i] = hashOnce(keys[i + 1]!, hash);
  }
  return { anchor: keys[0]!, keys };
}
