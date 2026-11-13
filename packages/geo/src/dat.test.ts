// © Infinitum Corporation®. All rights reserved.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EideticError } from "@eidetic/contracts";
import {
  annotateRouting,
  assertChecksumMatch,
  assertV2FlyUrl,
  buildSyntheticGeoFixtures,
  geoRoutingActive,
  infinitumGeoEnabled,
  loadGeoLock,
  loadV2RayDataset,
  parseGeoIpList,
  parseOfficialSha256Sum,
  readGeoRoutingSettings,
  writeGeoRoutingSettings,
  V2RayGeoDataset,
} from "./index.js";

const fixtures = buildSyntheticGeoFixtures();
const dataset = V2RayGeoDataset.fromBytes(fixtures.geoip, fixtures.geosite);
const fixtureDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const GEOIP_SHA256 = "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2";
const GEOSITE_SHA256 = "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2";

describe("v2ray geo fixtures", () => {
  it("maps an IP to a country and a domain to a site category", () => {
    expect(dataset.countryForIp("1.2.3.5")).toBe("US");
    expect(dataset.countryForIp("1.2.3.4")).toBe("CA");
    expect(dataset.countryForIp("9.9.9.9")).toBeNull();
    expect(dataset.countryForIp("2001:db8::1")).toBe("FR");
    expect(dataset.countryForIp("2001:db9::1")).toBeNull();
    expect(dataset.countryForIp("not-an-ip")).toBeNull();
    expect(dataset.categoriesForDomain("www.google.com")).toEqual(["google"]);
    expect(dataset.categoriesForDomain("mail.google.com")).toEqual(["google", "workspace"]);
    expect(dataset.categoriesForDomain("example.cn")).toEqual(["cn"]);
    expect(dataset.categoriesForDomain("fooadservice.example")).toEqual(["ads"]);
    expect(dataset.categoriesForDomain("pinned.example")).toEqual(["pinned"]);
    expect(dataset.categoriesForDomain("other.example")).toEqual([]);
    expect(dataset.categoriesForDomain("person@example.com")).toEqual([]);
  });

  it("reads the committed synthetic dat files", () => {
    const loaded = loadV2RayDataset(fixtureDir);
    expect(loaded.countryForIp("1.2.3.5")).toBe("US");
    expect(loaded.categoriesForDomain("example.cn")).toEqual(["cn"]);
    expect(Buffer.compare(readFileSync(path.join(fixtureDir, "geoip.dat")), Buffer.from(fixtures.geoip))).toBe(0);
    expect(Buffer.compare(readFileSync(path.join(fixtureDir, "geosite.dat")), Buffer.from(fixtures.geosite))).toBe(0);
  });

  it("rejects a truncated list", () => {
    expect(() => parseGeoIpList(Uint8Array.from([0x0a]))).toThrow(/truncated/);
  });

  it("stays off unless both switches are on and refuses identity hints", () => {
    expect(infinitumGeoEnabled({})).toBe(false);
    expect(infinitumGeoEnabled({ INFINITUM_GEO_ENABLED: "false" })).toBe(false);
    expect(infinitumGeoEnabled({ INFINITUM_GEO_ENABLED: "true" })).toBe(true);
    expect(geoRoutingActive(false, { geoRouting: true })).toBe(false);
    expect(geoRoutingActive(true, { geoRouting: false })).toBe(false);
    expect(geoRoutingActive(true, { geoRouting: true })).toBe(true);
    expect(() => annotateRouting(dataset, { domain: "cid://infinitum/someone" })).toThrow(EideticError);
    expect(() => annotateRouting(dataset, { ip: "1.2.3.4", domain: "ada@example.com" })).toThrow(/does not match identity/);
    expect(annotateRouting(dataset, { ip: "1.2.3.5", domain: "www.google.com" })).toEqual({
      countryCode: "US",
      categories: ["google"],
      usedForIdentityMatch: false,
    });
  });

  it("fails closed when a checksum does not match and rejects other datasets", () => {
    expect(() => assertChecksumMatch("aa", "bb", "aa", "geoip.dat")).toThrow(/does not match lockfile/);
    expect(() => assertChecksumMatch("aa", "aa", "cc", "geoip.dat")).toThrow(/does not match official/);
    expect(parseOfficialSha256Sum(`${GEOIP_SHA256}  geoip.dat\n`, "geoip.dat")).toBe(GEOIP_SHA256);
    expect(parseOfficialSha256Sum(`${GEOSITE_SHA256}  dlc.dat\n`, "dlc.dat")).toBe(GEOSITE_SHA256);
    expect(() => assertV2FlyUrl("https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/1/geoip.dat")).toThrow(/GPL-3/);
    expect(() => assertV2FlyUrl("https://github.com/SagerNet/sing-box/releases/download/1/geoip.dat")).toThrow(/GPL-3/);
    const lock = loadGeoLock(readFileSync(fileURLToPath(new URL("../geo.lock.json", import.meta.url)), "utf8"));
    expect(lock.source).toBe("v2fly");
    expect(lock.files.map((file) => [file.name, file.tag, file.sha256, file.license])).toEqual([
      ["geoip.dat", "202611080027", GEOIP_SHA256, "CC-BY-SA-4.0"],
      ["geosite.dat", "20261108011013", GEOSITE_SHA256, "MIT"],
    ]);
    expect(lock.files.every((file) => file.url.includes("github.com/v2fly/"))).toBe(true);
  });

  it("persists the geo routing toggle and defaults to off", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eidetic-geo-"));
    const file = path.join(dir, "settings.json");
    expect(readGeoRoutingSettings(file)).toEqual({ geoRouting: false });
    expect(writeGeoRoutingSettings(file, true)).toEqual({ geoRouting: true });
    expect(readGeoRoutingSettings(file)).toEqual({ geoRouting: true });
    writeGeoRoutingSettings(file, false);
    expect(readGeoRoutingSettings(file).geoRouting).toBe(false);
    writeFileSync(file, "{");
    expect(readGeoRoutingSettings(file).geoRouting).toBe(false);
  });
});
