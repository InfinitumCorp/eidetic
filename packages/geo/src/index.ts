// © Infinitum Corporation®. All rights reserved.

import { EideticError } from "@eidetic/contracts";

export interface SiteAsset {
  assetId: string;
  label: string;
  kind: "site" | "building";
  bbox: [number, number, number, number] | null;
  note: string;
}

const CATALOG: Record<string, SiteAsset> = {
  "hq-washington": {
    assetId: "hq-washington",
    label: "1629 K Street NW, Suite 300, Washington, D.C.",
    kind: "building",
    bbox: [-77.0408, 38.9026, -77.0335, 38.9064],
    note: "Office site context for an asset the organization already operates. This record has no person track.",
  },
};

const TRACKING_REQUEST = /person|face|track|follow|drone|satellite|plate|alpr/i;

/**
 * Local site and asset catalog. Rasterio is not imported.
 * Overhead imagery is not used to follow people.
 */
export function describeSiteAsset(assetId: string): SiteAsset {
  if (TRACKING_REQUEST.test(assetId)) {
    throw new EideticError(
      "PERSON_TRACKING_REFUSED",
      "Rasterio is an optional site and asset context adapter. ei·det·ic™ does not track people from satellite or drone imagery.",
      403,
      false,
    );
  }
  const asset = CATALOG[assetId];
  if (!asset) {
    throw new EideticError(
      "POLICY_UNAVAILABLE",
      "Rasterio is not enabled. Later work can describe a site or asset. Person tracking stays out of scope.",
      501,
      false,
    );
  }
  return asset;
}

export class RasterioSiteContextPort {
  async describeAsset(assetId: string): Promise<SiteAsset> {
    return describeSiteAsset(assetId);
  }
}
