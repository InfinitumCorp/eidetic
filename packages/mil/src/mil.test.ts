// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { evaluateMilEdition, refuseMilitaryWorkflow } from "./index.js";

describe("ei·det·ic MIL™ boundary", () => {
  it("lets civilian and business editions through", () => {
    expect(evaluateMilEdition("business", false)).toEqual({ blocked: false });
    expect(evaluateMilEdition("civilian", true)).toEqual({ blocked: false });
  });

  it("fails closed when the edition is MIL, whether or not the flag is on", () => {
    expect(evaluateMilEdition("mil", false).blocked).toBe(true);
    expect(evaluateMilEdition("mil", false)).toMatchObject({ code: "MIL_NOT_ENABLED" });
    expect(evaluateMilEdition("mil", true)).toMatchObject({ code: "MIL_NOT_IMPLEMENTED" });
    expect(() => refuseMilitaryWorkflow()).toThrow(/not implemented/);
  });
});
