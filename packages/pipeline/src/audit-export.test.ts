// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { verifyExportDocument } from "@eidetic/audit";
import { syntheticFixture } from "@eidetic/matcher";
import { createMemoryRuntime } from "./runtime.js";
import { DEMO_ACTORS, seedReferenceData } from "./seed.js";

describe("audit export from the API", () => {
  it("records who exported first, then hands back a document that verifies offline", async () => {
    const runtime = createMemoryRuntime();
    await seedReferenceData(runtime.repos, { demoMode: true });
    const [admin, operator, , auditor] = await Promise.all(DEMO_ACTORS.map((actor) => runtime.repos.actors.get(actor.id)));
    if (!admin || !operator || !auditor) throw new Error("demo actors missing");
    await runtime.service.enroll({
      actor: admin,
      cid: "cid://infinitum/fixture-avery-quinn",
      displayName: "Avery Quinn",
      image: syntheticFixture("avery-quinn"),
      legalBasis: "consent",
      purposes: [{ purposeCode: "record_reconciliation", datasetIds: ["workforce_records"] }],
    });

    await expect(runtime.service.exportAudit(operator)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const document = await runtime.service.exportAudit(auditor);
    expect(verifyExportDocument(document).ok).toBe(true);
    const last = document.entries.at(-1);
    expect(last).toMatchObject({ action: "audit_export", actorId: auditor.id });
    // No biometric field names (the word "template" may appear in messages, never as a key).
    expect(JSON.stringify(document)).not.toMatch(/"(template|embedding|imageBase64)[A-Za-z]*":/i);
    expect((await runtime.service.verifyAudit()).ok).toBe(true);
  });

  it("records nothing when the export itself is refused", async () => {
    const runtime = createMemoryRuntime();
    await seedReferenceData(runtime.repos, { demoMode: true });
    const auditor = await runtime.repos.actors.get(DEMO_ACTORS[3].id);
    if (!auditor) throw new Error("demo auditor missing");
    const before = (await runtime.service.listAudit()).length;
    runtime.repos.audit.export = async () => {
      throw new Error('Audit export refused "embedding".');
    };
    await expect(runtime.service.exportAudit(auditor)).rejects.toThrow(/refused/);
    expect((await runtime.service.listAudit()).length).toBe(before);
  });
});
