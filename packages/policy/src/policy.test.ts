// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import type { Actor, PurposeDefinition } from "@eidetic/contracts";
import { OpaPolicyDecider, authorizeSearch, mapKeycloakRoles, type PolicyInput } from "./index.js";

const operator: Actor = { id: "actor-operator", displayName: "Mira Calder", role: "operator" };
const admin: Actor = { id: "actor-admin", displayName: "Idris Hale", role: "admin" };

const purpose: PurposeDefinition = {
  code: "record_reconciliation",
  title: "Record reconciliation",
  description: "Consented workforce reconciliation.",
  edition: "business",
  legalBases: ["consent", "contract"],
  datasetIds: ["workforce_records"],
  allowedRoles: ["operator"],
  active: true,
};

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    actor: operator,
    purpose,
    legalBasis: "consent",
    datasetId: "workforce_records",
    edition: "business",
    milEnabled: false,
    ...overrides,
  };
}

describe("authorizeSearch", () => {
  it("allows an operator with an approved purpose, basis, and dataset", () => {
    expect(authorizeSearch(input())).toEqual({ allow: true });
  });

  it("denies a missing purpose, the wrong role, basis, dataset, and edition", () => {
    expect(authorizeSearch(input({ purpose: null }))).toMatchObject({ code: "PURPOSE_UNKNOWN" });
    expect(authorizeSearch(input({ actor: admin }))).toMatchObject({ code: "ROLE_NOT_PERMITTED" });
    expect(authorizeSearch(input({ legalBasis: "legal_obligation" }))).toMatchObject({ code: "LEGAL_BASIS_REJECTED" });
    expect(authorizeSearch(input({ datasetId: "personal_memory" }))).toMatchObject({ code: "DATASET_OUT_OF_SCOPE" });
    expect(authorizeSearch(input({ edition: "civilian" }))).toMatchObject({ code: "EDITION_MISMATCH" });
  });

  it("denies MIL and out-of-scope purposes before a match could run", () => {
    expect(authorizeSearch(input({ edition: "mil" }))).toMatchObject({ code: "MIL_NOT_ENABLED" });
    expect(authorizeSearch(input({ edition: "mil", milEnabled: true }))).toMatchObject({ code: "MIL_NOT_IMPLEMENTED" });
    expect(authorizeSearch(input({ purpose: { ...purpose, code: "mass_camera_watch" } }))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed when OPA does not explicitly allow", async () => {
    const down = new OpaPolicyDecider("http://opa.invalid", () => Promise.reject(new Error("down")));
    await expect(down.decide(input())).resolves.toMatchObject({ allow: false, code: "POLICY_UNAVAILABLE" });
    const refuse = new OpaPolicyDecider(
      "http://opa.local",
      async () => new Response(JSON.stringify({ result: { allow: false } }), { status: 200 }),
    );
    await expect(refuse.decide(input())).resolves.toMatchObject({ allow: false });
  });

  it("maps a single Keycloak realm role and refuses dual roles", () => {
    expect(mapKeycloakRoles(["eidetic-reviewer"])).toBe("reviewer");
    expect(mapKeycloakRoles(["eidetic-admin", "eidetic-operator"])).toBeNull();
    expect(mapKeycloakRoles(["offline_access"])).toBeNull();
  });
});
