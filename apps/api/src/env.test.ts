// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { readSearchLimit } from "./env.js";

describe("SEARCH_LIMIT_PER_HOUR", () => {
  it("defaults to 120, accepts 0 to turn it off, and rejects anything else", () => {
    expect(readSearchLimit(undefined)).toBe(120);
    expect(readSearchLimit(" ")).toBe(120);
    expect(readSearchLimit("0")).toBe(0);
    expect(readSearchLimit("30")).toBe(30);
    expect(() => readSearchLimit("-1")).toThrow(/whole number/);
    expect(() => readSearchLimit("2.5")).toThrow(/whole number/);
    expect(() => readSearchLimit("lots")).toThrow(/whole number/);
  });
});
