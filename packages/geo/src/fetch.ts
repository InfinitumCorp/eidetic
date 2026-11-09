// © Infinitum Corporation®. All rights reserved.
// Download pinned v2fly geo datasets. Loyalsoldier and sing-box lists are refused.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildGeoLists, parseGeoIpList, parseGeoSiteList, sha256Hex, type GeoLists } from "./dat.js";

export interface GeoDatLockEntry {
  filename: "geoip.dat" | "geosite.dat";
  asset: string;
  tag: string;
  url: string;
  sha256sumUrl: string;
  sha256: string;
  license: string;
  project: string;
  release: string;
}

export interface GeoDatLockFile {
  version: 1;
  publisher: "v2fly";
  files: GeoDatLockEntry[];
}

const V2FLY_URL =
  /^https:\/\/github\.com\/v2fly\/(geoip|domain-list-community)\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function assertV2flyReleaseUrl(url: string): void {
  if (/loyalsoldier|sing-?box/i.test(url)) {
    throw new Error("Refusing Loyalsoldier and sing-box datasets. Those lists are not used.");
  }
  if (!V2FLY_URL.test(url)) {
    throw new Error(`Refusing geo dataset URL outside the pinned v2fly releases: ${url}`);
  }
}

export function parseSha256Sum(text: string, assetName: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})(?:\s+\*?(\S+))?$/.exec(line);
    if (!match) continue;
    const name = match[2];
    if (!name || name === assetName || name.endsWith(`/${assetName}`)) return match[1].toLowerCase();
  }
  throw new Error(`Official checksum file did not name ${assetName}. Stopped.`);
}

function isLockEntry(value: unknown): value is GeoDatLockEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.filename === "geoip.dat" || entry.filename === "geosite.dat") &&
    typeof entry.asset === "string" &&
    typeof entry.tag === "string" &&
    typeof entry.url === "string" &&
    typeof entry.sha256sumUrl === "string" &&
    typeof entry.sha256 === "string" &&
    typeof entry.license === "string" &&
    typeof entry.project === "string" &&
    typeof entry.release === "string"
  );
}

export function readLockFile(file: string): GeoDatLockFile {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Geo dataset lockfile is not an object.");
  const body = parsed as Record<string, unknown>;
  if (body.version !== 1 || body.publisher !== "v2fly" || !Array.isArray(body.files) || !body.files.every(isLockEntry)) {
    throw new Error("Geo dataset lockfile must be v2fly version 1 with geoip.dat and geosite.dat.");
  }
  const lock: GeoDatLockFile = { version: 1, publisher: "v2fly", files: body.files };
  const names = lock.files.map((entry) => entry.filename);
  if (lock.files.length !== 2 || names.filter((name) => name === "geoip.dat").length !== 1 || names.filter((name) => name === "geosite.dat").length !== 1) {
    throw new Error("Geo dataset lockfile must contain geoip.dat and geosite.dat only.");
  }
  for (const entry of lock.files) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Lockfile sha256 for ${entry.filename} is not 64 hex characters.`);
    assertV2flyReleaseUrl(entry.url);
    assertV2flyReleaseUrl(entry.sha256sumUrl);
    if (/loyalsoldier|sing-?box/i.test(`${entry.project} ${entry.release} ${entry.asset}`)) {
      throw new Error("Refusing Loyalsoldier and sing-box datasets. Those lists are not used.");
    }
  }
  return lock;
}

function entryFor(lock: GeoDatLockFile, filename: "geoip.dat" | "geosite.dat"): GeoDatLockEntry {
  const entry = lock.files.find((item) => item.filename === filename);
  if (!entry) throw new Error(`Lockfile is missing ${filename}.`);
  return entry;
}

function readVerified(dataDir: string, entry: GeoDatLockEntry): Uint8Array {
  const file = path.join(dataDir, entry.filename);
  if (!existsSync(file)) {
    throw new Error(`Missing ${entry.filename} in ${dataDir}. Run pnpm geo:fetch. The binary is not committed.`);
  }
  const bytes = new Uint8Array(readFileSync(file));
  const actual = sha256Hex(bytes);
  if (actual !== entry.sha256) {
    throw new Error(`Checksum mismatch for ${entry.filename}. Stopped. actual=${actual} lock=${entry.sha256}`);
  }
  return bytes;
}

export function loadLockedGeoLists(dataDir: string): GeoLists {
  const lock = readLockFile(path.join(dataDir, "geo-dat.lock.json"));
  const geoip = readVerified(dataDir, entryFor(lock, "geoip.dat"));
  const geosite = readVerified(dataDir, entryFor(lock, "geosite.dat"));
  return buildGeoLists(parseGeoIpList(geoip), parseGeoSiteList(geosite));
}

async function readBody(response: Response, label: string): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}. Stopped.`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function downloadGeoDatasets(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const lock = readLockFile(path.join(dataDir, "geo-dat.lock.json"));
  mkdirSync(dataDir, { recursive: true });
  for (const entry of lock.files) {
    const sumResponse = await fetchImpl(entry.sha256sumUrl);
    if (!sumResponse.ok) {
      throw new Error(`Official checksum download failed for ${entry.asset}: HTTP ${sumResponse.status}. Stopped.`);
    }
    const official = parseSha256Sum(await sumResponse.text(), entry.asset);
    if (official !== entry.sha256) {
      throw new Error(
        `Official sha256sum for ${entry.asset} does not match the lockfile. Stopped without writing ${entry.filename}. official=${official} lock=${entry.sha256}`,
      );
    }
    const bytes = await readBody(await fetchImpl(entry.url), `Download of ${entry.asset}`);
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new Error(
        `Downloaded ${entry.asset} checksum mismatch. Stopped without writing ${entry.filename}. actual=${actual} expected=${entry.sha256}`,
      );
    }
    writeFileSync(path.join(dataDir, entry.filename), bytes);
  }
}
