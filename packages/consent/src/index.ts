// © Infinitum Corporation®. All rights reserved.

import { EideticError, canonicalJson, sha256Hex, type LegalBasis } from "@eidetic/contracts";

export interface ConsentReceiptCredential {
  "@context": ["https://www.w3.org/2018/credentials/v1"];
  type: ["VerifiableCredential", "ConsentReceipt"];
  issuer: "urn:infinitum:eidetic:local-issuer";
  issuanceDate: string;
  credentialSubject: {
    id: string;
    purposeCode: string;
    datasetIds: string[];
    legalBasis: LegalBasis;
    status: "granted" | "withdrawn";
  };
  proof: {
    type: "Sha256Attestation";
    created: string;
    proofPurpose: "assertionMethod";
    verificationMethod: "urn:infinitum:eidetic:local-issuer#sha256";
    payloadHash: string;
  };
}

export function buildConsentReceipt(input: {
  cid: string;
  purposeCode: string;
  datasetIds: string[];
  legalBasis: LegalBasis;
  status: "granted" | "withdrawn";
  at: string;
}): ConsentReceiptCredential {
  const credentialSubject = {
    id: input.cid,
    purposeCode: input.purposeCode,
    datasetIds: [...input.datasetIds].sort(),
    legalBasis: input.legalBasis,
    status: input.status,
  };
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    type: ["VerifiableCredential", "ConsentReceipt"],
    issuer: "urn:infinitum:eidetic:local-issuer",
    issuanceDate: input.at,
    credentialSubject,
    proof: {
      type: "Sha256Attestation",
      created: input.at,
      proofPurpose: "assertionMethod",
      verificationMethod: "urn:infinitum:eidetic:local-issuer#sha256",
      payloadHash: sha256Hex(canonicalJson(credentialSubject)),
    },
  };
}

export interface FidesPushResult {
  status: "not_configured" | "queued";
  authoritative: "local";
}

export interface FidesConsentPort {
  readonly system: "fides";
  pushPreference(receipt: ConsentReceiptCredential): Promise<FidesPushResult>;
}

export class LocalFidesConsentPort implements FidesConsentPort {
  readonly system = "fides" as const;

  pushPreference(_receipt: ConsentReceiptCredential): Promise<FidesPushResult> {
    return Promise.resolve({ status: "not_configured", authoritative: "local" });
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpFidesConsentPort implements FidesConsentPort {
  readonly system = "fides" as const;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async pushPreference(receipt: ConsentReceiptCredential): Promise<FidesPushResult> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(receipt),
    });
    if (!response.ok) {
      throw new EideticError(
        "CONSENT_REQUIRED",
        "Fides refused the consent receipt. The subject was not enrolled.",
        502,
        false,
      );
    }
    return { status: "queued", authoritative: "local" };
  }
}
