// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { RasterioSiteContextPort, SEAMS, attestConsentHash } from "./index.js";

describe("integration seams", () => {
  it("accepts only a hash for the $EIDT stub", () => {
    const receipt = attestConsentHash("a".repeat(64));
    expect(receipt.broadcast).toBe(false);
    expect(receipt.asset).toBe("EIDT");
    expect(() => attestConsentHash("not-a-hash")).toThrow(/Biometric payloads are refused/);
    expect(SEAMS.map((seam) => seam.system)).toEqual(["HRVST", "SPECTRE", "METATRON", "VEIL", "FIRMAMENT", "ODIN"]);
  });

  it("refuses person tracking on the Rasterio site adapter", async () => {
    const port = new RasterioSiteContextPort();
    await expect(port.describeAsset("drone-follow-person")).rejects.toThrow(/does not track people/);
    await expect(port.describeAsset("warehouse-roof")).rejects.toThrow(/not enabled/);
  });
});
