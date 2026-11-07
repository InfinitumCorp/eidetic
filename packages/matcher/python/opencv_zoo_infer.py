# © Infinitum Corporation®. All rights reserved.
# YuNet (MIT, Shiqi Yu) detects a face. SFace (Apache-2.0) embeds it.
# This process does not download weights and does not log the embedding.

import base64
import json
import sys

import cv2
import numpy as np


def main() -> None:
    request = json.load(sys.stdin)
    encoded = base64.b64decode(request["imageBase64"])
    image = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        print(json.dumps({"faceFound": False, "detectorScore": 0, "embedding": None}))
        return
    height, width = image.shape[:2]
    detector = cv2.FaceDetectorYN.create(request["yunet"], "", (width, height), 0.6, 0.3, 5000)
    _, faces = detector.detect(image)
    if faces is None or len(faces) == 0:
        print(json.dumps({"faceFound": False, "detectorScore": 0, "embedding": None}))
        return
    face = max(faces, key=lambda row: float(row[2]) * float(row[3]))
    recognizer = cv2.FaceRecognizerSF.create(request["sface"], "")
    aligned = recognizer.alignCrop(image, face)
    feature = recognizer.feature(aligned).flatten().astype(float).tolist()
    print(json.dumps({"faceFound": True, "detectorScore": float(face[-1]), "embedding": feature}))


if __name__ == "__main__":
    main()
