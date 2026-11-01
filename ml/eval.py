#!/usr/bin/env python3
"""Evaluate any registered ONNX model on a dataset export's frozen test split (no PyTorch needed).

  python ml/eval.py --model gta-scene-2026.11.1.onnx --metadata gta-scene-2026.11.1.json \
      --data slot1-gta-dataset-v4.zip --out eval-v4.json

Upload the JSON in Studio → GTA model → Add evaluation. SLOT1 compares a candidate with the active
model only on the same test split, so evaluate both on the newest dataset version.
"""
import argparse
import json
import os
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slot1_ml.data import DatasetExport  # noqa: E402
from slot1_ml.export import evaluation  # noqa: E402
from slot1_ml.metrics import average_precision, classification_report, mean_ap  # noqa: E402


def tensor(img, spec):
    x = np.asarray(img.resize((spec["width"], spec["height"])), dtype=np.float32) / 255.0
    x = (x - np.array(spec["mean"], dtype=np.float32)) / np.array(spec["std"], dtype=np.float32)
    x = x.transpose(2, 0, 1)
    return x[None] if spec.get("batched", True) else x


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True)
    ap.add_argument("--metadata", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with open(args.metadata) as f:
        meta = json.load(f)
    export = DatasetExport(args.data)
    if int(meta["taxonomyVersion"]) != int(export.classes["version"]):
        sys.exit("Model and dataset use different taxonomy versions.")
    spec, outputs = meta["input"], meta["outputs"]
    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    test = export.split("test")

    if meta["task"] == "scene":
        scenes = meta["classes"]["scenes"]
        ys, ps = [], []
        for item in test:
            scene_logits = session.run([outputs["scene"]], {spec["name"]: tensor(export.image(item), spec)})[0][0]
            ys.append(scenes.index(item["scene"]) if item["scene"] in scenes else scenes.index("other"))
            ps.append(int(np.argmax(scene_logits)))
        rep = classification_report(ys, ps, scenes)
        result = evaluation(export, "macro_f1", rep["macro_f1"], len(test), rep["accuracy"], rep["per_class"])
    else:
        boxes_cls = meta["classes"]["boxes"]
        dets = {c: [] for c in boxes_cls}
        gts = {c: {} for c in boxes_cls}
        for idx, item in enumerate(test):
            w, h = spec["width"], spec["height"]
            for b in item.get("boxes", []):
                if b["class"] in boxes_cls:
                    gts[b["class"]].setdefault(idx, []).append([b["x"] * w, b["y"] * h, (b["x"] + b["w"]) * w, (b["y"] + b["h"]) * h])
            boxes, scores, labels = session.run([outputs["boxes"], outputs["scores"], outputs["labels"]], {spec["name"]: tensor(export.image(item), spec)})
            for box, score, label in zip(boxes.tolist(), scores.tolist(), labels.tolist()):
                if 1 <= int(label) <= len(boxes_cls):
                    dets[boxes_cls[int(label) - 1]].append((idx, float(score), box))
        per_class = {c: average_precision(dets[c], gts[c]) for c in boxes_cls}
        result = evaluation(export, "map50", mean_ap(per_class), len(test))
    with open(args.out, "w") as f:
        json.dump([result], f, indent=2)
    print(f"{meta['name']} {meta['version']} on dataset v{export.meta['version']} test split ({len(test)} frames): {result['primaryMetric']} {result['value']:.3f}")


if __name__ == "__main__":
    main()
