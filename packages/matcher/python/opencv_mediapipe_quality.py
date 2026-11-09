# © Infinitum Corporation®. All rights reserved.
# Local capture-quality check. MediaPipe Tasks Face Detector (Apache-2.0)
# answers whether one face is present. OpenCV measures blur. The model file
# is read from disk. This process does not call Google Cloud, and it prints
# no box, keypoint, landmark, or embedding.

import base64
import json
import sys


MAX_BYTES = 512 * 1024
MIN_DETECTION_CONFIDENCE = 0.5


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError:
        print("unreadable request", file=sys.stderr)
        return 1
    model = request.get("modelPath") if isinstance(request, dict) else None
    if not isinstance(model, str) or remote_model(model):
        print("model path must be a local file", file=sys.stderr)
        return 1
    encoded = request.get("imageBase64")
    if not isinstance(encoded, str):
        print("image missing", file=sys.stderr)
        return 1
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception:
        print("image missing", file=sys.stderr)
        return 1
    if len(raw) > MAX_BYTES:
        print("capture too large", file=sys.stderr)
        return 1
    try:
        payload = assess(model, raw)
    except Exception as exc:
        print(f"MediaPipe quality check failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    print(json.dumps(payload))
    return 0


def remote_model(path: str) -> bool:
    lowered = path.strip().lower()
    return not lowered or "://" in lowered


def assess(model: str, raw: bytes) -> dict:
    import os

    os.environ.setdefault("GLOG_minloglevel", "3")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
    os.environ.setdefault("ABSL_MIN_LOG_LEVEL", "3")

    import cv2
    import numpy as np
    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    if not os.path.isfile(model):
        raise FileNotFoundError("model file")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return {"decoded": False, "faceCount": 0, "topScore": 0, "blurVariance": 0}
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    rgb = np.ascontiguousarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    options = vision.FaceDetectorOptions(
        base_options=python.BaseOptions(model_asset_path=model, delegate=python.BaseOptions.Delegate.CPU),
        min_detection_confidence=MIN_DETECTION_CONFIDENCE,
    )
    detector = vision.FaceDetector.create_from_options(options)
    try:
        result = detector.detect(mp_image)
    finally:
        detector.close()
    scores = []
    for detection in list(result.detections or []):
        categories = list(detection.categories or [])
        if not categories:
            continue
        scores.append(float(categories[0].score))
    return {
        "decoded": True,
        "faceCount": len(scores),
        "topScore": max(scores) if scores else 0.0,
        "blurVariance": blur,
    }


if __name__ == "__main__":
    sys.exit(main())
