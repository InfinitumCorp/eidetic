// © Infinitum Corporation®. All rights reserved.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGeoLists,
  encodeGeoIpList,
  encodeGeoSiteList,
  parseGeoIpList,
  parseGeoSiteList,
  sha256Hex,
} from "./dat.js";
import { downloadGeoDatasets, loadLockedGeoLists, parseSha256Sum, readLockFile } from "./fetch.js";
import { createCyberGeoHook } from "./hook.js";
import { fieldBytes, fieldVarint } from "./protobuf.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eidetic-geo-"));
  tempDirs.push(dir);
  return dir;
}

function ipv4(text: string): Uint8Array {
  return Uint8Array.from(text.split(".").map((part) => Number(part)));
}

function ipv6(words: number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

function fixtureBytes() {
  const geoip = encodeGeoIpList([
    { countryCode: "US", cidrs: [{ ip: ipv4("10.0.0.0"), prefix: 8 }] },
    { countryCode: "CA", cidrs: [{ ip: ipv4("10.1.0.0"), prefix: 16 }] },
    { countryCode: "PRIVATE", cidrs: [{ ip: ipv4("192.168.0.0"), prefix: 16 }] },
    { countryCode: "ZZ", reverseMatch: true, cidrs: [{ ip: ipv4("10.0.0.0"), prefix: 8 }] },
    { countryCode: "TEST", cidrs: [{ ip: ipv6([0x2001, 0x0db8, 0, 0, 0, 0, 0, 0]), prefix: 32 }] },
  ]);
  const geosite = encodeGeoSiteList([
    { category: "example", domains: [{ type: "domain", value: "example.com" }] },
    { category: "exact", domains: [{ type: "full", value: "exact.test" }] },
    { category: "keyword", domains: [{ type: "plain", value: "cdn-edge" }] },
    { category: "pattern", domains: [{ type: "regex", value: "^re\\.example$" }] },
  ]);
  return { geoip, geosite };
}

function writeLock(dir: string, geoip: Uint8Array, geosite: Uint8Array, geoipSha = sha256Hex(geoip)): void {
  const lock = {
    version: 1,
    publisher: "v2fly",
    files: [
      {
        filename: "geoip.dat",
        asset: "geoip.dat",
        tag: "synthetic",
        url: "https://github.com/v2fly/geoip/releases/download/synthetic/geoip.dat",
        sha256sumUrl: "https://github.com/v2fly/geoip/releases/download/synthetic/geoip.dat.sha256sum",
        sha256: geoipSha,
        license: "CC-BY-SA-4.0",
        project: "https://github.com/v2fly/geoip",
        release: "https://github.com/v2fly/geoip/releases/tag/synthetic",
      },
      {
        filename: "geosite.dat",
        asset: "dlc.dat",
        tag: "synthetic",
        url: "https://github.com/v2fly/domain-list-community/releases/download/synthetic/dlc.dat",
        sha256sumUrl: "https://github.com/v2fly/domain-list-community/releases/download/synthetic/dlc.dat.sha256sum",
        sha256: sha256Hex(geosite),
        license: "MIT",
        project: "https://github.com/v2fly/domain-list-community",
        release: "https://github.com/v2fly/domain-list-community/releases/tag/synthetic",
      },
    ],
  };
  writeFileSync(path.join(dir, "geo-dat.lock.json"), JSON.stringify(lock));
}

describe("v2fly geo dat", () => {
  it("maps an address to a country and a domain to a category", () => {
    const { geoip, geosite } = fixtureBytes();
    const lists = buildGeoLists(parseGeoIpList(geoip), parseGeoSiteList(geosite));

    expect(lists.lookupIp("10.1.2.3")).toEqual({ country: "CA", codes: ["US", "CA"] });
    expect(lists.lookupIp("10.2.3.4")).toEqual({ country: "US", codes: ["US"] });
    expect(lists.lookupIp("192.168.1.20")).toEqual({ country: "PRIVATE", codes: ["PRIVATE", "ZZ"] });
    expect(lists.lookupIp("::ffff:10.1.2.3")).toEqual({ country: "CA", codes: ["US", "CA"] });
    expect(lists.lookupIp("8.8.8.8")).toEqual({ country: null, codes: ["ZZ"] });
    expect(lists.lookupIp("2001:db8::1")).toEqual({ country: "TEST", codes: ["ZZ", "TEST"] });
    expect(lists.lookupIp("not-an-ip")).toEqual({ country: null, codes: [] });

    expect(lists.lookupDomain("WWW.Example.COM")).toEqual(["example"]);
    expect(lists.lookupDomain("notexample.com")).toEqual([]);
    expect(lists.lookupDomain("exact.test")).toEqual(["exact"]);
    expect(lists.lookupDomain("www.exact.test")).toEqual([]);
    expect(lists.lookupDomain("cdn-edge.example.com").sort()).toEqual(["example", "keyword"]);
    expect(lists.lookupDomain("https://re.example/path")).toEqual(["pattern"]);
    expect(lists.lookupDomain("www.re.example")).toEqual([]);
  });

  it("ignores unknown protobuf fields in a synthetic record", () => {
    const record = fieldBytes(
      1,
      new Uint8Array([
        ...fieldBytes(1, new TextEncoder().encode("US")),
        ...fieldBytes(2, new Uint8Array([...fieldBytes(1, ipv4("1.2.3.0")), ...fieldVarint(2, 24), ...fieldVarint(9, 1)])),
        ...fieldVarint(8, 1),
      ]),
    );
    expect(parseGeoIpList(record)).toEqual([
      { countryCode: "US", reverseMatch: false, cidrs: [{ ip: ipv4("1.2.3.0"), prefix: 24 }] },
    ]);
  });

  it("stays disabled unless the cyber geo flag is on", () => {
    const hook = createCyberGeoHook({ enabled: false, dataDir: "/absent/geo-data" });
    expect(hook.enabled).toBe(false);
    expect(hook.annotate({ ip: "8.8.8.8", domain: "example.com" })).toBeNull();
  });

  it("loads a checksum-locked synthetic directory and refuses a mismatched file", () => {
    const dir = tempDir();
    const { geoip, geosite } = fixtureBytes();
    writeLock(dir, geoip, geosite);
    writeFileSync(path.join(dir, "geoip.dat"), geoip);
    writeFileSync(path.join(dir, "geosite.dat"), geosite);
    const hook = createCyberGeoHook({ enabled: true, dataDir: dir });
    expect(hook.annotate({ ip: "10.1.2.3", domain: "www.example.com" })).toEqual({
      country: "CA",
      codes: ["US", "CA"],
      categories: ["example"],
    });

    geoip[10] ^= 0xff;
    writeFileSync(path.join(dir, "geoip.dat"), geoip);
    expect(() => loadLockedGeoLists(dir)).toThrow(/Checksum mismatch for geoip\.dat/);
    expect(statSync(path.join(dir, "geosite.dat")).size).toBeGreaterThan(0);
  });

  it("stops a download when the official checksum or the bytes disagree", async () => {
    const dir = tempDir();
    const { geoip, geosite } = fixtureBytes();
    writeLock(dir, geoip, geosite);
    const bodies = new Map<string, { status?: number; body: string | Uint8Array }>([
      ["https://github.com/v2fly/geoip/releases/download/synthetic/geoip.dat.sha256sum", { body: `${sha256Hex(geoip)}  geoip.dat\n` }],
      ["https://github.com/v2fly/geoip/releases/download/synthetic/geoip.dat", { body: geoip }],
      [
        "https://github.com/v2fly/domain-list-community/releases/download/synthetic/dlc.dat.sha256sum",
        { body: `${sha256Hex(geosite)}  dlc.dat\n` },
      ],
      ["https://github.com/v2fly/domain-list-community/releases/download/synthetic/dlc.dat", { body: geosite }],
    ]);
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      const found = bodies.get(url);
      if (!found) return new Response("missing", { status: 404 });
      const payload = typeof found.body === "string" ? found.body : Buffer.from(found.body);
      return new Response(payload, { status: found.status ?? 200 });
    };

    await downloadGeoDatasets(dir, fetchImpl);
    expect(sha256Hex(new Uint8Array(readFileSync(path.join(dir, "geosite.dat"))))).toBe(sha256Hex(geosite));

    bodies.set("https://github.com/v2fly/geoip/releases/download/synthetic/geoip.dat.sha256sum", {
      body: `${"ab".repeat(32)}  geoip.dat\n`,
    });
    await expect(downloadGeoDatasets(dir, fetchImpl)).rejects.toThrow(/does not match the lockfile/);

    bodies.set("https://github.com/v2fly/geoip/releases/download/synthetic/geoip.dat.sha256sum", { body: `${sha256Hex(geoip)}  geoip.dat\n` });
    bodies.set("https://github.com/v2fly/geoip/releases/download/synthetic/geoip.dat", { body: new Uint8Array([1, 2, 3]) });
    await expect(downloadGeoDatasets(dir, fetchImpl)).rejects.toThrow(/checksum mismatch/);
    expect(parseSha256Sum("dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2  dlc.dat\n", "dlc.dat")).toBe(
      "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2",
    );
  });

  it("pins the v2fly releases and refuses other publishers", () => {
    const lock = readLockFile(path.resolve("data/geo/geo-dat.lock.json"));
    expect(lock.publisher).toBe("v2fly");
    expect(lock.files.map((entry) => [entry.filename, entry.asset, entry.tag, entry.sha256, entry.license])).toEqual([
      ["geoip.dat", "geoip.dat", "202611080027", "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2", "CC-BY-SA-4.0"],
      [
        "geosite.dat",
        "dlc.dat",
        "20261108011013",
        "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2",
        "MIT",
      ],
    ]);
    const poisoned = structuredClone(lock);
    poisoned.files[0].url = "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/202611080027/geoip.dat";
    const dir = tempDir();
    writeFileSync(path.join(dir, "geo-dat.lock.json"), JSON.stringify(poisoned));
    expect(() => readLockFile(path.join(dir, "geo-dat.lock.json"))).toThrow(/Loyalsoldier/);
  });
});
