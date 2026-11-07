// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import {
  LocalPatternRedactor,
  PresidioRedactor,
  canonicalJson,
  classifyLogField,
  sealAttestation,
  sha256Hex,
} from "./index.js";

describe("attestation sealing", () => {
  it("classifies biometric field names as DoNotLog", () => {
    expect(classifyLogField("embedding")).toBe("do_not_log");
    expect(classifyLogField("templateRef")).toBe("do_not_log");
    expect(classifyLogField("notes")).toBe("unsafe");
    expect(classifyLogField("purposeCode")).toBe("safe");
  });

  it("refuses embeddings and keeps a stable canonical hash", () => {
    const attestation = sealAttestation({
      message: "Consent recorded.",
      matchRan: false,
      outcome: "recorded",
      subjectCid: "cid://infinitum/example",
    });
    expect(canonicalJson(attestation)).toBe(canonicalJson({ ...attestation }));
    expect(sha256Hex(canonicalJson(attestation))).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      sealAttestation({
        outcome: "recorded",
        matchRan: false,
        message: "no",
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
      }),
    ).toThrow(/DoNotLog/);
  });

  it("redacts contact strings locally and does not call Presidio unless a client is bound", () => {
    const redactor = new LocalPatternRedactor();
    expect(redactor.redact("Reach ada@example.com or 202-555-0100.")).toBe(
      "Reach [redacted-email] or [redacted-phone].",
    );
    expect(() => new PresidioRedactor().redact("hello")).toThrow(/Presidio is not configured/);
    expect(new PresidioRedactor((text) => text.replace("secret", "[x]")).redact("secret")).toBe("[x]");
  });
});
