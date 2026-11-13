// © Infinitum Corporation®. All rights reserved.

import { EideticError } from "@eidetic/contracts";
import type { V2RayGeoDataset } from "./dat.js";
import { normalizeDomain, parseIp } from "./dat.js";
import type { GeoRoutingSettings } from "./settings.js";

export interface RoutingHint {
  ip?: string;
  domain?: string;
}

export interface GeoRoutingAnnotation {
  countryCode: string | null;
  categories: string[];
  usedForIdentityMatch: false;
}

const IDENTITY_HINT = /cid:\/\/|@/i;

export function infinitumGeoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INFINITUM_GEO_ENABLED === "true";
}

export function geoRoutingActive(processOptIn: boolean, settings: GeoRoutingSettings): boolean {
  return processOptIn === true && settings.geoRouting === true;
}

/**
 * Country and site-category labels for cyber routing.
 * The result is not an identity, and callers must not pass it to the matcher.
 */
export function annotateRouting(dataset: V2RayGeoDataset, hint: RoutingHint): GeoRoutingAnnotation | null {
  if (!hint.ip && !hint.domain) return null;
  const blob = `${hint.ip ?? ""}\n${hint.domain ?? ""}`;
  if (IDENTITY_HINT.test(blob)) {
    throw new EideticError(
      "PERSON_TRACKING_REFUSED",
      "Geo routing labels a network address with a country or a site category. It does not match identity.",
      403,
      false,
    );
  }
  const countryCode = hint.ip && parseIp(hint.ip) ? dataset.countryForIp(hint.ip) : null;
  const categories = hint.domain && normalizeDomain(hint.domain) ? dataset.categoriesForDomain(hint.domain) : [];
  if (!hint.ip && categories.length === 0 && !hint.domain) return null;
  return { countryCode, categories, usedForIdentityMatch: false };
}
