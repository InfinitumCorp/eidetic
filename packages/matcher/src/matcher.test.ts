// © Infinitum Corporation®. All rights reserved.

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FilesystemBiometricStore,
  InsightFaceAdapter,
  MemoryBiometricStore,
  MockMatcher,
  syntheticFixture,
} from "./index.js";

function keysOf(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, found));
  else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      found.push(key);
      keysOf(nested, found);
    }
  }
  return found;
}

describe("mock matcher", () => {
  it("scores a matching synthetic fixture high and a different fixture low", async () => {
    const matcher = new MockMatcher(new MemoryBiometricStore());
    const avery = await matcher.enroll(syntheticFixture("avery-quinn"));
    const jordan = await matcher.enroll(syntheticFixture("jordan-blake"));
    const report = await matcher.match({
      probe: syntheticFixture("avery-quinn"),
      gallery: [
        { cid: "cid://infinitum/fixture-avery-quinn", templateRef: avery.templateRef, recordAttributes: { employeeId: "WQ-1044" } },
        { cid: "cid://infinitum/fixture-jordan-blake", templateRef: jordan.templateRef, recordAttributes: { employeeId: "WQ-2281" } },
      ],
      topK: 2,
      recordHints: { employeeId: "WQ-1044" },
    });
    expect(report.candidates[0]).toMatchObject({ cid: "cid://infinitum/fixture-avery-quinn", confidence: 0.97, rank: 1 });
    expect(report.candidates[1].confidence).toBe(0.18);
    expect(report.candidates[1].evidence.some((item) => item.kind === "alternative")).toBe(true);
    expect(report.candidates[0].evidence.some((item) => item.kind === "record_attribute")).toBe(true);
    expect(keysOf(report)).not.toContain("embedding");
    expect(keysOf(report)).not.toContain("templateRef");
  });

  it("rejects a tiny capture and purges a template", async () => {
    const matcher = new MockMatcher(new MemoryBiometricStore());
    await expect(matcher.enroll(new Uint8Array(8))).rejects.toThrow(/too small/);
    const enrolled = await matcher.enroll(syntheticFixture("avery-quinn"));
    await matcher.purge(enrolled.templateRef);
    const report = await matcher.match({
      probe: syntheticFixture("avery-quinn"),
      gallery: [{ cid: "cid://infinitum/fixture-avery-quinn", templateRef: enrolled.templateRef, recordAttributes: {} }],
      topK: 1,
    });
    expect(report.candidates).toEqual([]);
  });

  it("rejects path traversal in the filesystem store", async () => {
    const store = new FilesystemBiometricStore(path.join(os.tmpdir(), "eidetic-templates"));
    await expect(store.put("templates/../../etc/passwd", new Uint8Array([1]))).rejects.toThrow(/rejected/);
  });

  it("does not call InsightFace without a license and an injected client", async () => {
    let calls = 0;
    const client = {
      enroll: () => {
        calls += 1;
        return Promise.resolve({ templateRef: "templates/licensed", quality: 1 });
      },
      match: () => {
        calls += 1;
        return Promise.reject(new Error("unused"));
      },
    };
    const locked = new InsightFaceAdapter({ licenseAccepted: false, client });
    await expect(locked.enroll(syntheticFixture("avery-quinn"))).rejects.toThrow(/noncommercial/);
    expect(calls).toBe(0);
    const open = new InsightFaceAdapter({ licenseAccepted: true, client });
    await expect(open.enroll(syntheticFixture("avery-quinn"))).resolves.toMatchObject({ templateRef: "templates/licensed" });
    expect(calls).toBe(1);
  });
});
