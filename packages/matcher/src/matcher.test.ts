// © Infinitum Corporation®. All rights reserved.

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FilesystemBiometricStore,
  InsightFaceAdapter,
  MemoryBiometricStore,
  MockMatcher,
  createMatcher,
  syntheticFixture,
} from "./index.js";
import { syntheticPortraitPng } from "./opencv-zoo.js";

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

  it("keeps mock as the default and refuses InsightFace or OpenCV without a license and a sidecar", () => {
    const store = new MemoryBiometricStore();
    expect(createMatcher({ mode: "mock", store }).model.mode).toBe("mock");
    expect(() => createMatcher({ mode: "insightface", store, licenseAccepted: true })).toThrow(/noncommercial/);
    expect(() => createMatcher({ mode: "mock", captureProvider: "opencv-mediapipe", store })).toThrow(/not bundled/);
  });

  it("sends only the synthetic fixture id to a licensed sidecar and drops embeddings", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.embedding) return new Response(JSON.stringify({ embedding: [1, 2, 3] }), { status: 200 });
      if (body.op === "quality") return new Response(JSON.stringify({ score: 0.88, accept: true, reasons: ["sidecar ok"] }), { status: 200 });
      if (body.op === "enroll") return new Response(JSON.stringify({ quality: 0.91 }), { status: 200 });
      return new Response(JSON.stringify({ scores: [{ cid: "cid://infinitum/fixture-avery-quinn", confidence: 0.93 }] }), { status: 200 });
    };
    const matcher = createMatcher({
      mode: "insightface",
      captureProvider: "opencv-mediapipe",
      store: new MemoryBiometricStore(),
      licenseAccepted: true,
      insightfaceUrl: "http://sidecar.internal/insightface",
      opencvMediapipeUrl: "http://sidecar.internal/quality",
      fetchImpl,
    });
    await expect(matcher.enroll(new Uint8Array(80))).rejects.toThrow(/Public-figure/);
    expect(bodies).toHaveLength(0);
    const enrolled = await matcher.enroll(syntheticFixture("avery-quinn"));
    const report = await matcher.match({
      probe: syntheticFixture("avery-quinn"),
      gallery: [{ cid: "cid://infinitum/fixture-avery-quinn", templateRef: enrolled.templateRef, recordAttributes: {} }],
      topK: 1,
    });
    expect(report.candidates[0].confidence).toBe(0.93);
    expect(report.quality.provider).toBe("opencv-mediapipe");
    expect(keysOf(report)).not.toContain("embedding");
    expect(JSON.stringify(bodies)).not.toContain("imageBase64");
    expect(bodies.some((body) => JSON.stringify(body).includes("avery-quinn"))).toBe(true);
  });

  it("runs the OpenCV Zoo adapter on synthetic portraits and keeps the embedding sealed", async () => {
    const store = new MemoryBiometricStore();
    let calls = 0;
    const matcher = createMatcher({
      mode: "opencv-zoo",
      store,
      zooInfer: {
        infer: async (image) => {
          calls += 1;
          const text = Buffer.from(image).toString("latin1");
          const id = text.split("eidetic-synthetic-portrait:")[1]?.slice(0, 12) ?? "unknown";
          const embedding = new Array(16).fill(0).map((_, index) => (id.charCodeAt(index % id.length) % 7) / 7);
          return { faceFound: true, detectorScore: 0.84, embedding };
        },
      },
    });
    await expect(matcher.enroll(syntheticFixture("avery-quinn"))).rejects.toThrow(/Public-figure|synthetic portrait/i);
    expect(calls).toBe(0);
    await expect(matcher.enroll(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).rejects.toThrow(/synthetic portrait|Public-figure/i);
    const enrolled = await matcher.enroll(syntheticPortraitPng("avery-quinn"));
    const report = await matcher.match({
      probe: syntheticPortraitPng("avery-quinn"),
      gallery: [{ cid: "cid://infinitum/fixture-avery-quinn", templateRef: enrolled.templateRef, recordAttributes: {} }],
      topK: 1,
    });
    expect(report.model.name).toBe("opencv-zoo-sface");
    expect(report.candidates[0].confidence).toBeGreaterThan(0.99);
    expect(keysOf(report)).not.toContain("embedding");
    const stored = JSON.parse(Buffer.from(await store.get(enrolled.templateRef)).toString("utf8")) as { embedding?: number[] };
    expect(stored.embedding?.length).toBe(16);
    expect(() => createMatcher({ mode: "opencv-zoo", store: new MemoryBiometricStore(), opencvZooModelDir: "/tmp/eidetic-missing-models" })).toThrow(/missing/);
  });
});
