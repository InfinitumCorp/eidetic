// © Infinitum Corporation®. All rights reserved.

import { EideticError, MIL_PRODUCT, type DenialCode } from "@eidetic/contracts";

export const MIL_BOUNDARY =
  `${MIL_PRODUCT} is a package boundary. Military workflows are not implemented in this MVP.`;

export function evaluateMilEdition(
  edition: string,
  milEnabled: boolean,
): { blocked: false } | { blocked: true; code: DenialCode; message: string } {
  if (edition !== "mil") return { blocked: false };
  if (!milEnabled) {
    return {
      blocked: true,
      code: "MIL_NOT_ENABLED",
      message: `${MIL_PRODUCT} is disabled on this deployment. The search did not run.`,
    };
  }
  return {
    blocked: true,
    code: "MIL_NOT_IMPLEMENTED",
    message: `${MIL_PRODUCT} is a package boundary only. Military workflows are not implemented, so the search did not run.`,
  };
}

export function refuseMilitaryWorkflow(): never {
  throw new EideticError("MIL_NOT_IMPLEMENTED", MIL_BOUNDARY, 403, false);
}
