"""Export an UNTRAINED copy of SLOT1's production scene model for load testing.

Same architecture, input size and ONNX layout as ml/train_scene.py (MobileNetV3-Small backbone,
scene + event heads, dynamic batch axis), with random weights: its predictions mean nothing, but
its compute cost is the real one. Never upload this file to the model registry.

usage: python3 export_bench_model.py OUT_DIR --arch mobilenet_v3_small --size 224 --scenes '[...]' --events '[...]'
"""
import argparse
import json
import os
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ml"))
from slot1_ml.scene import IMAGENET_MEAN, IMAGENET_STD, SceneNet  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--arch", default="mobilenet_v3_small", choices=["mobilenet_v3_small", "tiny"])
ap.add_argument("--size", type=int, default=224)
ap.add_argument("--scenes", required=True)
ap.add_argument("--events", required=True)
args = ap.parse_args()
scenes, events = json.loads(args.scenes), json.loads(args.events)

torch.manual_seed(0)
model = SceneNet(args.arch, len(scenes), len(events), pretrained=False).eval()
os.makedirs(args.out, exist_ok=True)
name = f"bench-{args.arch}-{args.size}"
onnx_path = os.path.join(args.out, f"{name}.onnx")
dummy = torch.randn(1, 3, args.size, args.size)
torch.onnx.export(
    model,
    (dummy,),
    onnx_path,
    input_names=["input"],
    output_names=["scene_logits", "event_logits"],
    dynamic_axes={"input": {0: "batch"}, "scene_logits": {0: "batch"}, "event_logits": {0: "batch"}},
    opset_version=17,
    dynamo=False,
)
meta = {
    "name": name,
    "version": "untrained-bench",
    "task": "scene",
    "classes": {"scenes": scenes, "events": events},
    "input": {"name": "input", "width": args.size, "height": args.size, "mean": IMAGENET_MEAN, "std": IMAGENET_STD, "batched": True},
    "outputs": {"scene": "scene_logits", "events": "event_logits"},
}
with open(os.path.join(args.out, f"{name}.json"), "w") as f:
    json.dump(meta, f, indent=2)
print(onnx_path)
