// © Infinitum Corporation®. All rights reserved.
// Self-hosted capture-quality gate. MediaPipe answers face presence.
// OpenCV answers blur. Nothing from this check is written to disk.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EideticError } from "@eidetic/contracts";
import { syntheticPortraitFixtureId } from "./opencv-zoo.js";
import type { CaptureQuality } from "./index.js";

export const MEDIAPIPE_MODEL_FILE = "blaze_face_short_range.tflite";
export const DEFAULT_MEDIAPIPE_MODEL_PATH = path.join("data", "models", "mediapipe", MEDIAPIPE_MODEL_FILE);
export const MEDIAPIPE_MIN_DETECTION_SCORE = 0.5;
export const MEDIAPIPE_MIN_LAPLACIAN_VARIANCE = 12;

const REFUSAL =
  "This capture check accepts an EIDETIC-SYNTHETIC-v1 fixture or a synthetic portrait. Other photographs are refused unless EIDETIC_ALLOW_OPERATOR_CAPTURES=true. Public-figure biometrics are refused.";

const GEOMETRY_KEYS = ["embedding", "landmarks", "keypoints", "boundingBox", "bounding_box", "boundingBoxes", "detections", "image", "imageBase64"];

export interface MediaPipeSignals {
  decoded: boolean;
  faceCount: number;
  topScore: number;
  blurVariance: number;
}

export function readMediaPipeSignals(body: unknown): MediaPipeSignals {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EideticError("CAPTURE_REJECTED", "MediaPipe returned an unreadable quality result.", 502, false);
  }
  const record = body as Record<string, unknown>;
  if (GEOMETRY_KEYS.some((key) => key in record)) {
    throw new EideticError(
      "BIOMETRIC_PAYLOAD_REFUSED",
      "The MediaPipe quality check returned face geometry or an embedding. ei·det·ic™ keeps only a presence score and a blur score.",
      502,
      false,
    );
  }
  const { decoded, faceCount, topScore, blurVariance } = record;
  if (typeof decoded !== "boolean" || typeof faceCount !== "number" || typeof topScore !== "number" || typeof blurVariance !== "number") {
    throw new EideticError("CAPTURE_REJECTED", "MediaPipe returned an unreadable quality result.", 502, false);
  }
  if (!Number.isInteger(faceCount) || faceCount < 0 || faceCount > 32 || !Number.isFinite(topScore) || !Number.isFinite(blurVariance) || blurVariance < 0) {
    throw new EideticError("CAPTURE_REJECTED", "MediaPipe returned an unreadable quality result.", 502, false);
  }
  return {
    decoded,
    faceCount,
    topScore: Math.max(0, Math.min(1, topScore)),
    blurVariance,
  };
}

/**
 * Presence and blur only. A passing score does not identify a person.
 * One face is required so an enrollment frame is a single subject.
 */
export function qualityFromSignals(signals: MediaPipeSignals): CaptureQuality {
  if (!signals.decoded) {
    return {
      score: 0,
      accept: false,
      provider: "opencv-mediapipe",
      reasons: ["OpenCV could not decode the capture."],
    };
  }
  if (signals.faceCount === 0 || signals.topScore < MEDIAPIPE_MIN_DETECTION_SCORE) {
    return {
      score: round4(signals.topScore),
      accept: false,
      provider: "opencv-mediapipe",
      reasons: ["MediaPipe did not find a face above the capture threshold. The enroll stopped. This check does not identify anyone."],
    };
  }
  if (signals.faceCount > 1) {
    return {
      score: 0,
      accept: false,
      provider: "opencv-mediapipe",
      reasons: ["MediaPipe found more than one face. Enrollment capture expects a single subject."],
    };
  }
  if (signals.blurVariance < MEDIAPIPE_MIN_LAPLACIAN_VARIANCE) {
    return {
      score: round4(Math.min(0.4, signals.topScore * 0.4)),
      accept: false,
      provider: "opencv-mediapipe",
      reasons: ["OpenCV Laplacian variance is too low. The capture is too soft for the quality gate."],
    };
  }
  const blurTerm = Math.max(0, Math.min(1, signals.blurVariance / 100));
  const score = round4(Math.max(0, Math.min(1, 0.5 * signals.topScore + 0.5 * blurTerm)));
  return {
    score,
    accept: true,
    provider: "opencv-mediapipe",
    reasons: [
      `MediaPipe face detector found one face at confidence ${signals.topScore.toFixed(2)}. This is a presence check, not an identity match.`,
      `OpenCV Laplacian variance ${signals.blurVariance.toFixed(1)} passed the blur gate.`,
    ],
  };
}

export class LocalOpenCvMediaPipeQualityGate {
  readonly provider = "opencv-mediapipe" as const;

  constructor(
    private readonly options: {
      signals: (image: Uint8Array) => Promise<unknown>;
      allowOperatorCaptures?: boolean;
      readFixtureId: (image: Uint8Array) => string | null;
    },
  ) {}

  async assess(image: Uint8Array): Promise<CaptureQuality> {
    if (image.length < 64) {
      return {
        score: 0,
        accept: false,
        provider: "opencv-mediapipe",
        reasons: ["Capture is too small for the MediaPipe quality gate."],
      };
    }
    if (image.length > 512 * 1024) {
      return {
        score: 0,
        accept: false,
        provider: "opencv-mediapipe",
        reasons: ["Capture exceeds the 512KB sealed-boundary limit."],
      };
    }
    if (this.options.readFixtureId(image)) {
      return {
        score: 0.9,
        accept: true,
        provider: "opencv-mediapipe",
        reasons: ["Synthetic fixture accepted. MediaPipe did not run because this token is not an image. This is not a face detection."],
      };
    }
    const portrait = syntheticPortraitFixtureId(image);
    const operatorImage = this.options.allowOperatorCaptures === true && (isPng(image) || isJpeg(image));
    if (!portrait && !operatorImage) {
      throw new EideticError("CAPTURE_REJECTED", REFUSAL, 422, false);
    }
    return qualityFromSignals(readMediaPipeSignals(await this.options.signals(image)));
  }
}

export function pythonMediaPipeSignals(modelPath: string, pythonBinary = "python3"): (image: Uint8Array) => Promise<unknown> {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../python/opencv_mediapipe_quality.py");
  return (image) =>
    runPython(
      pythonBinary,
      script,
      JSON.stringify({
        modelPath,
        imageBase64: Buffer.from(image).toString("base64"),
      }),
    );
}

function runPython(pythonBinary: string, script: string, payload: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBinary, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GLOG_minloglevel: "3",
        TF_CPP_MIN_LOG_LEVEL: "3",
        ABSL_MIN_LOG_LEVEL: "3",
        MEDIAPIPE_DISABLE_GPU: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let tooLarge = false;
    let settled = false;
    const timer = setTimeout(() => child.kill(), 20000);
    const finish = (error: EideticError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 65536) {
        tooLarge = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      finish(new EideticError("CAPTURE_REJECTED", "Python could not start for the local MediaPipe quality check.", 501, false));
    });
    child.on("close", (code) => {
      if (tooLarge || code !== 0) {
        finish(new EideticError("CAPTURE_REJECTED", failureMessage(stderr), code === 0 ? 502 : 501, false));
        return;
      }
      const line = stdout
        .split("\n")
        .map((item) => item.trim())
        .filter((item) => item.startsWith("{"))
        .at(-1);
      if (!line) {
        finish(new EideticError("CAPTURE_REJECTED", "MediaPipe returned an unreadable quality result.", 502, false));
        return;
      }
      try {
        finish(null, JSON.parse(line) as unknown);
      } catch {
        finish(new EideticError("CAPTURE_REJECTED", "MediaPipe returned an unreadable quality result.", 502, false));
      }
    });
    child.stdin.end(payload);
  });
}

function failureMessage(stderr: string): string {
  if (stderr.includes("model path must be a local file")) {
    return "MediaPipe model path must be a local file. Remote model URLs are refused.";
  }
  if (stderr.includes("No module named 'mediapipe'") || stderr.includes("No module named mediapipe")) {
    return "MediaPipe is not installed for this Python. Install packages/matcher/python/requirements-mediapipe.txt. The check runs locally and does not call Google Cloud.";
  }
  if (stderr.includes("No module named 'cv2'") || stderr.includes("No module named cv2")) {
    return "OpenCV is not installed for this Python. The mediapipe package brings it in.";
  }
  if (stderr.includes("libEGL")) {
    return "MediaPipe could not load its local graphics library. Install libegl1 and libgl1, then retry. This is not a Google Cloud call.";
  }
  return "MediaPipe quality check failed.";
}

function isPng(image: Uint8Array): boolean {
  return image.length > 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
}

function isJpeg(image: Uint8Array): boolean {
  return image.length > 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
