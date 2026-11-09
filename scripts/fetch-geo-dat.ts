// © Infinitum Corporation®. All rights reserved.
// Downloads pinned v2fly geoip.dat and geosite.dat (published as dlc.dat).
// Official .sha256sum assets are checked against data/geo/geo-dat.lock.json.
// A mismatch stops the script before the binary is written. Binaries are not committed.

import path from "node:path";
import { downloadGeoDatasets } from "../packages/geo/src/fetch.js";

const dirFlag = process.argv.indexOf("--dir");
const dataDir = dirFlag >= 0 ? path.resolve(process.argv[dirFlag + 1] ?? "") : path.resolve(process.cwd(), "data/geo");

await downloadGeoDatasets(dataDir);
console.log(`v2fly geo datasets verified and saved under ${dataDir}`);
