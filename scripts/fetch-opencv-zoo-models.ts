// © Infinitum Corporation®. All rights reserved.
// Downloads YuNet (MIT) and SFace (Apache-2.0) ONNX weights from opencv_zoo.
// The files are not committed. See NOTICE for the license caveat on training data.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const files = [
  {
    name: "face_detection_yunet_2023mar.onnx",
    url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    license: "MIT",
  },
  {
    name: "face_recognition_sface_2021dec.onnx",
    url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    license: "Apache-2.0",
  },
];

const destination = path.resolve(process.cwd(), "data/models/opencv-zoo");
mkdirSync(destination, { recursive: true });

for (const file of files) {
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`Download failed for ${file.name}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(path.join(destination, file.name), bytes);
  console.log(`${file.name} ${bytes.length} bytes ${file.license}`);
}
