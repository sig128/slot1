"""Metrics with no extra dependencies. Higher is better for every primary metric."""
from typing import Dict, List, Sequence, Tuple


def classification_report(y_true: Sequence[int], y_pred: Sequence[int], classes: Sequence[str]):
    """Per-class precision/recall/F1/support, accuracy, and macro F1 over classes present in y_true."""
    per = {}
    present = []
    for i, name in enumerate(classes):
        tp = sum(1 for t, p in zip(y_true, y_pred) if t == i and p == i)
        fp = sum(1 for t, p in zip(y_true, y_pred) if t != i and p == i)
        fn = sum(1 for t, p in zip(y_true, y_pred) if t == i and p != i)
        support = tp + fn
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / support if support else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per[name] = {"precision": precision, "recall": recall, "f1": f1, "support": support}
        if support:
            present.append(f1)
    n = len(y_true)
    accuracy = sum(1 for t, p in zip(y_true, y_pred) if t == p) / n if n else 0.0
    macro_f1 = sum(present) / len(present) if present else 0.0
    return {"accuracy": accuracy, "macro_f1": macro_f1, "per_class": per}


def iou(a: Sequence[float], b: Sequence[float]) -> float:
    """Boxes as [x1, y1, x2, y2]."""
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def average_precision(
    detections: List[Tuple[int, float, Sequence[float]]],
    ground_truth: Dict[int, List[Sequence[float]]],
    iou_threshold: float = 0.5,
) -> float:
    """All-point interpolated AP for one class.

    detections: (image_id, score, box); ground_truth: image_id -> boxes.
    """
    n_gt = sum(len(v) for v in ground_truth.values())
    if n_gt == 0:
        return float("nan")
    used = {k: [False] * len(v) for k, v in ground_truth.items()}
    tps, fps = [], []
    for image_id, _score, box in sorted(detections, key=lambda d: -d[1]):
        gts = ground_truth.get(image_id, [])
        best, best_j = 0.0, -1
        for j, g in enumerate(gts):
            o = iou(box, g)
            if o > best:
                best, best_j = o, j
        if best >= iou_threshold and not used[image_id][best_j]:
            used[image_id][best_j] = True
            tps.append(1)
            fps.append(0)
        else:
            tps.append(0)
            fps.append(1)
    tp_cum, fp_cum, recalls, precisions = 0, 0, [], []
    for tp, fp in zip(tps, fps):
        tp_cum += tp
        fp_cum += fp
        recalls.append(tp_cum / n_gt)
        precisions.append(tp_cum / (tp_cum + fp_cum))
    # Precision envelope, then area under the curve.
    mrec = [0.0] + recalls + [1.0]
    mpre = [0.0] + precisions + [0.0]
    for i in range(len(mpre) - 2, -1, -1):
        mpre[i] = max(mpre[i], mpre[i + 1])
    return sum((mrec[i + 1] - mrec[i]) * mpre[i + 1] for i in range(len(mrec) - 1))


def mean_ap(per_class_ap: Dict[str, float]) -> float:
    vals = [v for v in per_class_ap.values() if v == v]  # drop NaN (no ground truth)
    return sum(vals) / len(vals) if vals else 0.0
