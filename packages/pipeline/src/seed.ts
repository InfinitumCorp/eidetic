// © Infinitum Corporation®. All rights reserved.

import { sha256Hex, type PurposeDefinition, type Role } from "@eidetic/contracts";
import type { Repositories } from "./repositories.js";

export interface ActorSeed {
  id: string;
  displayName: string;
  role: Role;
  token: string;
}

export const DEMO_ACTORS: ActorSeed[] = [
  { id: "actor-admin", displayName: "Idris Hale", role: "admin", token: "dev-admin" },
  { id: "actor-operator", displayName: "Mira Calder", role: "operator", token: "dev-operator" },
  { id: "actor-reviewer", displayName: "Helen Cho", role: "reviewer", token: "dev-reviewer" },
  { id: "actor-auditor", displayName: "Noor Patel", role: "auditor", token: "dev-auditor" },
];

export const DEFAULT_PURPOSES: PurposeDefinition[] = [
  {
    code: "record_reconciliation",
    title: "Record reconciliation",
    description: "Reconcile a workforce record the subject consented to share with a capture the organization already holds.",
    edition: "business",
    legalBases: ["consent", "contract"],
    datasetIds: ["workforce_records"],
    allowedRoles: ["operator"],
    active: true,
  },
  {
    code: "access_control",
    title: "Facility access",
    description: "Check a person who enrolled for a facility against that facility's consented access dataset.",
    edition: "business",
    legalBases: ["consent"],
    datasetIds: ["facility_access"],
    allowedRoles: ["operator"],
    active: true,
  },
  {
    code: "consented_assistance",
    title: "Consented assistance",
    description: "Recognize a person who asked for assistance, using only the dataset they enrolled.",
    edition: "civilian",
    legalBases: ["consent"],
    datasetIds: ["personal_memory"],
    allowedRoles: ["operator"],
    active: true,
  },
];

export async function seedReferenceData(
  repos: Repositories,
  options: { demoMode: boolean; actors?: ActorSeed[] },
): Promise<void> {
  for (const purpose of DEFAULT_PURPOSES) await repos.purposes.upsert(purpose);
  const actors = options.demoMode ? DEMO_ACTORS : (options.actors ?? []);
  if (actors.length === 0) {
    throw new Error("No actors to seed. Set DEMO_MODE=true for local dev tokens, or provide actors explicitly.");
  }
  for (const actor of actors) {
    const existing = await repos.actors.get(actor.id);
    if (existing) continue;
    await repos.actors.insert({
      id: actor.id,
      displayName: actor.displayName,
      role: actor.role,
      tokenHash: sha256Hex(actor.token),
    });
  }
}
