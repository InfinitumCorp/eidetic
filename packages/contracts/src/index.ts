// © Infinitum Corporation®. All rights reserved.

import { createHash } from "node:crypto";

export const PRODUCT = "ei·det·ic™";
export const MIL_PRODUCT = "ei·det·ic MIL™";
export const COMPANY = "Infinitum Corporation®";
export const CONTACT_EMAIL = "info@theinfinitumcorporation.com";
export const CONTACT_PHONE = "202-729-9509";

export const ROLES = ["admin", "operator", "reviewer", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export const LEGAL_BASES = ["consent", "contract", "legal_obligation"] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];

export const EDITIONS = ["civilian", "business", "mil"] as const;
export type Edition = (typeof EDITIONS)[number];

export const DENIAL_CODES = [
  "PURPOSE_REQUIRED",
  "PURPOSE_UNKNOWN",
  "PURPOSE_INACTIVE",
  "ROLE_NOT_PERMITTED",
  "LEGAL_BASIS_REJECTED",
  "DATASET_OUT_OF_SCOPE",
  "EDITION_MISMATCH",
  "MIL_NOT_ENABLED",
  "MIL_NOT_IMPLEMENTED",
  "CONSENT_REQUIRED",
  "CONSENT_WITHDRAWN",
  "CONSENT_EXPIRED",
  "SUBJECT_NOT_ENROLLED",
  "SEPARATION_OF_DUTIES",
  "REVIEW_ALREADY_DECIDED",
  "TEMPLATE_MISSING",
  "CAPTURE_REJECTED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "DEMO_FIXTURES_DISABLED",
  "SENSITIVE_ATTRIBUTE",
  "BIOMETRIC_PAYLOAD_REFUSED",
  "PERSON_TRACKING_REFUSED",
  "DECISION_INVALID",
  "POLICY_UNAVAILABLE",
  "VALIDATION",
  "RATE_LIMITED",
] as const;
export type DenialCode = (typeof DENIAL_CODES)[number];

export class EideticError extends Error {
  readonly name = "EideticError";

  constructor(
    readonly code: DenialCode,
    message: string,
    readonly httpStatus: number,
    readonly matchRan = false,
  ) {
    super(message);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Log-field classes follow the public Safe / Unsafe / DoNotLog vocabulary
 * described by Palantir's Apache-2.0 safe-logging projects. This redactor
 * is local code. Those libraries are not dependencies, and biometric fields
 * are DoNotLog: they never enter a log line or the public audit stream.
 */
export type LogSafety = "safe" | "unsafe" | "do_not_log";

const DO_NOT_LOG_KEY =
  /image|template|embedding|vector|biometric|pixel|photo|probe|face|weight|descriptor|gallery/i;
const UNSAFE_KEY = /email|phone|note|address|name|ssn|passport/i;

export function classifyLogField(name: string): LogSafety {
  if (DO_NOT_LOG_KEY.test(name)) return "do_not_log";
  if (UNSAFE_KEY.test(name)) return "unsafe";
  return "safe";
}

export interface TextRedactor {
  redact(text: string): string;
}

export class LocalPatternRedactor implements TextRedactor {
  redact(text: string): string {
    return text
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted-id]")
      .replace(/\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[redacted-phone]");
  }
}

export class PresidioRedactor implements TextRedactor {
  constructor(private readonly client?: (text: string) => string) {}

  redact(text: string): string {
    if (!this.client) {
      throw new EideticError(
        "POLICY_UNAVAILABLE",
        "Presidio is not configured. Local pattern redaction remains the default in this MVP.",
        501,
        false,
      );
    }
    return this.client(text);
  }
}

export interface Actor {
  id: string;
  displayName: string;
  role: Role;
}

export interface PurposeDefinition {
  code: string;
  title: string;
  description: string;
  edition: "civilian" | "business";
  legalBases: LegalBasis[];
  datasetIds: string[];
  allowedRoles: Role[];
  active: boolean;
}

export interface SubjectRecord {
  cid: string;
  displayName: string;
  status: "active" | "withdrawn";
  recordAttributes: Record<string, string>;
  enrolledAt: string;
  withdrawnAt: string | null;
}

export interface ConsentGrant {
  id: string;
  cid: string;
  purposeCode: string;
  datasetIds: string[];
  legalBasis: LegalBasis;
  status: "granted" | "withdrawn";
  grantedAt: string;
  withdrawnAt: string | null;
  /** When the subject's consent lapses. Null means it lasts until withdrawn. */
  expiresAt: string | null;
  receiptHash: string;
}

/** A grant counts only while it is granted and not past its expiry. */
export function consentIsLive(consent: Pick<ConsentGrant, "status" | "expiresAt">, at: string): boolean {
  return consent.status === "granted" && (consent.expiresAt === null || consent.expiresAt > at);
}

export interface TemplatePointer {
  id: string;
  cid: string;
  storeKey: string;
  quality: number;
  modelName: string;
  modelVersion: string;
  createdAt: string;
  purgedAt: string | null;
}

export interface EvidenceItem {
  kind: "template_similarity" | "record_attribute" | "capture_quality" | "alternative";
  summary: string;
  weight: number;
}

export interface SearchRecord {
  id: string;
  actorId: string;
  purposeCode: string;
  legalBasis: LegalBasis;
  datasetId: string;
  edition: Edition;
  subjectCid: string | null;
  status: "pending_review" | "decided" | "denied";
  denialCode: string | null;
  modelName: string | null;
  modelVersion: string | null;
  createdAt: string;
}

export interface StoredCandidate {
  id: string;
  searchId: string;
  cid: string;
  confidence: number;
  rank: number;
  evidence: EvidenceItem[];
  createdAt: string;
}

export interface ReviewRecord {
  id: string;
  searchId: string;
  status: "pending" | "decided";
  decision: "confirm" | "reject" | "inconclusive" | null;
  selectedCid: string | null;
  notes: string | null;
  reviewerId: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface AuditAttestation {
  outcome: "allowed" | "denied" | "recorded";
  matchRan: boolean;
  message: string;
  code?: string;
  purposeCode?: string;
  datasetId?: string;
  legalBasis?: string;
  edition?: string;
  subjectCid?: string;
  searchId?: string;
  reviewId?: string;
  decision?: string;
  candidateCount?: number;
  topConfidence?: number;
  model?: string;
  notes?: string;
  sealedStorePurged?: boolean;
  receiptHash?: string;
  releaseId?: string;
}

const ATTESTATION_KEYS = new Set([
  "outcome",
  "matchRan",
  "message",
  "code",
  "purposeCode",
  "datasetId",
  "legalBasis",
  "edition",
  "subjectCid",
  "searchId",
  "reviewId",
  "decision",
  "candidateCount",
  "topConfidence",
  "model",
  "notes",
  "sealedStorePurged",
  "receiptHash",
  "releaseId",
]);

export function sealAttestation(input: unknown): AuditAttestation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EideticError(
      "BIOMETRIC_PAYLOAD_REFUSED",
      "Audit payloads must be flat attestations. Biometric values are refused.",
      400,
      false,
    );
  }
  const source = input as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (source[key] === undefined) continue;
    if (classifyLogField(key) === "do_not_log" || !ATTESTATION_KEYS.has(key)) {
      throw new EideticError(
        "BIOMETRIC_PAYLOAD_REFUSED",
        `Audit attestation refused "${key}". The public audit stream stores attestations only. Biometric payloads are DoNotLog.`,
        400,
        false,
      );
    }
    walkAttestationValue(source[key], key);
  }
  if (source.outcome !== "allowed" && source.outcome !== "denied" && source.outcome !== "recorded") {
    throw new EideticError("BIOMETRIC_PAYLOAD_REFUSED", "Audit attestation outcome is invalid.", 400, false);
  }
  if (typeof source.matchRan !== "boolean" || typeof source.message !== "string" || source.message.length === 0 || source.message.length > 500) {
    throw new EideticError("BIOMETRIC_PAYLOAD_REFUSED", "Audit attestation message is missing or too large.", 400, false);
  }
  const sealed: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) sealed[key] = source[key];
  }
  return sealed as unknown as AuditAttestation;
}

function walkAttestationValue(value: unknown, path: string): void {
  if (value instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(value))) {
    throw new EideticError("BIOMETRIC_PAYLOAD_REFUSED", `Binary payload refused at ${path}.`, 400, false);
  }
  if (Array.isArray(value)) {
    if (value.length > 8 && value.every((item) => typeof item === "number")) {
      throw new EideticError("BIOMETRIC_PAYLOAD_REFUSED", `Numeric vector refused at ${path}.`, 400, false);
    }
    value.forEach((item, index) => walkAttestationValue(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    throw new EideticError("BIOMETRIC_PAYLOAD_REFUSED", `Nested object refused at ${path}. Attestations stay flat.`, 400, false);
  }
  if (typeof value === "string") {
    if (value.length > 500 || /^[A-Za-z0-9+/=]{180,}$/.test(value)) {
      throw new EideticError("BIOMETRIC_PAYLOAD_REFUSED", `Oversized or encoded payload refused at ${path}.`, 400, false);
    }
  }
}

const SENSITIVE_ATTRIBUTE = /ssn|passport|password|secret|tax|national|driver|biometric|face|image|template|embedding/i;

export function assertRecordAttributes(record: Record<string, string> | undefined): Record<string, string> {
  if (!record) return {};
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,32}$/.test(key) || SENSITIVE_ATTRIBUTE.test(key)) {
      throw new EideticError("SENSITIVE_ATTRIBUTE", `Attribute "${key}" is not allowed on an operational record.`, 422, false);
    }
    if (typeof value !== "string" || value.length === 0 || value.length > 80 || /[\r\n]/.test(value) || /base64|data:/i.test(value)) {
      throw new EideticError("SENSITIVE_ATTRIBUTE", `Attribute "${key}" has an unsupported value.`, 422, false);
    }
    clean[key] = value;
  }
  return clean;
}

export const CODE_PATTERN = /^[a-z][a-z0-9_]{2,64}$/;
export const OUT_OF_SCOPE_PATTERN = /social|scrape|osint|mass|surveil|stalk|clearance|military|weapon|plate|alpr|camera_net/i;
export const CID_PATTERN = /^cid:\/\/infinitum\/[a-z0-9-]{3,80}$/;

export function isDenialCode(value: unknown): value is DenialCode {
  return typeof value === "string" && (DENIAL_CODES as readonly string[]).includes(value);
}

export function clipMessage(message: string): string {
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}
