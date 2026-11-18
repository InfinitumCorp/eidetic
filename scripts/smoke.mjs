#!/usr/bin/env node
// Post-deploy smoke test for the desks. Usage: node scripts/smoke.mjs https://review.example https://purpose.example
// Checks each desk serves its page, proxies /v1/health to the API, and sends the security headers.
const desks = process.argv.slice(2);
if (desks.length === 0) {
  console.error("Usage: node scripts/smoke.mjs <desk-url> [<desk-url> ...]");
  process.exit(2);
}

const REQUIRED_HEADERS = {
  "content-security-policy": (v) => /default-src 'self'/.test(v) && /frame-ancestors 'none'/.test(v),
  "x-content-type-options": (v) => v === "nosniff",
  "x-frame-options": (v) => v === "DENY",
  "referrer-policy": (v) => v.length > 0,
};

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failed++;
};

for (const raw of desks) {
  const base = raw.replace(/\/+$/, "");
  console.log(`\n${base}`);
  try {
    const page = await fetch(base + "/", { redirect: "follow" });
    const html = await page.text();
    check(page.ok, `page loads (${page.status})`);
    check(/ei·det·ic/.test(html), "page is an ei·det·ic desk");
    for (const [name, valid] of Object.entries(REQUIRED_HEADERS)) {
      const value = page.headers.get(name) ?? "";
      check(Boolean(value) && valid(value), `header ${name}`);
    }
    if (base.startsWith("https://")) check(Boolean(page.headers.get("strict-transport-security")), "header strict-transport-security");
    const health = await fetch(base + "/v1/health");
    check(health.ok, `/v1/health through the desk (${health.status})`);
    const body = await health.json().catch(() => ({}));
    check(body?.db === "ok", "API database is up");
    check(body?.demoMode === false, "API is not in demo mode");
    check(body?.milEnabled === false, "MIL is off");
  } catch (error) {
    check(false, `reachable: ${error.message}`);
  }
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
