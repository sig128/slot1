# SLOT1 GTA model: training

Scripts that turn a SLOT1 dataset export into ONNX models the worker runs in real time. Everything here is permissively licensed: PyTorch and torchvision (BSD), ONNX (Apache-2.0), ONNX Runtime (MIT). Ultralytics/YOLO is deliberately not used because of its AGPL license.

## 1. Get a dataset

In Studio → GTA model (operators):

1. **Build dataset version.** This freezes every labeled frame from channels that currently consent.
2. **Export zip.** The zip contains:
   - `images/`
   - `manifest.jsonl`: per frame, the split, scene, events and boxes
   - `coco_{train,val,test}.json`
   - `classes.json`
   - `dataset.json`: version, frozen test-split hash, counts

Splits are by **session**: neighbouring frames from one stream never end up in both train and test. The seed is fixed, so a session's split never changes between versions and the test set only grows.

## 2. Train on a GPU

Any CUDA machine works: a rented cloud GPU, or your own PC. Apple Silicon (MPS) works for small runs, and CPU is fine for smoke tests only.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r ml/requirements.txt          # pick the torch build for your CUDA version from pytorch.org

# Scene + event classifier (MobileNetV3-Small, ImageNet-pretrained backbone)
python ml/train_scene.py --data slot1-gta-dataset-v3.zip --out runs/scene-v3 --version 2026.11.1 --epochs 15

# HUD / object detector (SSDlite320 + MobileNetV3-Large)
python ml/train_detector.py --data slot1-gta-dataset-v3.zip --out runs/det-v3 --version 2026.11.1 --epochs 40
```

Each run writes `<name>-<version>.onnx` and `<name>-<version>.json`. The JSON holds the classes, input spec, outputs, and an evaluation on the dataset's frozen test split. Before writing the files, the ONNX export is checked against PyTorch with ONNX Runtime.

`--no-pretrained` skips downloading ImageNet weights, for offline machines; expect much worse accuracy. `--arch tiny` trains a very small network, meant only for pipeline smoke tests.

## 3. Register and activate

In Studio → GTA model → **Upload model**, choose the `.onnx` and its `.json`. The model is registered as a *candidate*. **Activate** puts it live only if its primary metric is at least as good as the active model's on the **same test split**: macro-F1 for scene models, mAP@0.5 for detectors.

When a newer dataset version exists, evaluate both models on it so the comparison is fair:

```bash
python ml/eval.py --model runs/scene-v3/gta-scene-2026.11.1.onnx --metadata runs/scene-v3/gta-scene-2026.11.1.json \
    --data slot1-gta-dataset-v4.zip --out eval-v4.json
```

Upload `eval-v4.json` with **Add evaluation** on each model, then activate. `eval.py` needs only ONNX Runtime, not PyTorch.

## 4. What happens next

Within a few seconds the worker loads the active models, verifying each one's checksum, and runs them on every sampled frame with ONNX Runtime.

- Confident scene, HUD and result-screen predictions become observations attributed to `slot1-gta` with the model's version, with the frame as evidence.
- Events that unfold over time must appear on two consecutive frames, and are labeled *inferred*.
- Everything else goes to the labeling queue as a proposal, least certain first.

## Tests

```bash
python3 -m unittest discover -s ml/tests      # metric functions
pnpm test:integration                         # includes a real (tiny, CPU) training run when torch is installed
```
