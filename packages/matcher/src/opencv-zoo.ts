// © Infinitum Corporation®. All rights reserved.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EideticError, type EvidenceItem } from "@eidetic/contracts";
import type { BiometricStore, EnrollResult, MatchReport, MatchRequest, MatcherAdapter, MatcherModel } from "./index.js";

const PORTRAIT_MARKER = "eidetic-synthetic-portrait:";
const YUNET_FILE = "face_detection_yunet_2023mar.onnx";
const SFACE_FILE = "face_recognition_sface_2021dec.onnx";

export const OPENCV_ZOO_LICENSE_NOTE =
  "YuNet weights in opencv_zoo/models/face_detection_yunet are published under MIT (Copyright Shiqi Yu). SFace weights in opencv_zoo/models/face_recognition_sface are published under Apache-2.0. Both grants allow commercial use of those files. Training-image provenance is a separate question and is noted in NOTICE. InsightFace weights are not used.";

export interface ZooInferenceResult {
  faceFound: boolean;
  detectorScore: number;
  embedding: number[] | null;
}

export interface ZooInference {
  infer(image: Uint8Array): Promise<ZooInferenceResult>;
}

export function syntheticPortraitPng(fixtureId: string): Uint8Array {
  if (!/^[a-z0-9-]{3,64}$/.test(fixtureId)) {
    throw new EideticError("VALIDATION", "Synthetic portrait ids use lowercase letters, numbers, and hyphens.", 422, false);
  }
  return pngRgb(8, 8, fixtureId);
}

export function syntheticPortraitFixtureId(image: Uint8Array): string | null {
  const text = Buffer.from(image).toString("latin1");
  const at = text.indexOf(PORTRAIT_MARKER);
  if (at < 0) return null;
  const id = text.slice(at + PORTRAIT_MARKER.length).split(/[^a-z0-9-]/)[0] ?? "";
  return /^[a-z0-9-]{3,64}$/.test(id) ? id : null;
}

export class OpenCvZooMatcher implements MatcherAdapter {
  readonly model: MatcherModel = { name: "opencv-zoo-sface", version: "2021dec", mode: "opencv-zoo" };

  constructor(
    private readonly options: {
      store: BiometricStore;
      infer: ZooInference;
      allowOperatorCaptures?: boolean;
      ids?: () => string;
    },
  ) {}

  assess(image: Uint8Array) {
    if (!acceptedImage(image, this.options.allowOperatorCaptures === true)) {
      return {
        score: 0,
        accept: false,
        provider: "local-statistical" as const,
        reasons: [
          "OpenCV Zoo accepts a synthetic portrait PNG, or an operator capture when that flag is on. Fixture tokens stay on the mock matcher. Public-figure photographs are refused.",
        ],
      };
    }
    return {
      score: 0.8,
      accept: true,
      provider: "local-statistical" as const,
      reasons: [OPENCV_ZOO_LICENSE_NOTE],
    };
  }

  async enroll(image: Uint8Array): Promise<EnrollResult> {
    const quality = this.assess(image);
    if (!quality.accept) throw new EideticError("CAPTURE_REJECTED", quality.reasons.join(" "), 422, false);
    const inferred = await this.options.infer.infer(image);
    if (!inferred.faceFound || !inferred.embedding || inferred.embedding.length < 8 || inferred.embedding.some((value) => typeof value !== "number")) {
      throw new EideticError("CAPTURE_REJECTED", "YuNet did not find a face in this synthetic image. The enroll stopped.", 422, false);
    }
    const templateRef = `templates/${(this.options.ids ?? randomId)()}`;
    const payload = {
      v: 2,
      provider: this.model.name,
      fixtureId: syntheticPortraitFixtureId(image),
      embedding: inferred.embedding,
    };
    await this.options.store.put(templateRef, Buffer.from(JSON.stringify(payload)));
    return { templateRef, quality: inferred.detectorScore || quality.score };
  }

  async match(request: MatchRequest): Promise<MatchReport> {
    const quality = this.assess(request.probe);
    if (!quality.accept) throw new EideticError("CAPTURE_REJECTED", quality.reasons.join(" "), 422, false);
    const inferred = await this.options.infer.infer(request.probe);
    if (!inferred.faceFound || !inferred.embedding) {
      throw new EideticError("CAPTURE_REJECTED", "YuNet did not find a face in the probe. The match did not continue.", 422, false);
    }
    const scored: Array<{ cid: string; confidence: number; evidence: EvidenceItem[] }> = [];
    for (const member of request.gallery) {
      let stored: { embedding?: number[] } | null = null;
      try {
        stored = JSON.parse(Buffer.from(await this.options.store.get(member.templateRef)).toString("utf8")) as { embedding?: number[] };
      } catch {
        continue;
      }
      if (!stored.embedding) continue;
      const confidence = round4(cosine(inferred.embedding, stored.embedding));
      scored.push({
        cid: member.cid,
        confidence,
        evidence: [
          {
            kind: "template_similarity",
            summary: `SFace cosine ${confidence.toFixed(2)} computed inside the matcher. The embedding stays in the sealed store.`,
            weight: confidence,
          },
        ],
      });
    }
    scored.sort((left, right) => right.confidence - left.confidence);
    return {
      model: this.model,
      quality,
      candidates: scored.slice(0, request.topK).map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    };
  }

  async purge(templateRef: string): Promise<void> {
    await this.options.store.delete(templateRef);
  }
}

export function pythonOpenCvZooInference(modelDir: string, pythonBinary = "python3"): ZooInference {
  const yunet = path.join(modelDir, YUNET_FILE);
  const sface = path.join(modelDir, SFACE_FILE);
  if (!existsSync(yunet) || !existsSync(sface)) {
    throw new EideticError(
      "CAPTURE_REJECTED",
      `OpenCV Zoo models are missing in ${modelDir}. Run pnpm matcher:fetch-models. ${OPENCV_ZOO_LICENSE_NOTE}`,
      501,
      false,
    );
  }
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../python/opencv_zoo_infer.py");
  return {
    infer(image: Uint8Array) {
      return runPython(pythonBinary, script, JSON.stringify({
        yunet,
        sface,
        imageBase64: Buffer.from(image).toString("base64"),
      }));
    },
  };
}

function runPython(pythonBinary: string, script: string, payload: string): Promise<ZooInferenceResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBinary, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => reject(new EideticError("CAPTURE_REJECTED", "Python could not start for the OpenCV Zoo sidecar.", 501, false)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new EideticError("CAPTURE_REJECTED", "OpenCV Zoo inference failed.", 502, false));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as ZooInferenceResult;
        resolve({
          faceFound: parsed.faceFound === true,
          detectorScore: typeof parsed.detectorScore === "number" ? parsed.detectorScore : 0,
          embedding: Array.isArray(parsed.embedding) ? parsed.embedding : null,
        });
      } catch {
        reject(new EideticError("CAPTURE_REJECTED", "OpenCV Zoo inference returned an unreadable result.", 502, false));
      }
    });
    child.stdin.end(payload);
  });
}

export function assertOpenCvZooModels(modelDir: string): void {
  pythonOpenCvZooInference(modelDir);
}

function acceptedImage(image: Uint8Array, allowOperatorCaptures: boolean): boolean {
  if (Buffer.from(image.subarray(0, 23)).toString("utf8").startsWith("EIDETIC-SYNTHETIC-v1")) return false;
  if (syntheticPortraitFixtureId(image)) return true;
  if (!allowOperatorCaptures) return false;
  return isPng(image) || isJpeg(image);
}

function isPng(image: Uint8Array): boolean {
  return image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
}

function isJpeg(image: Uint8Array): boolean {
  return image.length > 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
}

function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (!denom) return 0;
  return Math.max(0, Math.min(1, dot / denom));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function randomId(): string {
  return Math.random().toString(16).slice(2).padEnd(16, "0");
}

function pngRgb(width: number, height: number, fixtureId: string): Uint8Array {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = (x * 30 + fixtureId.charCodeAt(0)) % 255;
      raw[pixel + 1] = (y * 20 + fixtureId.charCodeAt(1)) % 255;
      raw[pixel + 2] = 180;
    }
  }
  const compressed = zlib.deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const text = Buffer.from(`Comment\0${PORTRAIT_MARKER}${fixtureId}`, "latin1");
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("tEXt", text),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
