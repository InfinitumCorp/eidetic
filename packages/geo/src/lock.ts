// © Infinitum Corporation®. All rights reserved.

import { createHash } from "node:crypto";

export interface GeoLockFileEntry {
  name: "geoip.dat" | "geosite.dat";
  asset: string;
  tag: string;
  url: string;
  sha256Url: string;
  sha256: string;
  license: string;
  project: string;
}

export interface GeoLockFile {
  source: "v2fly";
  files: GeoLockFileEntry[];
}

const ALLOWED_URL = /^https:\/\/github\.com\/v2fly\/(geoip|domain-list-community)\/releases\/download\/\d+\/[A-Za-z0-9._-]+$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertV2FlyUrl(url: string): void {
  if (/loyalsoldier|sing-box|singbox/i.test(url)) {
    throw new Error("Refusing Loyalsoldier and sing-box geo datasets. Those distributions are GPL-3.0.");
  }
  if (!ALLOWED_URL.test(url)) {
    throw new Error(`Refusing geo dataset URL outside pinned v2fly releases: ${url}`);
  }
}

export function loadGeoLock(text: string): GeoLockFile {
  const parsed = JSON.parse(text) as GeoLockFile;
  if (parsed.source !== "v2fly" || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error("Geo lockfile must list v2fly releases.");
  }
  for (const file of parsed.files) {
    if (file.name !== "geoip.dat" && file.name !== "geosite.dat") throw new Error("Geo lockfile has an unknown file name.");
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Geo lockfile hash for ${file.name} is not sha256.`);
    assertV2FlyUrl(file.url);
    assertV2FlyUrl(file.sha256Url);
    if (file.license !== "CC-BY-SA-4.0" && file.license !== "MIT") {
      throw new Error(`Geo lockfile license for ${file.name} is not an allowed v2fly license.`);
    }
  }
  return parsed;
}

export function parseOfficialSha256Sum(text: string, assetName: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) throw new Error("Official sha256sum file is empty.");
  let bare: string | null = null;
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})(?:\s+\*?(\S+))?$/.exec(line);
    if (!match) throw new Error("Official sha256sum file is not a sha256sum line.");
    const hash = match[1]!.toLowerCase();
    const filename = match[2];
    if (!filename) {
      bare = hash;
      continue;
    }
    if (filename === assetName) return hash;
  }
  if (bare) return bare;
  throw new Error(`Official sha256sum file has no entry for ${assetName}.`);
}

export function assertChecksumMatch(officialHash: string, lockHash: string, actualHash: string, label: string): void {
  const official = officialHash.toLowerCase();
  const expected = lockHash.toLowerCase();
  const actual = actualHash.toLowerCase();
  if (official !== expected) {
    throw new Error(`${label}: official sha256sum ${official} does not match lockfile ${expected}. Stop.`);
  }
  if (actual !== official) {
    throw new Error(`${label}: downloaded sha256 ${actual} does not match official sha256sum ${official}. Stop.`);
  }
}
