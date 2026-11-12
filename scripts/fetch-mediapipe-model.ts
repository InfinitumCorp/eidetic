// © Infinitum Corporation®. All rights reserved.
// Downloads the MediaPipe BlazeFace short-range face detector.
// The file is Apache-2.0 and is not committed. Inference reads it from disk.
// This script does not call a Google Cloud vision API and does not need a key.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const file = {
  name: "blaze_face_short_range.tflite",
  url: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
  sha256: "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f",
  license: "Apache-2.0",
};

const destination = path.resolve(process.cwd(), "data/models/mediapipe");
mkdirSync(destination, { recursive: true });
const response = await fetch(file.url);
if (!response.ok) throw new Error(`Download failed for ${file.name}: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== file.sha256) {
  throw new Error(`SHA-256 mismatch for ${file.name}. Refusing to write the file.`);
}
writeFileSync(path.join(destination, file.name), bytes);
console.log(`${file.name} ${bytes.length} bytes ${file.license}`);
