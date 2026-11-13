// © Infinitum Corporation®. All rights reserved.
// Persists the geo-routing toggle. Default is off.
// INFINITUM_GEO_ENABLED must also be true before the hook runs.

import {
  defaultGeoSettingsPath,
  geoRoutingActive,
  infinitumGeoEnabled,
  readGeoRoutingSettings,
  writeGeoRoutingSettings,
} from "../packages/geo/src/index.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const on = args.includes("on") || args.includes("--on");
const off = args.includes("off") || args.includes("--off");
if (on && off) {
  console.error("Pass only one of --on or --off.");
  process.exit(2);
}
if (args.some((arg) => !["on", "off", "status", "--on", "--off", "--status"].includes(arg))) {
  console.error("Usage: geo-routing.ts [--on | --off | --status]");
  process.exit(2);
}

const file = defaultGeoSettingsPath();
const settings = on ? writeGeoRoutingSettings(file, true) : off ? writeGeoRoutingSettings(file, false) : readGeoRoutingSettings(file);
const processOptIn = infinitumGeoEnabled();
console.log(
  JSON.stringify(
    {
      geoRouting: settings.geoRouting,
      processOptIn,
      active: geoRoutingActive(processOptIn, settings),
      settings: file,
      identityMatch: false,
    },
    null,
    2,
  ),
);
