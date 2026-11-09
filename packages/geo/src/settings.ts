// © Infinitum Corporation®. All rights reserved.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface GeoRoutingSettings {
  geoRouting: boolean;
}

export function repoRootFromCwd(cwd = process.cwd()): string {
  if (
    cwd.endsWith(`${path.sep}apps${path.sep}api`) ||
    cwd.endsWith(`${path.sep}apps${path.sep}admin`) ||
    cwd.endsWith(`${path.sep}apps${path.sep}reviewer`)
  ) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

export function defaultGeoDataDir(cwd = process.cwd()): string {
  return path.join(repoRootFromCwd(cwd), "data", "geo");
}

export function defaultGeoSettingsPath(cwd = process.cwd()): string {
  return path.join(repoRootFromCwd(cwd), "data", "settings.json");
}

/** Missing or unreadable settings fail closed to off. */
export function readGeoRoutingSettings(file: string): GeoRoutingSettings {
  if (!existsSync(file)) return { geoRouting: false };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { geoRouting?: unknown };
    return { geoRouting: parsed.geoRouting === true };
  } catch {
    return { geoRouting: false };
  }
}

export function writeGeoRoutingSettings(file: string, geoRouting: boolean): GeoRoutingSettings {
  mkdirSync(path.dirname(file), { recursive: true });
  const settings = { geoRouting };
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settings;
}
