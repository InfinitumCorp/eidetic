# Launch checklist

What has to be true before ei·det·ic takes real people. Each item says who does it.

## 1. Infrastructure (William)

- [ ] Pick the host for three containers: `api`, `reviewer`, `admin`. Build each from its Dockerfile.
- [ ] Provision PostgreSQL 16. The API runs its migrations at startup.
- [ ] Create a private volume for `BIOMETRIC_STORE_PATH`. Only the API container mounts it.
- [ ] Set up DNS and TLS for the two desk hostnames. The desks proxy `/v1/` to the API, so the API needs no public hostname.

## 2. Secrets and settings (William)

Start from `deploy/production.env.example`. Never commit real values.

- [ ] `DEMO_MODE=false`. The image sets `NODE_ENV=production` and refuses to start in demo mode.
- [ ] Audit signing: OpenBao Transit (`AUDIT_SIGNER=openbao`, plus `OPENBAO_ADDR`, `OPENBAO_TOKEN` and `OPENBAO_TRANSIT_KEY`), or an Ed25519 key file (`openssl genpkey -algorithm ed25519`). The API refuses to start without one.
- [ ] `CID_ADMINS` holds at least one Cumulus ID. Add `CID_REVIEWERS`, `CID_OPERATORS` and `CID_AUDITORS` as people join.
- [ ] `DATABASE_URL` points at the production database.

## 3. Sign-in (William, in Cumulus ID)

- [ ] Register the desk clients `eidetic-admin` and `eidetic-reviewer` with their production redirect URLs.
- [ ] For people in Russia, build the desks with `--build-arg VITE_CID_ISSUER=<mirror>` and set `CID_ISSUER_MIRROR` on the API. Confirm sign-in works there without a VPN.

## 4. Desk build arguments

| Argument | Desk | Default |
| --- | --- | --- |
| `VITE_CID_ISSUER` | both | `https://id.cumuluscloud.app` |
| `VITE_REVENUE_URL` | purpose desk | the Infinitum revenue worker |
| `VITE_AMPLITUDE_API_KEY` | both | the bundled public key |

If `VITE_REVENUE_URL` changes, update `connect-src` in `apps/admin/nginx.conf` to match.

## 5. Smoke test after deploy

Run the automated part first. It checks that each desk loads, proxies `/v1/health`, sends the security headers and that the API is up, out of demo mode and with MIL off:

```bash
node scripts/smoke.mjs https://<review-desk> https://<purpose-desk>
```

Then by hand:

- [ ] An admin signs in with Cumulus ID, publishes a purpose and enrolls a synthetic subject.
- [ ] A reviewer signs in. An operator search runs, and the reviewer records a decision. The person who ran the search cannot decide it.
- [ ] The audit chain verifies in the purpose desk, and the signed export downloads.
- [ ] Switch the language to Russian and Arabic. A refusal (for example, a search without a purpose) shows translated.
- [ ] The browser console shows no CSP violations.

## 6. Known limits at launch

- Matching runs on the mock matcher (`MATCHER_MODE=mock`). A real model needs its own license decision.
- Desk translations have not had a native-speaker review.
- `packages/eon-rf-defense` (an E(O)N defense package) sits in this repo. ei·det·ic is positioned as civilian and business only. Decide whether it belongs here before launch.

## Rollback

Redeploy the previous image tags. Migrations only add tables and columns, so the previous API version runs on the newer schema. Check this for each release that adds a migration.
