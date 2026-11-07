// © Infinitum Corporation®. All rights reserved.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EideticError, type EvidenceItem } from "@eidetic/contracts";

export interface MatcherModel {
  name: string;
  version: string;
  mode: "mock" | "insightface";
}

export interface CaptureQuality {
  score: number;
  accept: boolean;
  reasons: string[];
  provider: "local-statistical" | "opencv-mediapipe";
}

export interface GalleryMember {
  cid: string;
  templateRef: string;
  recordAttributes: Record<string, string>;
}

export interface MatchRequest {
  probe: Uint8Array;
  gallery: GalleryMember[];
  topK: number;
  recordHints?: Record<string, string>;
}

export interface MatchCandidate {
  cid: string;
  confidence: number;
  rank: number;
  evidence: EvidenceItem[];
}

export interface MatchReport {
  model: MatcherModel;
  candidates: MatchCandidate[];
  quality: CaptureQuality;
}

export interface EnrollResult {
  templateRef: string;
  quality: number;
}

export interface MatcherAdapter {
  readonly model: MatcherModel;
  assess(image: Uint8Array): CaptureQuality;
  enroll(image: Uint8Array): Promise<EnrollResult>;
  match(request: MatchRequest): Promise<MatchReport>;
  purge(templateRef: string): Promise<void>;
}

export interface InsightFaceClient {
  enroll(image: Uint8Array): Promise<EnrollResult>;
  match(request: MatchRequest): Promise<MatchReport>;
}

export interface BiometricStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

const FIXTURE_PREFIX = "EIDETIC-SYNTHETIC-v1\n";

export function syntheticFixture(fixtureId: string): Uint8Array {
  if (!/^[a-z0-9-]{3,64}$/.test(fixtureId)) {
    throw new EideticError("VALIDATION", "Synthetic fixture ids use lowercase letters, numbers, and hyphens.", 422, false);
  }
  const header = `${FIXTURE_PREFIX}${fixtureId}\n`;
  const bytes = new Uint8Array(header.length + 128);
  for (let index = 0; index < header.length; index += 1) bytes[index] = header.charCodeAt(index);
  let hash = 2166136261;
  for (const char of fixtureId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  for (let index = 0; index < 128; index += 1) {
    hash = Math.imul(hash ^ (index + 1), 16777619);
    bytes[header.length + index] = (hash >>> 24) & 0xff;
  }
  return bytes;
}

export function readFixtureId(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 96)).toString("utf8");
  if (!head.startsWith(FIXTURE_PREFIX)) return null;
  const id = head.slice(FIXTURE_PREFIX.length).split("\n")[0] ?? "";
  return /^[a-z0-9-]{3,64}$/.test(id) ? id : null;
}

/**
 * Local stand-in for an OpenCV Laplacian-variance check and a MediaPipe
 * face-presence check. It does not claim to have found a face.
 */
export function assessCaptureQuality(bytes: Uint8Array): CaptureQuality {
  if (bytes.length < 64) {
    return {
      score: 0,
      accept: false,
      provider: "local-statistical",
      reasons: ["Capture is too small for the local quality gate."],
    };
  }
  if (bytes.length > 512 * 1024) {
    return {
      score: 0,
      accept: false,
      provider: "local-statistical",
      reasons: ["Capture exceeds the 512KB sealed-boundary limit."],
    };
  }
  if (readFixtureId(bytes)) {
    return {
      score: 0.9,
      accept: true,
      provider: "local-statistical",
      reasons: ["Synthetic fixture accepted by the local quality gate. This is not a face detection."],
    };
  }
  let sum = 0;
  for (const value of bytes) sum += value;
  const mean = sum / bytes.length;
  let variance = 0;
  for (const value of bytes) variance += (value - mean) ** 2;
  variance /= bytes.length;
  if (variance < 8) {
    return {
      score: 0.1,
      accept: false,
      provider: "local-statistical",
      reasons: ["Capture contrast is too low for the local statistical gate."],
    };
  }
  return {
    score: 0.7,
    accept: true,
    provider: "local-statistical",
    reasons: ["Local statistical contrast passed. OpenCV and MediaPipe are not installed."],
  };
}

export class OpenCvMediaPipeQualityGate {
  assess(): CaptureQuality {
    throw new EideticError(
      "CAPTURE_REJECTED",
      "OpenCV and MediaPipe are optional sealed-boundary adapters and are not installed. The local statistical gate is active.",
      501,
      false,
    );
  }
}

function histogram(bytes: Uint8Array): number[] {
  const bins = new Array<number>(32).fill(0);
  for (const value of bytes) bins[value % 32] += 1;
  const magnitude = Math.sqrt(bins.reduce((total, value) => total + value * value, 0)) || 1;
  return bins.map((value) => value / magnitude);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

interface SealedTemplate {
  v: 1;
  fixtureId: string | null;
  embedding: number[];
}

export class MemoryBiometricStore implements BiometricStore {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.assertKey(key);
    this.objects.set(key, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    this.assertKey(key);
    const value = this.objects.get(key);
    if (!value) throw new Error("template missing");
    return value;
  }

  async delete(key: string): Promise<void> {
    this.assertKey(key);
    this.objects.delete(key);
  }

  private assertKey(key: string): void {
    if (!/^templates\/[A-Za-z0-9_-]+$/.test(key)) throw new Error("template key rejected");
  }
}

export class FilesystemBiometricStore implements BiometricStore {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      throw new Error("template missing");
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  private resolve(key: string): string {
    if (!/^templates\/[A-Za-z0-9_-]+$/.test(key)) throw new Error("template key rejected");
    const root = path.resolve(this.root);
    const full = path.resolve(root, key);
    if (!full.startsWith(`${root}${path.sep}`)) throw new Error("template path rejected");
    return full;
  }
}

export class MockMatcher implements MatcherAdapter {
  readonly model: MatcherModel = { name: "mock-statistical", version: "1", mode: "mock" };

  constructor(
    private readonly store: BiometricStore,
    private readonly ids: () => string = () => randomUUID().replace(/-/g, ""),
  ) {}

  assess(image: Uint8Array): CaptureQuality {
    return assessCaptureQuality(image);
  }

  async enroll(image: Uint8Array): Promise<EnrollResult> {
    const quality = assessCaptureQuality(image);
    if (!quality.accept) {
      throw new EideticError("CAPTURE_REJECTED", quality.reasons.join(" "), 422, false);
    }
    const payload: SealedTemplate = {
      v: 1,
      fixtureId: readFixtureId(image),
      embedding: histogram(image),
    };
    const templateRef = `templates/${this.ids()}`;
    await this.store.put(templateRef, Buffer.from(JSON.stringify(payload)));
    return { templateRef, quality: quality.score };
  }

  async match(request: MatchRequest): Promise<MatchReport> {
    const quality = assessCaptureQuality(request.probe);
    if (!quality.accept) {
      throw new EideticError("CAPTURE_REJECTED", quality.reasons.join(" "), 422, false);
    }
    const probeFixture = readFixtureId(request.probe);
    const probeEmbedding = histogram(request.probe);
    const scored: Array<Omit<MatchCandidate, "rank">> = [];
    for (const member of request.gallery) {
      let sealed: SealedTemplate;
      try {
        sealed = JSON.parse(Buffer.from(await this.store.get(member.templateRef)).toString("utf8")) as SealedTemplate;
      } catch {
        continue;
      }
      const confidence = faceScore(probeFixture, probeEmbedding, sealed);
      const evidence: EvidenceItem[] = [
        {
          kind: "template_similarity",
          summary: `Sealed-template similarity ${confidence.toFixed(2)} from ${this.model.name}. The template stays inside the matcher.`,
          weight: confidence,
        },
        {
          kind: "capture_quality",
          summary: quality.reasons[0] ?? "Capture passed the local quality gate.",
          weight: quality.score,
        },
      ];
      if (request.recordHints?.employeeId && request.recordHints.employeeId === member.recordAttributes.employeeId) {
        evidence.push({
          kind: "record_attribute",
          summary: "Employee id agreed with the consented record. Attribute agreement does not confirm identity on its own.",
          weight: 1,
        });
      }
      scored.push({ cid: member.cid, confidence, evidence });
    }
    scored.sort((left, right) => right.confidence - left.confidence);
    const candidates = scored.slice(0, request.topK).map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      evidence:
        index === 0
          ? candidate.evidence
          : [
              ...candidate.evidence,
              {
                kind: "alternative" as const,
                summary: "Lower-ranked alternative, shown so a reviewer can see what else was considered.",
                weight: candidate.confidence,
              },
            ],
    }));
    return { model: this.model, candidates, quality };
  }

  async purge(templateRef: string): Promise<void> {
    await this.store.delete(templateRef);
  }
}

function faceScore(probeFixture: string | null, probeEmbedding: number[], sealed: SealedTemplate): number {
  if (probeFixture && sealed.fixtureId) return probeFixture === sealed.fixtureId ? 0.97 : 0.18;
  let dot = 0;
  for (let index = 0; index < probeEmbedding.length; index += 1) {
    dot += probeEmbedding[index] * (sealed.embedding[index] ?? 0);
  }
  return round4(Math.max(0, Math.min(1, dot)));
}

/**
 * Licensed InsightFace deployments plug in behind this class.
 * The MVP never downloads weights. A client is invoked only when a license
 * flag and an in-boundary client are both injected.
 */
export class InsightFaceAdapter implements MatcherAdapter {
  readonly model: MatcherModel = { name: "insightface", version: "unconfigured", mode: "insightface" };

  constructor(private readonly options: { licenseAccepted: boolean; client: InsightFaceClient | null }) {}

  assess(): CaptureQuality {
    this.refuse();
  }

  async enroll(image: Uint8Array): Promise<EnrollResult> {
    return this.client().enroll(image);
  }

  async match(request: MatchRequest): Promise<MatchReport> {
    return this.client().match(request);
  }

  async purge(): Promise<void> {
    return;
  }

  private client(): InsightFaceClient {
    if (!this.options.licenseAccepted || !this.options.client) this.refuse();
    return this.options.client;
  }

  private refuse(): never {
    throw new EideticError(
      "BIOMETRIC_PAYLOAD_REFUSED",
      "InsightFace stays behind a licensed adapter. Weights are often noncommercial, so this MVP defaults to mock mode and does not download them.",
      501,
      false,
    );
  }
}

export function createMatcher(options: {
  mode: "mock" | "insightface";
  store: BiometricStore;
  licenseAccepted?: boolean;
}): MatcherAdapter {
  if (options.mode === "insightface") {
    return new InsightFaceAdapter({ licenseAccepted: options.licenseAccepted === true, client: null });
  }
  return new MockMatcher(options.store);
}
