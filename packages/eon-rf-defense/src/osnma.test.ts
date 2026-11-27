// © Infinitum Corporation®. All rights reserved.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NavMessageAuthenticator,
  buildTestChain,
  computeMac,
  hashChain,
  verifyKeyAgainstAnchor,
  verifyMac,
} from "./index.js";

const seed = Buffer.from("eon-osnma-test-seed");

describe("TESLA key chain", () => {
  it("a disclosed key chains back to the anchor at its index", () => {
    const { anchor, keys } = buildTestChain(seed, 8);
    for (let i = 0; i <= 8; i++) {
      expect(verifyKeyAgainstAnchor(keys[i]!, i, anchor)).toBe(true);
    }
  });

  it("rejects a key at the wrong index", () => {
    const { anchor, keys } = buildTestChain(seed, 8);
    expect(verifyKeyAgainstAnchor(keys[5]!, 4, anchor)).toBe(false);
    expect(verifyKeyAgainstAnchor(keys[5]!, 6, anchor)).toBe(false);
  });

  it("rejects a forged key (spoofer cannot invert the one-way chain)", () => {
    const { anchor } = buildTestChain(seed, 8);
    const forged = createHash("sha256").update("attacker-guess").digest();
    expect(verifyKeyAgainstAnchor(forged, 3, anchor)).toBe(false);
  });

  it("hashChain rejects a negative step count", () => {
    expect(() => hashChain(seed, -1)).toThrow(RangeError);
  });
});

describe("nav-data MAC", () => {
  it("verifies a MAC made with the matching key", () => {
    const { keys } = buildTestChain(seed, 4);
    const navData = Buffer.from("ephemeris:sv12:...");
    const tag = computeMac(navData, keys[2]!);
    expect(verifyMac(navData, keys[2]!, tag)).toBe(true);
  });

  it("rejects a tampered nav message", () => {
    const { keys } = buildTestChain(seed, 4);
    const navData = Buffer.from("ephemeris:sv12:...");
    const tag = computeMac(navData, keys[2]!);
    const tampered = Buffer.from("ephemeris:sv12:SPOOFED");
    expect(verifyMac(tampered, keys[2]!, tag)).toBe(false);
  });
});

describe("NavMessageAuthenticator", () => {
  it("authenticates genuine records and rejects a spoofed one", () => {
    const { anchor, keys } = buildTestChain(seed, 6);
    const auth = new NavMessageAuthenticator(anchor);
    const index = 3;
    const goodData = Buffer.from("genuine-ephemeris");
    const good = { index, navData: goodData, tag: computeMac(goodData, keys[index]!) };
    // Spoofer forges nav data but cannot produce a valid tag for the real key.
    const bad = {
      index,
      navData: Buffer.from("spoofed-ephemeris"),
      tag: computeMac(Buffer.from("spoofed-ephemeris"), Buffer.from("wrong-key")),
    };

    const result = auth.verify(index, keys[index]!, [good, bad]);
    expect(result.keyAuthentic).toBe(true);
    expect(result.authentic).toHaveLength(1);
    expect(result.authentic[0]!.navData.toString()).toBe("genuine-ephemeris");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.navData.toString()).toBe("spoofed-ephemeris");
  });

  it("authenticates nothing when the disclosed key is inauthentic", () => {
    const { anchor, keys } = buildTestChain(seed, 6);
    const auth = new NavMessageAuthenticator(anchor);
    const rec = { index: 2, navData: Buffer.from("data"), tag: Buffer.alloc(16) };
    // Wrong key for the index -> key fails the chain -> all records rejected.
    const result = auth.verify(2, keys[3]!, [rec]);
    expect(result.keyAuthentic).toBe(false);
    expect(result.authentic).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("refuses an empty anchor", () => {
    expect(() => new NavMessageAuthenticator(Buffer.alloc(0))).toThrow();
  });
});
