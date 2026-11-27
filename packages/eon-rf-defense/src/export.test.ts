// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import {
  analyzeRun,
  digestLine,
  spoofedScenario,
  toCsv,
  toNdjson,
} from "./index.js";

const report = analyzeRun(spoofedScenario({ seed: 3, attackAt: 5, epochs: 10, stepMs: 1000 }));

describe("toNdjson", () => {
  it("emits one parseable JSON object per epoch", () => {
    const lines = toNdjson(report).split("\n");
    expect(lines).toHaveLength(report.epochs);
    const first = JSON.parse(lines[0]!);
    expect(first).toHaveProperty("t_ms");
    expect(first).toHaveProperty("state");
    expect(first).toHaveProperty("recommendation");
    expect(first).toHaveProperty("spoof_confidence");
    const anyDenied = lines.map((l) => JSON.parse(l)).some((r) => r.state === "DENIED");
    expect(anyDenied).toBe(true);
  });
});

describe("toCsv", () => {
  it("has a header and one row per epoch", () => {
    const rows = toCsv(report).split("\n");
    expect(rows[0]).toBe("t_ms,state,recommendation,spoof_confidence,jam_confidence,summary");
    expect(rows).toHaveLength(report.epochs + 1);
  });

  it("quotes and escapes summaries containing commas/quotes", () => {
    const csv = toCsv(report);
    const body = csv.split("\n").slice(1);
    // Comma-bearing summaries (e.g. DENIED "Indicators: a, b") must be quoted;
    // comma-less ones (nominal "...; ...") are left bare. At least one is quoted.
    expect(body.some((row) => /,"/.test(row))).toBe(true);
    // Round-trip a tricky value through the escaper via a crafted report.
    const tricky = {
      ...report,
      timeline: [
        {
          ...report.timeline[0]!,
          summary: 'has "quotes", and commas',
        },
      ],
      epochs: 1,
    };
    const line = toCsv(tricky).split("\n")[1]!;
    expect(line.endsWith('"has ""quotes"", and commas"')).toBe(true);
  });
});

describe("digestLine", () => {
  it("summarises the run on one line", () => {
    const d = digestLine(report);
    expect(d).toMatch(/^\[EON-PNT\] epochs=10/);
    expect(d).toMatch(/threat=spoofing/);
    expect(d).toMatch(/firstDenied=\d+/);
  });
});
