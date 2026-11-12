// © Infinitum Corporation®. All rights reserved.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryBiometricStore, createMatcher, syntheticFixture } from "./index.js";
import { qualityFromSignals, readMediaPipeSignals } from "./opencv-mediapipe.js";
import { syntheticPortraitPng } from "./opencv-zoo.js";

const script = fileURLToPath(new URL("../python/opencv_mediapipe_quality.py", import.meta.url));

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

function jpegBytes(): Uint8Array {
  const bytes = new Uint8Array(80);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0x00;
  for (let index = 4; index < bytes.length; index += 1) bytes[index] = (index * 17) % 255;
  return bytes;
}

function runScript(payload: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("local opencv-mediapipe capture gate", () => {
  it("scores one sharp face and keeps geometry out of the report and the template", async () => {
    const seen: Uint8Array[] = [];
    const fetchImpl = () => {
      throw new Error("network");
    };
    const store = new MemoryBiometricStore();
    const matcher = createMatcher({
      mode: "mock",
      captureProvider: "opencv-mediapipe",
      store,
      fetchImpl,
      mediapipeSignals: async (image) => {
        seen.push(image);
        return { decoded: true, faceCount: 1, topScore: 0.91, blurVariance: 48 };
      },
    });
    const portrait = syntheticPortraitPng("avery-quinn");
    const enrolled = await matcher.enroll(portrait);
    expect(enrolled.quality).toBeCloseTo(0.5 * 0.91 + 0.5 * 0.48, 4);
    expect(seen).toHaveLength(1);
    const report = await matcher.match({
      probe: portrait,
      gallery: [{ cid: "cid://infinitum/fixture-avery-quinn", templateRef: enrolled.templateRef, recordAttributes: {} }],
      topK: 1,
    });
    expect(report.quality.provider).toBe("opencv-mediapipe");
    expect(report.quality.accept).toBe(true);
    expect(report.quality.reasons[0]).toMatch(/presence check/);
    expect(report.candidates[0].evidence.find((item) => item.kind === "capture_quality")?.summary).toMatch(/presence check/);
    const names = keysOf(report);
    expect(names).not.toContain("embedding");
    expect(names).not.toContain("landmarks");
    expect(names).not.toContain("keypoints");
    expect(names).not.toContain("boundingBox");
    const stored = JSON.parse(Buffer.from(await store.get(enrolled.templateRef)).toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["embedding", "fixtureId", "v"]);
  });

  it("accepts a synthetic fixture token without calling MediaPipe", async () => {
    let calls = 0;
    const matcher = createMatcher({
      mode: "mock",
      captureProvider: "opencv-mediapipe",
      store: new MemoryBiometricStore(),
      mediapipeSignals: async () => {
        calls += 1;
        return { decoded: false, faceCount: 0, topScore: 0, blurVariance: 0 };
      },
    });
    const enrolled = await matcher.enroll(syntheticFixture("avery-quinn"));
    expect(enrolled.quality).toBe(0.9);
    expect(calls).toBe(0);
    const report = await matcher.match({
      probe: syntheticFixture("avery-quinn"),
      gallery: [{ cid: "cid://infinitum/fixture-avery-quinn", templateRef: enrolled.templateRef, recordAttributes: {} }],
      topK: 1,
    });
    expect(report.quality.reasons[0]).toMatch(/did not run/);
    expect(report.candidates[0].confidence).toBe(0.97);
  });

  it("rejects a missing face, a second face, a soft frame, and an undecodable image", async () => {
    const cases = [
      { signals: { decoded: true, faceCount: 0, topScore: 0.2, blurVariance: 40 }, message: /did not find a face/ },
      { signals: { decoded: true, faceCount: 2, topScore: 0.8, blurVariance: 40 }, message: /more than one face/ },
      { signals: { decoded: true, faceCount: 1, topScore: 0.8, blurVariance: 3 }, message: /Laplacian/ },
      { signals: { decoded: false, faceCount: 0, topScore: 0, blurVariance: 0 }, message: /could not decode/ },
    ];
    for (const item of cases) {
      const matcher = createMatcher({
        mode: "mock",
        captureProvider: "opencv-mediapipe",
        store: new MemoryBiometricStore(),
        mediapipeSignals: async () => item.signals,
      });
      await expect(matcher.enroll(syntheticPortraitPng("avery-quinn"))).rejects.toThrow(item.message);
    }
  });

  it("refuses a photograph that is not a synthetic portrait, and allows one only when the operator flag is on", async () => {
    let calls = 0;
    const locked = createMatcher({
      mode: "mock",
      captureProvider: "opencv-mediapipe",
      store: new MemoryBiometricStore(),
      mediapipeSignals: async () => {
        calls += 1;
        return { decoded: true, faceCount: 1, topScore: 0.9, blurVariance: 40 };
      },
    });
    await expect(locked.enroll(jpegBytes())).rejects.toThrow(/Public-figure/);
    expect(calls).toBe(0);
    const open = createMatcher({
      mode: "mock",
      captureProvider: "opencv-mediapipe",
      store: new MemoryBiometricStore(),
      allowOperatorCaptures: true,
      mediapipeSignals: async () => {
        calls += 1;
        return { decoded: true, faceCount: 1, topScore: 0.9, blurVariance: 40 };
      },
    });
    await expect(open.enroll(jpegBytes())).resolves.toMatchObject({ quality: expect.any(Number) });
    expect(calls).toBe(1);
  });

  it("refuses face geometry or an embedding from the detector", async () => {
    const matcher = createMatcher({
      mode: "mock",
      captureProvider: "opencv-mediapipe",
      store: new MemoryBiometricStore(),
      mediapipeSignals: async () => ({ decoded: true, faceCount: 1, topScore: 0.9, blurVariance: 40, keypoints: [{ x: 0.2, y: 0.3 }] }),
    });
    await expect(matcher.enroll(syntheticPortraitPng("avery-quinn"))).rejects.toThrow(/face geometry or an embedding/);
    expect(() => readMediaPipeSignals({ decoded: true, faceCount: 1, topScore: 0.9, blurVariance: 4, embedding: [0.1] })).toThrow(/embedding/);
  });

  it("rejects a tiny capture before the detector runs", async () => {
    let calls = 0;
    const matcher = createMatcher({
      mode: "mock",
      captureProvider: "opencv-mediapipe",
      store: new MemoryBiometricStore(),
      mediapipeSignals: async () => {
        calls += 1;
        return { decoded: true, faceCount: 1, topScore: 1, blurVariance: 40 };
      },
    });
    await expect(matcher.enroll(new Uint8Array(8))).rejects.toThrow(/too small/);
    expect(calls).toBe(0);
  });

  it("turns detector signals into a presence score", () => {
    expect(qualityFromSignals({ decoded: true, faceCount: 1, topScore: 0.5, blurVariance: 12 })).toMatchObject({ accept: true, score: 0.31 });
    expect(qualityFromSignals({ decoded: true, faceCount: 1, topScore: 0.49, blurVariance: 80 }).accept).toBe(false);
    expect(qualityFromSignals({ decoded: true, faceCount: 1, topScore: 1, blurVariance: 100 })).toMatchObject({ accept: true, score: 1 });
  });

  it("refuses a remote model URL before importing MediaPipe", async () => {
    const result = await runScript({
      modelPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range.tflite",
      imageBase64: Buffer.from("not-a-face").toString("base64"),
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/local file/);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/not-a-face/);
  });

  it("runs BlazeFace on a synthetic portrait when the local model and package are installed", async () => {
    const model = process.env.OPENCV_MEDIAPIPE_MODEL_PATH ?? path.join(os.tmpdir(), "eidetic-missing-blaze-face.tflite");
    const python = process.env.OPENCV_MEDIAPIPE_PYTHON ?? "python3";
    if (!existsSync(model)) return;
    const ready = await new Promise<boolean>((resolve) => {
      const child = spawn(python, ["-c", "import mediapipe, cv2"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (!ready) return;
    const matcher = createMatcher({
      mode: "mock",
      captureProvider: "opencv-mediapipe",
      store: new MemoryBiometricStore(),
      opencvMediapipeModelPath: model,
      opencvMediapipePython: python,
    });
    await expect(matcher.enroll(syntheticPortraitPng("avery-quinn"))).rejects.toThrow(/did not find a face|could not decode/);
  });
});
