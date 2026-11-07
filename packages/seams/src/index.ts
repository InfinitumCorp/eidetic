// © Infinitum Corporation®. All rights reserved.

import { EideticError } from "@eidetic/contracts";
import { RasterioSiteContextPort, describeSiteAsset, type SiteAsset } from "@eidetic/geo";

export { RasterioSiteContextPort, describeSiteAsset, type SiteAsset };

export interface IntegrationSeam {
  system: "HRVST" | "SPECTRE" | "METATRON" | "VEIL" | "FIRMAMENT" | "ODIN";
  status: "interface_only";
  summary: string;
}

export const SEAMS: IntegrationSeam[] = [
  {
    system: "HRVST",
    status: "interface_only",
    summary: "Permissioned identity context for captures the organization already holds.",
  },
  {
    system: "SPECTRE",
    status: "interface_only",
    summary: "Authorized identity matching inside an operator's own records. +SPCTR is the same seam.",
  },
  {
    system: "METATRON",
    status: "interface_only",
    summary: "Identity context for tracks an organization is already authorized to hold.",
  },
  {
    system: "VEIL",
    status: "interface_only",
    summary: "Cumulus://ID™ enrollment and consent capture.",
  },
  {
    system: "FIRMAMENT",
    status: "interface_only",
    summary: "Tamper-evident audit. This MVP writes a local hash-chained log with Merkle checkpoints.",
  },
  {
    system: "ODIN",
    status: "interface_only",
    summary: "Reserved name for ei·det·ic MIL™. No military workflow is implemented.",
  },
];

export interface EidtReceipt {
  network: "base";
  asset: "EIDT";
  broadcast: false;
  attestationHash: string;
  reason: string;
}

/** Marketing stub. Accepts a sha256 consent-receipt hash and does not broadcast it. */
export function attestConsentHash(attestationHash: string): EidtReceipt {
  if (!/^[a-f0-9]{64}$/.test(attestationHash)) {
    throw new EideticError(
      "BIOMETRIC_PAYLOAD_REFUSED",
      "$EIDT on Base accepts a consent-receipt attestation hash only. Biometric payloads are refused and nothing is broadcast.",
      400,
      false,
    );
  }
  return {
    network: "base",
    asset: "EIDT",
    broadcast: false,
    attestationHash,
    reason: "Marketing stub. The hash was not sent to Base. Biometric data never goes on-chain.",
  };
}

