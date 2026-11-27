// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { EideticError } from "@eidetic/contracts";
import { enforceRfRequest, evaluateRfRequest } from "./index.js";

describe("evaluateRfRequest", () => {
  it("allows passive/defensive actions", () => {
    const d = evaluateRfRequest("assess pnt integrity and recommend fallback");
    expect(d.allow).toBe(true);
    expect(d.httpStatus).toBe(200);
    expect(d.code).toBeUndefined();
  });

  it("denies offensive / interception actions with a shared denial code", () => {
    for (const req of ["jam the band", "spoof the fix", "intercept comms", "run elint"]) {
      const d = evaluateRfRequest(req);
      expect(d.allow).toBe(false);
      expect(d.code).toBe("FORBIDDEN");
      expect(d.httpStatus).toBe(403);
      expect(d.reason).toMatch(/does not transmit|Refused/i);
    }
  });
});

describe("enforceRfRequest", () => {
  it("returns the cleaned request when allowed", () => {
    expect(enforceRfRequest("  monitor gnss  ")).toBe("monitor gnss");
  });

  it("throws EideticError when denied", () => {
    expect(() => enforceRfRequest("jam uplink")).toThrow(EideticError);
  });
});
