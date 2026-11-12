// © Infinitum Corporation®. All rights reserved.

// pnpm openapi: write docs/openapi.json from the API's route list and request schemas.
// A test fails when the committed file is out of date, so re-run this after changing a route.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { REQUEST_SCHEMAS } from "../apps/api/src/app.js";
import { buildOpenApi } from "../apps/api/src/openapi.js";

const out = path.resolve(import.meta.dirname, "..", "docs", "openapi.json");
writeFileSync(out, `${JSON.stringify(buildOpenApi(REQUEST_SCHEMAS), null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
