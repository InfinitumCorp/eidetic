// © Infinitum Corporation®. All rights reserved.
// Opt-in cyber annotation. Authorization does not read this result.

import path from "node:path";
import { loadLockedGeoLists } from "./fetch.js";

export interface CyberGeoAnnotation {
  country: string | null;
  codes: string[];
  categories: string[];
}

export interface CyberGeoHook {
  enabled: boolean;
  annotate(input: { ip?: string | null; domain?: string | null }): CyberGeoAnnotation | null;
}

function defaultGeoDataDir(): string {
  const cwd = process.cwd();
  const root = cwd.endsWith(`${path.sep}apps${path.sep}api`) ? path.resolve(cwd, "../..") : cwd;
  return path.resolve(root, "data/geo");
}

export function createCyberGeoHook(options: { enabled: boolean; dataDir?: string }): CyberGeoHook {
  if (!options.enabled) {
    return { enabled: false, annotate: () => null };
  }
  const lists = loadLockedGeoLists(options.dataDir ?? defaultGeoDataDir());
  return {
    enabled: true,
    annotate(input) {
      const ip = input.ip ? lists.lookupIp(input.ip) : { country: null, codes: [] as string[] };
      const categories = input.domain ? lists.lookupDomain(input.domain) : [];
      return { country: ip.country, codes: ip.codes, categories };
    },
  };
}
