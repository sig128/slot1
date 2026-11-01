#!/usr/bin/env python3
"""Train SLOT1's GTA scene + event classifier on a dataset export and write model.onnx + metadata.json.

  python ml/train_scene.py --data slot1-gta-dataset-v3.zip --out runs/scene-v3 --version 2026.11.1

Upload both files in Studio → GTA model → Upload model (operators only).
"""
import argparse
import os
import random
import sys

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slot1_ml.data import DatasetExport  # noqa: E402
from slot1_ml.device import pick_device  # noqa: E402
from slot1_ml.export import check_onnx, evaluation, export_onnx, write_metadata  # noqa: E402
from slot1_ml.metrics import classification_report  # noqa: E402
from slot1_ml.scene import IMAGENET_MEAN, IMAGENET_STD, SceneNet  # noqa: E402


class SceneDataset(Dataset):
    def __init__(self, export: DatasetExport, items, size: int, train: bool):
        self.export, self.items, self.size, self.train = export, items, size, train
        self.scenes, self.events = export.scenes, export.events

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        item = self.items[i]
        img = self.export.image(item).resize((self.size, self.size))
        x = torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0).permute(2, 0, 1)
        if self.train and random.random() < 0.5:
            # Mild photometric jitter only: HUD positions matter, so no flips or crops.
            x = (x * random.uniform(0.85, 1.15)).clamp(0, 1)
        x = (x - torch.tensor(IMAGENET_MEAN)[:, None, None]) / torch.tensor(IMAGENET_STD)[:, None, None]
        scene = self.scenes.index(item["scene"]) if item["scene"] in self.scenes else self.scenes.index("other")
        events = torch.zeros(len(self.events))
        for e in item.get("events", []):
            if e in self.events:
                events[self.events.index(e)] = 1.0
        return x, scene, events


@torch.no_grad()
def predict(model, loader, device):
    model.eval()
    ys, ps = [], []
    for x, scene, _ in loader:
        logits, _ = model(x.to(device))
        ys += scene.tolist()
        ps += logits.argmax(1).cpu().tolist()
    return ys, ps


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="dataset export (.zip or folder)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--arch", default="mobilenet_v3_small", choices=["mobilenet_v3_small", "tiny"])
    ap.add_argument("--no-pretrained", action="store_true", help="don't download ImageNet weights")
    ap.add_argument("--size", type=int, default=224)
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--name", default="gta-scene")
    ap.add_argument("--version", required=True)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = pick_device(args.device)
    export = DatasetExport(args.data)
    train, val, test = export.split("train"), export.split("val"), export.split("test")
    if not train:
        sys.exit("The dataset has no training frames.")
    print(f"dataset v{export.meta['version']}: {len(train)} train / {len(val)} val / {len(test)} test frames on {device}")

    model = SceneNet(args.arch, len(export.scenes), len(export.events), pretrained=not args.no_pretrained).to(device)
    loaders = {
        name: DataLoader(SceneDataset(export, items, args.size, train=(name == "train")), batch_size=args.batch_size, shuffle=(name == "train"))
        for name, items in (("train", train), ("val", val), ("test", test))
    }
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    ce, bce = nn.CrossEntropyLoss(), nn.BCEWithLogitsLoss()
    best_state, best_f1 = None, -1.0
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for x, scene, events in loaders["train"]:
            x, scene, events = x.to(device), scene.to(device), events.to(device)
            scene_logits, event_logits = model(x)
            loss = ce(scene_logits, scene) + bce(event_logits, events)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss) * len(x)
        if val:
            ys, ps = predict(model, loaders["val"], device)
            f1 = classification_report(ys, ps, export.scenes)["macro_f1"]
        else:
            f1 = -total  # no validation split yet: keep the latest
        print(f"epoch {epoch + 1}/{args.epochs}  loss {total / len(train):.4f}  val macro-F1 {f1:.3f}")
        if f1 >= best_f1:
            best_f1, best_state = f1, {k: v.detach().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)

    ys, ps = predict(model, loaders["test"], device) if test else ([], [])
    report = classification_report(ys, ps, export.scenes)
    print(f"test: {len(test)} frames, accuracy {report['accuracy']:.3f}, macro-F1 {report['macro_f1']:.3f}")
    if not test:
        print("warning: empty test split; SLOT1 won't activate a model without a test evaluation")

    os.makedirs(args.out, exist_ok=True)
    onnx_path = os.path.join(args.out, f"{args.name}-{args.version}.onnx")
    model = model.cpu().eval()
    dummy = torch.randn(1, 3, args.size, args.size)
    export_onnx(model, (dummy,), onnx_path, ["input"], ["scene_logits", "event_logits"], {"input": {0: "batch"}, "scene_logits": {0: "batch"}, "event_logits": {0: "batch"}})
    with torch.no_grad():
        expected = [t.numpy() for t in model(dummy)]
    diff = check_onnx(onnx_path, {"input": dummy.numpy()}, expected)
    print(f"ONNX verified with onnxruntime (max diff {diff:.2e}): {onnx_path}")

    write_metadata(
        os.path.join(args.out, f"{args.name}-{args.version}.json"),
        {
            "name": args.name,
            "version": args.version,
            "task": "scene",
            "taxonomyVersion": int(export.classes["version"]),
            "classes": {"scenes": export.scenes, "events": export.events},
            "input": {"name": "input", "width": args.size, "height": args.size, "mean": IMAGENET_MEAN, "std": IMAGENET_STD, "batched": True},
            "outputs": {"scene": "scene_logits", "events": "event_logits"},
            "datasetVersionId": export.meta["datasetVersionId"],
            "metrics": [evaluation(export, "macro_f1", report["macro_f1"], len(test), report["accuracy"], report["per_class"])],
        },
    )
    print("metadata written next to the model")


if __name__ == "__main__":
    main()
