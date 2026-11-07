// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { HttpFidesConsentPort, LocalFidesConsentPort, buildConsentReceipt } from "./index.js";

describe("consent receipts", () => {
  it("builds a VC-shaped receipt with a hash and no biometric material", () => {
    const receipt = buildConsentReceipt({
      cid: "cid://infinitum/fixture-avery-quinn",
      purposeCode: "record_reconciliation",
      datasetIds: ["workforce_records"],
      legalBasis: "consent",
      status: "granted",
      at: "2026-11-07T12:00:00.000Z",
    });
    expect(receipt.type).toEqual(["VerifiableCredential", "ConsentReceipt"]);
    expect(receipt.proof.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toMatch(/embedding|imageBase64|templateRef/i);
    expect(receipt.credentialSubject.id).toBe("cid://infinitum/fixture-avery-quinn");
  });

  it("keeps Fides optional and fails closed when a configured export rejects the receipt", async () => {
    await expect(new LocalFidesConsentPort().pushPreference(buildConsentReceipt({
      cid: "cid://infinitum/fixture-avery-quinn",
      purposeCode: "record_reconciliation",
      datasetIds: ["workforce_records"],
      legalBasis: "consent",
      status: "granted",
      at: "2026-11-07T12:00:00.000Z",
    }))).resolves.toEqual({ status: "not_configured", authoritative: "local" });

    const refusing = new HttpFidesConsentPort("http://fides.local/consent", async () => new Response("no", { status: 400 }));
    await expect(refusing.pushPreference(buildConsentReceipt({
      cid: "cid://infinitum/fixture-avery-quinn",
      purposeCode: "record_reconciliation",
      datasetIds: ["workforce_records"],
      legalBasis: "consent",
      status: "granted",
      at: "2026-11-07T12:00:00.000Z",
    }))).rejects.toThrow(/Fides refused/);
  });
});
