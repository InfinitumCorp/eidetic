#!/usr/bin/env sh
# Re-extract the desk catalogs, then check and bundle them.
# Uses @infinitum/i18n from an infinitum-nexus checkout (NEXUS, default ../infinitum-nexus).
#
# Each desk's catalog covers its own UI plus the API messages it shows: refusals,
# validation errors and audit messages from the service and its packages. The desk
# translates them when they are rendered, so the API itself stays English-only.
set -eu
status=0
NEXUS="${NEXUS:-../infinitum-nexus}"
I18N="$NEXUS/packages/i18n/scripts"
API_SOURCES="apps/api/src/app.ts packages/pipeline/src packages/policy/src packages/consent/src packages/mil/src packages/matcher/src packages/bias/src packages/contracts/src packages/seams/src"

for desk in admin reviewer; do
  dir="apps/$desk/src/i18n/locales"
  # shellcheck disable=SC2086
  node --experimental-strip-types "$I18N/extract.ts" --out "$dir" "apps/$desk/src" $API_SOURCES
  if [ "${1:-}" = "--check" ]; then
    node --experimental-strip-types "$I18N/translate.ts" --dir "$dir" --check || status=1
  else
    node --experimental-strip-types "$I18N/translate.ts" --dir "$dir" --bundle "apps/$desk/src/i18n/catalogs.js"
  fi
done
exit $status
