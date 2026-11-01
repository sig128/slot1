#!/usr/bin/env python3
"""Train SLOT1's GTA HUD/object detector (torchvision SSDlite, BSD) and write model.onnx + metadata.json.

  python ml/train_detector.py --data slot1-gta-dataset-v3.zip --out runs/det-v3 --version 2026.11.1
"""
import argparse
import os
import random
import sys

import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slot1_ml.data import DatasetExport  # noqa: E402
from slot1_ml.device import pick_device  # noqa: E402
from slot1_ml.export import evaluation, export_onnx, write_metadata  # noqa: E402
from slot1_ml.metrics import average_precision, mean_ap  # noqa: E402


class BoxDataset(Dataset):
    def __init__(self, export: DatasetExport, items, size: int):
        self.export, self.items, self.size, self.classes = export, items, size, export.boxes

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        item = self.items[i]
        s = self.size
        img = self.export.image(item).resize((s, s))
        x = torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0).permute(2, 0, 1)
        boxes, labels = [], []
        for b in item.get("boxes", []):
            if b["class"] not in self.classes:
                continue
            boxes.append([b["x"] * s, b["y"] * s, (b["x"] + b["w"]) * s, (b["y"] + b["h"]) * s])
            labels.append(self.classes.index(b["class"]) + 1)  # 0 = background
        target = {
            "boxes": torch.tensor(boxes, dtype=torch.float32).reshape(-1, 4),
            "labels": torch.tensor(labels, dtype=torch.int64),
        }
        return x, target


def collate(batch):
    return tuple(zip(*batch))


def build(n_classes: int, pretrained: bool):
    from torchvision.models import MobileNet_V3_Large_Weights
    from torchvision.models.detection import ssdlite320_mobilenet_v3_large

    backbone = MobileNet_V3_Large_Weights.DEFAULT if pretrained else None
    return ssdlite320_mobilenet_v3_large(weights=None, weights_backbone=backbone, num_classes=n_classes + 1)


@torch.no_grad()
def evaluate(model, dataset: BoxDataset, device, score_threshold=0.05):
    """mAP@0.5 over box classes that have ground truth in this split."""
    model.eval()
    dets = {c: [] for c in dataset.classes}
    gts = {c: {} for c in dataset.classes}
    for idx in range(len(dataset)):
        x, target = dataset[idx]
        out = model([x.to(device)])[0]
        for box, label in zip(target["boxes"].tolist(), target["labels"].tolist()):
            gts[dataset.classes[label - 1]].setdefault(idx, []).append(box)
        for box, score, label in zip(out["boxes"].cpu().tolist(), out["scores"].cpu().tolist(), out["labels"].cpu().tolist()):
            if score >= score_threshold and 1 <= label <= len(dataset.classes):
                dets[dataset.classes[label - 1]].append((idx, score, box))
    per_class = {c: average_precision(dets[c], gts[c]) for c in dataset.classes}
    return mean_ap(per_class), per_class


def check_detector_onnx(path, example, torch_out):
    """Detections can be ordered differently near ties, so compare structure and the best score."""
    import onnxruntime as ort

    boxes, scores, labels = ort.InferenceSession(path, providers=["CPUExecutionProvider"]).run(None, {"images": example.numpy()})
    if boxes.ndim != 2 or boxes.shape[1] != 4 or scores.shape[0] != boxes.shape[0] or labels.shape[0] != boxes.shape[0]:
        raise RuntimeError(f"unexpected ONNX output shapes {boxes.shape} {scores.shape} {labels.shape}")
    if len(torch_out["scores"]) and len(scores):
        diff = abs(float(scores.max()) - float(torch_out["scores"].max()))
        if diff > 1e-3:
            raise RuntimeError(f"best score differs between ONNX and PyTorch by {diff:.5f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-pretrained", action="store_true")
    ap.add_argument("--size", type=int, default=320)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--name", default="gta-detector")
    ap.add_argument("--version", required=True)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = pick_device(args.device)
    export = DatasetExport(args.data)
    sets = {name: BoxDataset(export, export.split(name), args.size) for name in ("train", "val", "test")}
    if not len(sets["train"]):
        sys.exit("The dataset has no training frames.")
    print(f"dataset v{export.meta['version']}: {len(sets['train'])} train / {len(sets['val'])} val / {len(sets['test'])} test frames on {device}")

    model = build(len(export.boxes), pretrained=not args.no_pretrained).to(device)
    loader = DataLoader(sets["train"], batch_size=args.batch_size, shuffle=True, collate_fn=collate)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    best_state, best_map = None, -1.0
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for images, targets in loader:
            images = [i.to(device) for i in images]
            targets = [{k: v.to(device) for k, v in t.items()} for t in targets]
            loss = sum(model(images, targets).values())
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss)
        val_map = evaluate(model, sets["val"], device)[0] if len(sets["val"]) else -total
        print(f"epoch {epoch + 1}/{args.epochs}  loss {total / max(1, len(loader)):.4f}  val mAP@0.5 {val_map:.3f}")
        if val_map >= best_map:
            best_map, best_state = val_map, {k: v.detach().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    test_map, per_class = evaluate(model, sets["test"], device) if len(sets["test"]) else (0.0, {})
    print(f"test: {len(sets['test'])} frames, mAP@0.5 {test_map:.3f}")

    os.makedirs(args.out, exist_ok=True)
    onnx_path = os.path.join(args.out, f"{args.name}-{args.version}.onnx")
    model = model.cpu().eval()
    example = torch.rand(3, args.size, args.size)
    export_onnx(model, ([example],), onnx_path, ["images"], ["boxes", "scores", "labels"])
    with torch.no_grad():
        out = model([example])[0]
    check_detector_onnx(onnx_path, example, out)
    print(f"ONNX verified with onnxruntime: {onnx_path}")

    write_metadata(
        os.path.join(args.out, f"{args.name}-{args.version}.json"),
        {
            "name": args.name,
            "version": args.version,
            "task": "detector",
            "taxonomyVersion": int(export.classes["version"]),
            "classes": {"boxes": export.boxes},
            # torchvision detectors normalize internally: feed 0..1 RGB, unbatched [3, H, W].
            "input": {"name": "images", "width": args.size, "height": args.size, "mean": [0, 0, 0], "std": [1, 1, 1], "batched": False},
            "outputs": {"boxes": "boxes", "scores": "scores", "labels": "labels"},
            "datasetVersionId": export.meta["datasetVersionId"],
            "metrics": [
                evaluation(
                    export,
                    "map50",
                    test_map,
                    len(sets["test"]),
                    None,
                    {c: {"precision": 0.0, "recall": 0.0, "f1": 0.0, "support": float(ap if ap == ap else 0.0)} for c, ap in per_class.items()},
                )
            ],
        },
    )
    print("metadata written next to the model")


if __name__ == "__main__":
    main()
