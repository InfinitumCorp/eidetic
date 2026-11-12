# ei·det·ic™

ei·det·ic™ is Infinitum Corporation®'s consent-first identity-intelligence platform. A search runs only when role, purpose, and legal basis are allowed. Facial and record matching returns a confidence score and the evidence behind it. A trained reviewer confirms every result. Every search, match, and decision is written to a hash-chained audit log. Biometric templates stay in a sealed store. They are not written to the audit log, to process logs, or to a chain.

Civilian and business workflows are the whole of this MVP. ei·det·ic MIL™ is a package boundary with the flag off. Military workflows are not implemented, and turning the flag on still refuses them.

Public product page: [ei·det·ic™](https://infinitum-corporation.vercel.app/products/eidetic). This repository does not deploy that site.

## Pipeline

```mermaid
flowchart LR
  subgraph desks [Desks]
    Admin[apps/admin]
    Reviewer[apps/reviewer]
  end
  Admin --> API
  Reviewer --> API
  subgraph apiApp [apps/api]
    API[HTTP API]
    Orch[EideticService]
    API --> Orch
  end
  Orch --> Policy[packages/policy]
  Orch --> Consent[packages/consent]
  Orch --> Matcher[packages/matcher]
  Orch --> Audit[packages/audit]
  Policy --> PG[(PostgreSQL)]
  Consent --> PG
  Audit --> PG
  Matcher --> Store[(Sealed template files)]
  Audit -. attestation hash only .-> EIDT["$EIDT stub, not broadcast"]
```

1. **Authorize.** `authorizeSearch` checks edition, purpose, role, legal basis, and dataset. Out-of-policy requests are stored as denials and the matcher is not called.
2. **Match.** The default adapter is `mock-statistical`. It scores synthetic fixtures inside the process and returns confidence, evidence, and alternatives. Embeddings never leave the matcher.
3. **Review.** A pending review is created even when confidence is high. The person who ran the search cannot decide it. Confirm, reject, and inconclusive are human outcomes.
4. **Record.** Entries are hash-chained. Each append stores a Merkle checkpoint and an HMAC-SHA256 signature over that checkpoint. PostgreSQL triggers reject updates and deletes. `pnpm audit:verify` checks the chain and the signatures. `GET /v1/audit` returns the log a page at a time, newest first: `?limit=` (1 to 500, default 50), `?before=<seq>` from the previous page's `nextBefore`, and `?action=` to filter. `pnpm audit:export` writes a JSON file that is sealed again on the way out, so a biometric field cannot ride along. The optional Trillian port is not configured.

## Consent and threat model

- Subjects are enrolled under a Cumulus://ID™ style identifier, `cid://infinitum/...`. The VEIL seam is the named place a production enrollment capture would plug in. This MVP records consent locally.
- Each account may start at most `SEARCH_LIMIT_PER_HOUR` searches in a rolling hour (default 120; `0` turns it off). Policy refusals count too. Past the limit the API answers `429 RATE_LIMITED` and does not run a match. Only the first refusal in a window is audited, so repeated refused calls cannot flood the log. The count comes from the searches table, so it holds across restarts and API instances.
- Consent can carry an expiry per purpose (`expiresAt` on enrollment, or **Consent valid for** on the purpose desk). Once it passes, gallery searches leave the person out, a search that names them is refused with `CONSENT_EXPIRED`, and a reviewer cannot confirm a match that relied on it. Re-enrolling records a fresh grant. Consent without an expiry lasts until withdrawn.
- A subject can withdraw. Withdrawal marks consent withdrawn and deletes the sealed template. Later searches for that CID fail closed.
- A subject access report (`GET /v1/subjects/{cid}/access-report`, or **Access report** on the purpose desk) lists one person's consents and every audit entry that names them or lists them as a match candidate. Templates show as present or absent only. Admins and auditors can export it, and each export is written to the audit log as `subject_access`.
- Gallery search only considers subjects who granted the requested purpose, legal basis, and dataset.
- Every response carries `X-Request-Id` (the caller's own if it is 8 to 128 safe characters, otherwise a new UUID), and error bodies repeat it. The API writes one JSON access-log line per request: route pattern, status, duration and actor id. Raw paths, query strings, headers, bodies and tokens are never logged, so subject CIDs stay out of process logs.
- Review notes are redacted for email addresses, phone numbers, and SSN-shaped strings before they enter the audit attestation. The case file kept for the reviewer desk can still hold the original note.
- Log fields are classed safe, unsafe, or DoNotLog. Biometric names (`template`, `embedding`, `image`, and the rest of that list) are DoNotLog. The vocabulary follows Palantir's public [safe-logging](https://github.com/palantir/safe-logging) projects. Those libraries are not dependencies. See [Reference vendors](#reference-vendors).
- People sign in to both desks with [Cumulus ID](https://id.cumuluscloud.app). The API checks each bearer at the issuer and maps the Cumulus ID to a role from `CID_ADMINS`, `CID_OPERATORS`, `CID_REVIEWERS` and `CID_AUDITORS`. The seeded `dev-*` tokens work only with `EIDETIC_DEV_BEARER=true` and `DEMO_MODE=true`, for local development.
- Reads are limited by role. The subject list, the audit log and bias reports are open to admins and auditors. Reviewers, admins and auditors see the whole review queue. An operator sees only the reviews for searches they ran. Chain verification (`/v1/audit/verify`) returns hashes only and is open to every role.
- `$EIDT` on Base is a marketing stub. `attestConsentHash` accepts a 64-character sha256 and returns `broadcast: false`. Biometric payloads are refused.
- This MVP does not scrape social networks, run plate recognition, build watchlists, or track people from overhead imagery.

Synthetic fixtures (`EIDETIC-SYNTHETIC-v1`) are generated byte patterns. They are not photographs of real people.

## Isolated deployment

| Boundary | What it holds | What it must not leave |
| --- | --- | --- |
| PostgreSQL | Subjects, consent, purpose, reviews, audit attestations, template pointers | Template bytes, embeddings |
| `BIOMETRIC_STORE_PATH` | Mock template files, readable only by the matcher | Anything the HTTP API returns |
| Audit stream | Flat attestations and hashes | Images, vectors, template refs |
| Matcher process | Mock by default. OpenCV Zoo, a licensed InsightFace sidecar, or the local MediaPipe capture check when that flag is set | Embeddings and images. Mock mode makes no network call. MediaPipe reads a local model file and does not call Google Cloud |

Production should run the matcher as its own sealed service. `MatcherAdapter` is the seam. `MATCHER_MODE=insightface` constructs `InsightFaceAdapter`, which refuses to run unless a license flag and an injected client are both present. This repository does not download InsightFace weights. Those weights are often noncommercial.

## Layout

| Path | Role |
| --- | --- |
| `apps/api` | Purpose gate, match orchestration, review queue, audit API |
| `apps/reviewer` | Human review desk |
| `apps/admin` | Purpose, consent, chain verification, bias hook |
| `packages/policy` | Local RBAC + purpose + legal basis, plus an OPA client |
| `packages/consent` | Enrollment, withdrawal, VC-shaped consent receipts, Fides port |
| `packages/matcher` | Mock matcher, filesystem store, InsightFace and OpenCV/MediaPipe seams |
| `packages/audit` | Hash chain, Merkle checkpoints, Trillian port |
| `packages/bias` | Local demographic parity and equalized odds. Fairlearn is not invoked |
| `packages/mil` | ei·det·ic MIL™ boundary |
| `packages/eon-rf-defense` | Passive GNSS jamming and spoofing detection for EON's own receivers. No transmit or intercept path |
| `packages/seams` | HRVST, Spectre/+SPCTR, METATRON, VEIL, Firmament Network™, ODIN, `$EIDT`, Rasterio |
| `deploy/opa/eidetic.rego` | Illustrative policy bundle. Not authoritative until reviewed |
| `deploy/label-studio/review.xml` | Optional labeling-config shape. The shipped desk is the custom UI |

## Run locally

Requirements: Node.js 22, pnpm 10, PostgreSQL 16. Docker Compose is the other path and publishes Postgres on port 54329.

```bash
cp .env.example .env
# create the role and database if you are not using Compose
# CREATE ROLE eidetic LOGIN PASSWORD 'eidetic';
# CREATE DATABASE eidetic OWNER eidetic;
pnpm install
pnpm dev
```

- API: [http://127.0.0.1:43110/v1/health](http://127.0.0.1:43110/v1/health)
- Review desk: [http://127.0.0.1:43111](http://127.0.0.1:43111)
- Purpose desk: [http://127.0.0.1:43112](http://127.0.0.1:43112)

Sign in to each desk with **Sign in with Cumulus ID**. No Cumulus ID yet? **Create a Cumulus ID** is in the same flow and returns you to the desk signed in. Put your Cumulus ID in `CID_ADMINS` (purpose desk) or `CID_REVIEWERS` (review desk) in `.env`.

Local development without Cumulus ID: set `EIDETIC_DEV_BEARER=true` for the API and `VITE_EIDETIC_DEV_BEARER=dev-admin` (or `dev-reviewer`) for `pnpm dev`. The API refuses this flag when `DEMO_MODE=false` or `NODE_ENV=production`, and production builds of the desks ignore it. `pnpm demo:http` needs it too. Seeded tokens:

| Person | Role | Token |
| --- | --- | --- |
| Idris Hale | admin | `dev-admin` |
| Mira Calder | operator | `dev-operator` |
| Helen Cho | reviewer | `dev-reviewer` |
| Noor Patel | auditor | `dev-auditor` |

Seeded purposes are `record_reconciliation` (business), `access_control` (business), and `consented_assistance` (civilian).

### Without PostgreSQL

```bash
pnpm dev:memory
```

Starts the API with in-memory stores and the mock matcher, plus both desks signed in with the seeded dev tokens (`apps/*/.env.memory`): the review desk as `dev-reviewer`, the purpose desk as `dev-admin`. One synthetic review is queued. Nothing is persisted. It is for trying the desks locally and refuses to start when `NODE_ENV=production` or `DEMO_MODE=false`.

### Docker Compose

```bash
docker compose up --build
```

The review and purpose desks proxy `/v1` to the API, so they are same-origin. A desk served from another origin needs that origin in `ALLOWED_ORIGINS`. The API sends standard security headers, marks every `/v1` response `Cache-Control: no-store`, and refuses request bodies over 1MB. Postgres is on host port 54329. Set `DEMO_MODE=false` before any shared deployment, and do not rely on the dev tokens.

### Demo

`pnpm demo` runs the story in memory: enroll Avery Quinn and Jordan Blake, authorize record reconciliation, match in mock mode, block the operator from self-approval, let the reviewer confirm, then show purpose denial, consent withdrawal, the MIL refusal, and the hash chain.

`pnpm demo:http` talks to a running API. The review desk also has **Load synthetic demo**, which re-enrolls those two fixtures and queues a new unconfirmed review.

### Tests

```bash
pnpm test
pnpm typecheck
```

Unit tests cover the happy path and the denial paths without Postgres. `apps/api/src/pg/pg.integration.test.ts` runs when `postgres://eidetic:eidetic@127.0.0.1:5432/eidetic_test` is reachable. It checks the append-only trigger.

## Vision adapters

`MATCHER_MODE=mock` and `CAPTURE_PROVIDER=local` are the defaults. CI uses them. They score `EIDETIC-SYNTHETIC-v1` fixture tokens inside the process. No weights are downloaded.

The recommended non-mock matcher is OpenCV Zoo YuNet plus SFace. YuNet's model files are MIT (Copyright Shiqi Yu). SFace's model files are Apache-2.0. Both licenses allow commercial use of those files. NOTICE records the training-data caveat. InsightFace is not the recommended path.

```bash
pnpm matcher:fetch-models
pip install opencv-python-headless
MATCHER_MODE=opencv-zoo pnpm --filter @eidetic/api dev
```

That path accepts `syntheticPortraitPng` images, which carry the marker `eidetic-synthetic-portrait`. A photograph without that marker is refused unless `EIDETIC_ALLOW_OPERATOR_CAPTURES=true`. Fixture tokens stay on the mock matcher. If YuNet finds no face, enroll stops. The embedding is written only into the sealed template file.

[InsightFace](https://github.com/deepinsight/insightface) pretrained weights are often limited to noncommercial research. This repository does not ship those weights. To point at a sidecar you operate inside the sealed boundary:

```bash
MATCHER_MODE=insightface
INSIGHTFACE_LICENSE_ACCEPTED=true
INSIGHTFACE_URL=http://127.0.0.1:43120
```

Without both the license flag and the URL, the process refuses to start. The sidecar contract receives the synthetic fixture id, not an embedding, and a response that contains an `embedding` field is rejected.

Capture quality stays on the local statistical gate unless you set `CAPTURE_PROVIDER=opencv-mediapipe`. The default remains `local`. CI does not download a model and does not run MediaPipe.

That setting runs Google's open-source [MediaPipe](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector) Face Detector next to [OpenCV](https://opencv.org/), on this machine. The model is BlazeFace short-range (Apache-2.0). The process reads the `.tflite` file from disk. It does not call Google Cloud, Vertex AI, or a billed Vision API, and it does not take an API key.

```bash
pnpm matcher:fetch-mediapipe-model
pip install -r packages/matcher/python/requirements-mediapipe.txt
# Debian/Ubuntu: MediaPipe's native library needs libegl1 and libgl1
CAPTURE_PROVIDER=opencv-mediapipe
# OPENCV_MEDIAPIPE_PYTHON=/path/to/venv/bin/python
```

The gate checks that OpenCV can decode the frame, that MediaPipe finds exactly one face, and that the Laplacian variance is high enough that the frame is not blank. The score is presence and blur. It is not an identity. Boxes, the six face keypoints, and embeddings are dropped inside the Python process and are not stored. A synthetic fixture token never reaches the detector. A synthetic portrait does. Any other photograph is refused unless `EIDETIC_ALLOW_OPERATOR_CAPTURES=true`. Set that flag only inside a deployment that is allowed to receive operator captures. Do not send photographs of public figures.

Enrollment and search still go through the purpose and consent checks already in the API. This flag does not keep the image and does not add a store. The quality number on the template is the column the product already writes.

To use a sidecar you operate instead of the local process, set `OPENCV_MEDIAPIPE_URL`. That request carries the synthetic fixture id, not the image. Leave the URL unset to run MediaPipe locally. Without the model file and without that URL, the process refuses to start.

## Purpose, consent, and Keycloak

The API uses the embedded policy decider, which applies the same denial order as `deploy/opa/eidetic.rego`: edition, purpose, role, legal basis, dataset, then consent when a subject CID is named. Set `OPA_URL` to hand that decision to [Open Policy Agent](https://www.openpolicyagent.org/). An unreachable OPA fails closed.

People sign in with Cumulus ID (OAuth 2.0 code + PKCE in the desk through the Cumulus://ID account bar, `/cumulus-bar.js`, a copy of `https://id.cumuluscloud.app/id/bar.js`). The API calls `{CID_ISSUER}/api/id/userinfo` with the bearer, caches the answer for a minute, and maps the CID to a role. A Cumulus ID that is on no role list gets 403. `CID_ISSUER` (default `https://id.cumuluscloud.app`) and `CID_ISSUER_MIRROR` (tried only when the issuer cannot be reached) let a mirror that loads in Russia be used; build the desks with `VITE_CID_ISSUER` to match. With `DEMO_MODE=false`, `CID_ADMINS` is required.

Machines can still use [Keycloak](https://www.keycloak.org/) client tokens: with `KEYCLOAK_ISSUER` and `KEYCLOAK_AUDIENCE` set, the API also verifies access tokens with [`jose`](https://github.com/panva/jose) (MIT) against the realm JWKS (`KEYCLOAK_JWKS_URL`, or `{issuer}/protocol/openid-connect/certs`).

## Audit commands

```bash
pnpm audit:verify
pnpm audit:export -- --out audit-export.json
pnpm audit:verify -- --file audit-export.json
```

Checkpoints are signed with Ed25519. Verifiers need the public key, which is included in the export. Set `AUDIT_SIGNER=openbao` with `OPENBAO_ADDR`, `OPENBAO_TOKEN`, and an Ed25519 Transit key (`OPENBAO_TRANSIT_KEY`) to sign in [OpenBao](https://github.com/openbao/openbao) (MPL-2.0). Otherwise set `AUDIT_ED25519_KEY_PATH` or `AUDIT_ED25519_PRIVATE_KEY`. Demo mode writes `data/audit-ed25519.pem` when no key is configured. `DEMO_MODE=false` refuses to start without OpenBao or an explicit key, and it also refuses to start without Keycloak. The old HMAC development key is not accepted.

## Fixture fairness

`POST /v1/bias/fixture-evaluations` scores cases whose cohort comes from `FIXTURE_COHORTS` (`avery-quinn`, `jordan-blake`, `casey-morgan`). Those keys are written on the fixture card. The hook does not classify a face, and [Fairlearn](https://fairlearn.org/) is not executed. The metric names match Fairlearn's demographic parity and equalized odds differences.

## Site context

`packages/geo` answers `GET /v1/sites/hq-washington` with the Washington office asset. Rasterio is not imported. Requests that ask to follow a person, drone, satellite, or plate are refused.

## Geo routing

Country and site-category labels are optional and off by default. They are a cyber routing annotation. They are not used for identity matching, and they do not change who can be searched.

Both switches have to be on. `INFINITUM_GEO_ENABLED=true` is the process opt-in. The persisted toggle lives in `data/settings.json` and defaults to false. Set it from the purpose desk, or with `pnpm geo:routing -- --on` and `--off`. `pnpm geo:routing -- --status` prints both switches.

```bash
pnpm geo:fetch
```

That downloads pinned v2fly releases into `data/geo/` and checks them against the official `.sha256sum` files and `packages/geo/geo.lock.json`. The binaries are not committed. The lists are v2fly `geoip.dat` (CC-BY-SA-4.0) and `dlc.dat` saved as `geosite.dat` (MIT). Loyalsoldier and sing-box datasets are not used.

A search can include `routing: { ip, domain }`. When the hook is active, the response and the process log gain a country code and site categories. The raw address is not written to the audit log. The matcher does not see it. When either switch is off, the search response is unchanged.

## Replacing the mock matcher

Implement `MatcherAdapter` (`assess`, `enroll`, `match`, `purge`). Keep template bytes inside that class. `match` must return confidence and explainable evidence only. `createMatcher` is the env-flag factory.

## Optional adapters

Leave the URLs unset unless that service is actually running beside this API.

| Variable | Adapter | Public project |
| --- | --- | --- |
| `OPENCV_MEDIAPIPE_URL` | Optional capture-quality sidecar. When this is unset, `CAPTURE_PROVIDER=opencv-mediapipe` runs MediaPipe in a local Python process | [MediaPipe Face Detector](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector) |
| `OPA_URL` | External purpose, legal-basis, and consent decision. Embedded rules run when this is unset | [Open Policy Agent](https://www.openpolicyagent.org/) |
| `KEYCLOAK_ISSUER` | Optional machine-to-machine tokens. People sign in with Cumulus ID | [Keycloak](https://www.keycloak.org/) |
| `FIDES_URL` | Export of a consent receipt. Local consent stays authoritative | [Fides](https://github.com/ethyca/fides) |
| `PRESIDIO_URL` | Recognized, not proxied. Local pattern redaction stays on so notes are not shipped out | [Presidio](https://github.com/microsoft/presidio) |
| Fairlearn | Metric names match `demographic_parity_difference` and `equalized_odds_difference`. The Python library is not called | [Fairlearn](https://fairlearn.org/) |
| Trillian | Checkpoint port returns `not_configured` | [Trillian](https://github.com/google/trillian) |
| Verifiable Credentials | Local sha256 consent receipt in the W3C shape. Not a Digital Bazaar signature | [vc](https://github.com/digitalbazaar/vc), [VC data model](https://www.w3.org/TR/vc-data-model-2.0/) |
| Rasterio | `packages/geo` holds site and asset context. The Rasterio library is not imported. Person tracking is refused | [Rasterio](https://rasterio.readthedocs.io/) |
| Label Studio | The review task shape is in `deploy/label-studio/review.xml` | [Label Studio](https://labelstud.io/) |

Cohort labels for the bias hook are supplied by the evaluation designer. The software does not infer demographics from a face.

## Reference vendors

Flock Safety and Palantir were reviewed as reference vendors. This repository does not ship, call, or wrap their proprietary products, and it does not scrape them.

Palantir publishes platform libraries that are useful as reading, not as dependencies:

- [safe-logging](https://github.com/palantir/safe-logging) and [safe-logging-go](https://github.com/palantir/safe-logging-go) (Apache-2.0). Mark values Safe, Unsafe, or DoNotLog before they reach a log line. ei·det·ic™ treats biometric templates, images, and embeddings as DoNotLog. The redactor in this repo is local code.
- [witchcraft-go-logging](https://github.com/palantir/witchcraft-go-logging) and [witchcraft-api](https://github.com/palantir/witchcraft-api) (Apache-2.0). Keep structured service logs distinct from an audit category. Our hash-chained log is a separate store from process logs. Palantir's audit category definitions are not imported.
- [Conjure](https://github.com/palantir/conjure) (Apache-2.0). One typed HTTP contract can later generate clients. The MVP uses hand-written TypeScript types.

Flock Safety's public GitHub organization, [flocksafety](https://github.com/flocksafety), does not publish a consent ledger, matcher, or audit log appropriate to this product. Their camera and license-plate products are proprietary and out of scope. This MVP does not do plate recognition, city-wide camera search, or inter-agency watchlists.

## Contact

Infinitum Corporation®  
1629 K Street NW, Suite 300, Washington, D.C.  
202-729-9509  
info@theinfinitumcorporation.com

Cyber and security consulting context for this product is identity matching under consent, purpose limits, human review, and a tamper-evident record.

## License

Source in this repository is © Infinitum Corporation®, all rights reserved. See `LICENSE` and `NOTICE`. Third-party packages keep their own licenses.
