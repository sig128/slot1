"""ONNX export with a numerical check against PyTorch, plus the metadata SLOT1's registry expects."""
import datetime
import hashlib
import json
from typing import Dict, List, Sequence

import numpy as np
import torch


def export_onnx(model: torch.nn.Module, example, path: str, input_names: List[str], output_names: List[str], dynamic_axes=None) -> None:
    model.eval()
    kwargs = dict(input_names=input_names, output_names=output_names, opset_version=17, dynamic_axes=dynamic_axes)
    try:
        # The TorchScript exporter handles torchvision detection models; newer PyTorch defaults to dynamo.
        torch.onnx.export(model, example, path, dynamo=False, **kwargs)
    except TypeError:
        torch.onnx.export(model, example, path, **kwargs)


def check_onnx(path: str, feeds: Dict[str, np.ndarray], expected: Sequence[np.ndarray], atol: float = 1e-3) -> float:
    """Run the exported file with ONNX Runtime and compare with PyTorch's outputs."""
    import onnxruntime as ort

    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    got = session.run(None, feeds)
    worst = 0.0
    for g, e in zip(got, expected):
        if g.shape != e.shape:
            raise RuntimeError(f"ONNX output shape {g.shape} differs from PyTorch {e.shape}")
        if g.size:
            worst = max(worst, float(np.max(np.abs(g.astype(np.float64) - e.astype(np.float64)))))
    if worst > atol:
        raise RuntimeError(f"ONNX output differs from PyTorch by {worst:.5f} (> {atol})")
    return worst


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def evaluation(dataset, primary_metric: str, value: float, test_frames: int, accuracy=None, per_class=None) -> dict:
    e = {
        **dataset.evaluation_header(),
        "primaryMetric": primary_metric,
        "value": float(max(0.0, min(1.0, value))),
        "testFrames": int(test_frames),
        "evaluatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if accuracy is not None:
        e["accuracy"] = float(accuracy)
    if per_class is not None:
        e["perClass"] = {k: {kk: float(vv) for kk, vv in v.items()} for k, v in per_class.items()}
    return e


def write_metadata(path: str, meta: dict) -> None:
    with open(path, "w") as f:
        json.dump(meta, f, indent=2)
