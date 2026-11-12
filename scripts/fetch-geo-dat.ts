// © Infinitum Corporation®. All rights reserved.
// Downloads pinned v2fly geoip.dat and geosite.dat into data/geo.
// The binaries are gitignored. A checksum mismatch deletes the partial file and exits.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertChecksumMatch,
  defaultGeoDataDir,
  loadGeoLock,
  parseOfficialSha256Sum,
  sha256Hex,
} from "../packages/geo/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "packages/geo/geo.lock.json");
const destination = defaultGeoDataDir(root);
const lock = loadGeoLock(readFileSync(lockPath, "utf8"));

mkdirSync(destination, { recursive: true });

for (const file of lock.files) {
  const officialText = await downloadText(file.sha256Url);
  const officialHash = parseOfficialSha256Sum(officialText, file.asset);
  if (officialHash !== file.sha256) {
    throw new Error(`${file.name}: official sha256sum ${officialHash} does not match lockfile ${file.sha256}. Stop.`);
  }
  const bytes = await downloadBytes(file.url);
  assertChecksumMatch(officialHash, file.sha256, sha256Hex(bytes), file.name);
  const temp = path.join(destination, `.${file.name}.partial`);
  const target = path.join(destination, file.name);
  try {
    writeFileSync(temp, bytes, { mode: 0o644 });
    const written = readFileSync(temp);
    assertChecksumMatch(officialHash, file.sha256, sha256Hex(written), file.name);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  console.log(`${file.name} ${file.tag} ${file.license} ${bytes.length} bytes`);
}

console.log(`v2fly geo datasets saved under ${destination}. They are not committed.`);

async function downloadText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed for ${url}: ${response.status}`);
  return response.text();
}

async function downloadBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed for ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
