// © Infinitum Corporation®. All rights reserved.

import { EideticError } from "@eidetic/contracts";
import { syntheticFixture } from "@eidetic/matcher";
import { attestConsentHash } from "@eidetic/seams";
import {
  DEMO_ACTORS,
  SYNTHETIC_SUBJECTS,
  createMemoryRuntime,
  seedReferenceData,
  seedSyntheticQueue,
} from "@eidetic/pipeline";

const http = process.argv.includes("--http");

if (http) {
  await runHttp(process.env.API_URL ?? "http://127.0.0.1:43110");
} else {
  await runLocal();
}

async function runLocal(): Promise<void> {
  const runtime = createMemoryRuntime();
  await seedReferenceData(runtime.repos, { demoMode: true });
  const admin = await runtime.repos.actors.get("actor-admin");
  const operator = await runtime.repos.actors.get("actor-operator");
  const reviewer = await runtime.repos.actors.get("actor-reviewer");
  if (!admin || !operator || !reviewer) throw new Error("Demo actors were not seeded.");

  section("Enroll consented synthetic subjects");
  const seeded = await seedSyntheticQueue(runtime.service, { admin, operator });
  const pending = await runtime.service.getReview(seeded.reviewId);
  line(`Review ${pending.reviewId} is ${pending.status}. Final decision: ${String(pending.finalDecision)}.`);
  line(`Leading candidate ${pending.subjectName} at ${pending.topConfidence}. Matcher: mock-statistical.`);

  section("Reviewer confirms. The score is not the decision.");
  await expectDenied(() =>
    runtime.service.decide({
      actor: operator,
      reviewId: seeded.reviewId,
      decision: "confirm",
      selectedCid: SYNTHETIC_SUBJECTS[0].cid,
      notes: "The operator must not close their own search.",
    }),
  );
  const decided = await runtime.service.decide({
    actor: reviewer,
    reviewId: seeded.reviewId,
    decision: "confirm",
    selectedCid: SYNTHETIC_SUBJECTS[0].cid,
    notes: "Consented workforce record and sealed similarity agree.",
  });
  line(decided.message);
  line(`Audit hash ${decided.audit.hash}`);

  section("Fail closed");
  await expectDenied(() =>
    runtime.service.search({
      actor: operator,
      purposeCode: "open_web_lookup",
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      image: syntheticFixture("avery-quinn"),
    }),
  );
  await runtime.service.withdraw(admin, SYNTHETIC_SUBJECTS[1].cid);
  line("Jordan Blake withdrew consent. The sealed template was purged.");
  await expectDenied(() =>
    runtime.service.search({
      actor: operator,
      purposeCode: "record_reconciliation",
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      subjectCid: SYNTHETIC_SUBJECTS[1].cid,
      image: syntheticFixture("jordan-blake"),
    }),
  );
  await expectDenied(() =>
    runtime.service.search({
      actor: operator,
      purposeCode: "record_reconciliation",
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "mil",
      image: syntheticFixture("avery-quinn"),
    }),
  );

  section("Hash chain");
  const proof = await runtime.service.verifyAudit();
  if (!proof.ok) {
    console.error(proof.errors.join("\n"));
    process.exit(1);
  }
  for (const entry of await runtime.service.listAudit()) {
    line(`${String(entry.seq).padStart(2, " ")} ${entry.action.padEnd(16)} ${entry.hash.slice(0, 16)}  ${entry.attestation.message}`);
  }
  line(`Merkle root ${proof.merkleRoot}`);
  const receipt = attestConsentHash(decided.audit.hash);
  line(`$EIDT stub broadcast=${String(receipt.broadcast)}. ${receipt.reason}`);
  line("Demo actors: " + DEMO_ACTORS.map((actor) => `${actor.role}=${actor.token}`).join(", "));
}

async function runHttp(base: string): Promise<void> {
  section(`HTTP demo against ${base}`);
  const health = await fetch(`${base}/v1/health`);
  if (!health.ok) throw new Error(`API health returned ${health.status}. Start the API first.`);
  const admin = { authorization: "Bearer dev-admin", "content-type": "application/json" };
  const seeded = await request<{ reviewId: string }>(`${base}/v1/demo/seed`, { method: "POST", headers: admin, body: "{}" });
  line(`Seeded review ${seeded.reviewId}`);
  const denied = await fetch(`${base}/v1/searches`, {
    method: "POST",
    headers: { authorization: "Bearer dev-operator", "content-type": "application/json" },
    body: JSON.stringify({
      purposeCode: "open_web_lookup",
      legalBasis: "consent",
      datasetId: "workforce_records",
      edition: "business",
      fixtureId: "avery-quinn",
    }),
  });
  const denial = await denied.json();
  line(`Purpose denial ${denied.status} ${denial.error?.code} matchRan=${String(denial.error?.matchRan)}`);
  const proof = await request<{ ok: boolean; entries: number; head: string | null }>(`${base}/v1/audit/verify`, { headers: { authorization: "Bearer dev-auditor" } });
  line(`Chain ok=${String(proof.ok)} entries=${proof.entries} head=${proof.head}`);
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? response.statusText);
  return body;
}

async function expectDenied(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    throw new Error("Expected the search to fail closed.");
  } catch (error) {
    if (error instanceof EideticError) {
      line(`Refused ${error.code}. matchRan=${String(error.matchRan)}. ${error.message}`);
      return;
    }
    throw error;
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function line(message: string): void {
  console.log(`  ${message}`);
}
