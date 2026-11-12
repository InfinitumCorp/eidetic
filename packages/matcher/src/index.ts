// © Infinitum Corporation®. All rights reserved.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EideticError, type EvidenceItem } from "@eidetic/contracts";
import { DEFAULT_MEDIAPIPE_MODEL_PATH, LocalOpenCvMediaPipeQualityGate, pythonMediaPipeSignals } from "./opencv-mediapipe.js";
import { OpenCvZooMatcher, pythonOpenCvZooInference, type ZooInference } from "./opencv-zoo.js";

export interface MatcherModel {
  name: string;
  version: string;
  mode: "mock" | "insightface" | "opencv-zoo";
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
  assess(image: Uint8Array): CaptureQuality | Promise<CaptureQuality>;
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

export const INSIGHTFACE_LICENSE_WARNING =
  "InsightFace pretrained weights are often limited to noncommercial research. ei·det·ic™ does not download or ship those weights. MATCHER_MODE stays mock for CI. Set INSIGHTFACE_LICENSE_ACCEPTED=true only when you hold a license, and set INSIGHTFACE_URL to a sidecar inside the sealed boundary.";

export const OPENCV_MEDIAPIPE_NOTICE =
  "OpenCV and MediaPipe are not bundled in the Node process. Set CAPTURE_PROVIDER=opencv-mediapipe after pnpm matcher:fetch-mediapipe-model and pip install -r packages/matcher/python/requirements-mediapipe.txt. BlazeFace short-range runs from a local file and does not call Google Cloud. Or set OPENCV_MEDIAPIPE_URL to a sidecar you operate. Synthetic fixtures are accepted. Other photographs are refused unless EIDETIC_ALLOW_OPERATOR_CAPTURES=true. Real public-figure biometrics are refused.";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function assertSyntheticFixture(image: Uint8Array, allowOperatorCaptures: boolean): void {
  if (allowOperatorCaptures) return;
  if (!readFixtureId(image)) {
    throw new EideticError(
      "CAPTURE_REJECTED",
      "Remote vision adapters accept EIDETIC-SYNTHETIC-v1 fixtures unless EIDETIC_ALLOW_OPERATOR_CAPTURES=true. Public-figure biometrics are refused.",
      422,
      false,
    );
  }
}

function refuseEmbeddingPayload(body: unknown): void {
  if (body && typeof body === "object" && "embedding" in body) {
    throw new EideticError(
      "BIOMETRIC_PAYLOAD_REFUSED",
      "The vision sidecar returned an embedding. ei·det·ic™ refuses to take that vector back across the adapter boundary.",
      502,
      false,
    );
  }
}

export class OpenCvMediaPipeQualityGate {
  readonly provider = "opencv-mediapipe" as const;

  constructor(
    private readonly options: {
      endpoint?: string;
      fetchImpl?: FetchLike;
      allowOperatorCaptures?: boolean;
    },
  ) {}

  async assess(image: Uint8Array): Promise<CaptureQuality> {
    if (!this.options.endpoint) {
      throw new EideticError("CAPTURE_REJECTED", OPENCV_MEDIAPIPE_NOTICE, 501, false);
    }
    assertSyntheticFixture(image, this.options.allowOperatorCaptures === true);
    const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "quality", syntheticFixture: readFixtureId(image) }),
    });
    if (!response.ok) {
      throw new EideticError("CAPTURE_REJECTED", "The OpenCV and MediaPipe sidecar refused the synthetic fixture.", 502, false);
    }
    const body = (await response.json()) as { score?: number; accept?: boolean; reasons?: string[]; embedding?: unknown };
    refuseEmbeddingPayload(body);
    return {
      score: typeof body.score === "number" ? body.score : 0,
      accept: body.accept === true,
      provider: "opencv-mediapipe",
      reasons: body.reasons?.length ? body.reasons : ["OpenCV and MediaPipe sidecar assessed a synthetic fixture."],
    };
  }
}

export class InsightFaceSidecar implements MatcherAdapter {
  readonly model: MatcherModel = { name: "insightface-sidecar", version: "unconfigured", mode: "insightface" };

  constructor(
    private readonly options: {
      endpoint: string;
      store: BiometricStore;
      fetchImpl?: FetchLike;
      allowOperatorCaptures?: boolean;
      ids?: () => string;
    },
  ) {}

  assess(image: Uint8Array): CaptureQuality {
    assertSyntheticFixture(image, this.options.allowOperatorCaptures === true);
    return {
      score: 0.9,
      accept: true,
      provider: "local-statistical",
      reasons: ["Synthetic fixture accepted before the InsightFace sidecar call. Weights are not loaded in this process."],
    };
  }

  async enroll(image: Uint8Array): Promise<EnrollResult> {
    assertSyntheticFixture(image, this.options.allowOperatorCaptures === true);
    const response = await this.post({ op: "enroll", syntheticFixture: readFixtureId(image) });
    const quality = typeof response.quality === "number" ? response.quality : 0.9;
    const templateRef = `templates/${(this.options.ids ?? (() => randomUUID().replace(/-/g, "")))()}`;
    const payload = { v: 1, fixtureId: readFixtureId(image), provider: "insightface-sidecar" };
    await this.options.store.put(templateRef, Buffer.from(JSON.stringify(payload)));
    return { templateRef, quality };
  }

  async match(request: MatchRequest): Promise<MatchReport> {
    assertSyntheticFixture(request.probe, this.options.allowOperatorCaptures === true);
    const gallery = [];
    for (const member of request.gallery) {
      let fixtureId: string | null = null;
      try {
        const stored = JSON.parse(Buffer.from(await this.options.store.get(member.templateRef)).toString("utf8")) as { fixtureId?: string | null };
        fixtureId = stored.fixtureId ?? null;
      } catch {
        continue;
      }
      gallery.push({ cid: member.cid, syntheticFixture: fixtureId });
    }
    const response = await this.post({ op: "match", syntheticFixture: readFixtureId(request.probe), gallery });
    const scores = Array.isArray(response.scores) ? response.scores : [];
    const candidates = scores
      .filter((item): item is { cid: string; confidence: number } => typeof item?.cid === "string" && typeof item.confidence === "number")
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, request.topK)
      .map((item, index) => ({
        cid: item.cid,
        confidence: item.confidence,
        rank: index + 1,
        evidence: [
          {
            kind: "template_similarity" as const,
            summary: `InsightFace sidecar similarity ${item.confidence.toFixed(2)} for a synthetic fixture. The descriptor stayed in the sidecar.`,
            weight: item.confidence,
          },
        ],
      }));
    return { model: this.model, candidates, quality: this.assess(request.probe) };
  }

  async purge(templateRef: string): Promise<void> {
    await this.options.store.delete(templateRef);
  }

  private async post(payload: unknown): Promise<{ quality?: number; scores?: Array<{ cid?: string; confidence?: number }>; embedding?: unknown }> {
    const response = await (this.options.fetchImpl ?? fetch)(this.options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new EideticError("BIOMETRIC_PAYLOAD_REFUSED", INSIGHTFACE_LICENSE_WARNING, 502, false);
    }
    const body = (await response.json()) as { quality?: number; scores?: Array<{ cid?: string; confidence?: number }>; embedding?: unknown };
    refuseEmbeddingPayload(body);
    return body;
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
  mode: "mock" | "insightface" | "opencv-zoo";
  captureProvider?: "local" | "opencv-mediapipe";
  store: BiometricStore;
  licenseAccepted?: boolean;
  insightfaceUrl?: string;
  opencvMediapipeUrl?: string;
  opencvMediapipeModelPath?: string;
  opencvMediapipePython?: string;
  opencvZooModelDir?: string;
  allowOperatorCaptures?: boolean;
  fetchImpl?: FetchLike;
  zooInfer?: ZooInference;
  mediapipeSignals?: (image: Uint8Array) => Promise<unknown>;
}): MatcherAdapter {
  const capture = options.captureProvider ?? "local";
  let recognizer: MatcherAdapter;
  if (options.mode === "opencv-zoo") {
    const infer = options.zooInfer ?? pythonOpenCvZooInference(options.opencvZooModelDir ?? "data/models/opencv-zoo");
    recognizer = new OpenCvZooMatcher({
      store: options.store,
      infer,
      allowOperatorCaptures: options.allowOperatorCaptures,
    });
  } else if (options.mode === "insightface") {
    if (options.licenseAccepted !== true || !options.insightfaceUrl) {
      throw new EideticError("BIOMETRIC_PAYLOAD_REFUSED", INSIGHTFACE_LICENSE_WARNING, 501, false);
    }
    recognizer = new InsightFaceSidecar({
      endpoint: options.insightfaceUrl,
      store: options.store,
      fetchImpl: options.fetchImpl,
      allowOperatorCaptures: options.allowOperatorCaptures,
    });
  } else {
    recognizer = new MockMatcher(options.store);
  }
  if (capture !== "opencv-mediapipe") return recognizer;
  const gate = options.opencvMediapipeUrl
    ? new OpenCvMediaPipeQualityGate({
        endpoint: options.opencvMediapipeUrl,
        fetchImpl: options.fetchImpl,
        allowOperatorCaptures: options.allowOperatorCaptures,
      })
    : new LocalOpenCvMediaPipeQualityGate({
        signals: options.mediapipeSignals ?? requireLocalMediaPipe(options),
        allowOperatorCaptures: options.allowOperatorCaptures,
        readFixtureId,
      });
  return new QualityGuardedMatcher(recognizer, gate);
}

function requireLocalMediaPipe(options: { opencvMediapipeModelPath?: string; opencvMediapipePython?: string }): (image: Uint8Array) => Promise<unknown> {
  const modelPath = options.opencvMediapipeModelPath ?? DEFAULT_MEDIAPIPE_MODEL_PATH;
  if (!existsSync(modelPath)) {
    throw new EideticError("CAPTURE_REJECTED", `${OPENCV_MEDIAPIPE_NOTICE} Model file not found at ${modelPath}.`, 501, false);
  }
  return pythonMediaPipeSignals(modelPath, options.opencvMediapipePython ?? "python3");
}

class QualityGuardedMatcher implements MatcherAdapter {
  constructor(
    private readonly inner: MatcherAdapter,
    private readonly gate: { assess(image: Uint8Array): Promise<CaptureQuality> },
  ) {}

  get model() {
    return this.inner.model;
  }

  assess(image: Uint8Array) {
    return this.gate.assess(image);
  }

  async enroll(image: Uint8Array): Promise<EnrollResult> {
    const quality = await this.gate.assess(image);
    if (!quality.accept) throw new EideticError("CAPTURE_REJECTED", quality.reasons.join(" "), 422, false);
    const enrolled = await this.inner.enroll(image);
    return { templateRef: enrolled.templateRef, quality: quality.score };
  }

  async match(request: MatchRequest): Promise<MatchReport> {
    const quality = await this.gate.assess(request.probe);
    if (!quality.accept) throw new EideticError("CAPTURE_REJECTED", quality.reasons.join(" "), 422, false);
    const report = await this.inner.match(request);
    return {
      ...report,
      quality,
      candidates: report.candidates.map((candidate) => ({
        ...candidate,
        evidence: candidate.evidence.map((item) =>
          item.kind === "capture_quality" ? { ...item, summary: quality.reasons[0] ?? item.summary, weight: quality.score } : item,
        ),
      })),
    };
  }

  purge(templateRef: string) {
    return this.inner.purge(templateRef);
  }
}
