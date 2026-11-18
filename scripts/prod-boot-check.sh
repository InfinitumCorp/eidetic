#!/usr/bin/env sh
# Boot the API the way production does and check two things:
#   1. With NODE_ENV=production and DEMO_MODE left unset, it refuses to start.
#   2. With DEMO_MODE=false, an Ed25519 audit key and a Cumulus ID admin, it serves /v1/health out of demo mode.
# Needs DATABASE_URL pointing at a disposable Postgres database.
set -eu
: "${DATABASE_URL:?set DATABASE_URL to a disposable Postgres database}"
PORT="${PORT:-43190}"
work="$(mktemp -d)"
trap 'kill "$api" 2>/dev/null || true; rm -rf "$work"' EXIT
api=""

echo "1. NODE_ENV=production without DEMO_MODE must refuse to start"
if NODE_ENV=production PORT="$PORT" BIOMETRIC_STORE_PATH="$work/templates" \
   timeout 90 pnpm --filter @eidetic/api start >"$work/refuse.log" 2>&1; then
  echo "FAIL: the API started in demo mode under NODE_ENV=production"; cat "$work/refuse.log"; exit 1
fi
grep -q "Set DEMO_MODE=false for production" "$work/refuse.log" || { echo "FAIL: refused for another reason"; cat "$work/refuse.log"; exit 1; }
echo "   ok: refused"

echo "2. Production settings must start and report demo mode off"
openssl genpkey -algorithm ed25519 -out "$work/audit.pem"
NODE_ENV=production DEMO_MODE=false PORT="$PORT" BIOMETRIC_STORE_PATH="$work/templates" \
  AUDIT_SIGNER=env AUDIT_ED25519_KEY_PATH="$work/audit.pem" CID_ADMINS=ci-boot-check-admin \
  pnpm --filter @eidetic/api start >"$work/boot.log" 2>&1 &
api=$!
for _ in $(seq 1 60); do
  body="$(curl -fsS "http://127.0.0.1:$PORT/v1/health" 2>/dev/null || true)"
  [ -n "$body" ] && break
  sleep 1
done
[ -n "$body" ] || { echo "FAIL: /v1/health never answered"; cat "$work/boot.log"; exit 1; }
echo "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);if(b.db!=="ok"||b.demoMode!==false||b.milEnabled!==false){console.error("FAIL: unexpected health",b);process.exit(1)}console.log("   ok:",JSON.stringify({db:b.db,demoMode:b.demoMode,milEnabled:b.milEnabled}))})'
