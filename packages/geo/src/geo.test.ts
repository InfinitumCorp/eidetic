// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { RasterioSiteContextPort, describeSiteAsset } from "./index.js";

describe("site context", () => {
  it("returns an office asset and refuses person tracking", async () => {
    expect(describeSiteAsset("hq-washington").kind).toBe("building");
    expect(describeSiteAsset("hq-washington").note).toMatch(/no person track/i);
    const port = new RasterioSiteContextPort();
    await expect(port.describeAsset("drone-follow-person")).rejects.toThrow(/does not track people/);
    await expect(port.describeAsset("warehouse-roof")).rejects.toThrow(/not enabled/);
  });
});
