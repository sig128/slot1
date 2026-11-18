# Models shipped with the worker

## yolox-nano.onnx

The AI overlay's object finder: it boxes people, vehicles and animals in the frames SLOT1 analyzes,
while someone has the overlay or "What the AI sees" open (see `src/live/objects.ts`). It is a
general detector trained on the COCO photo set, not on GTA, and its boxes never become log entries
or training labels.

- Model: YOLOX-Nano, 416 × 416 input, ONNX export from the YOLOX project's 0.1.1rc0 release
  (`yolox_nano.onnx`, https://github.com/Megvii-BaseDetection/YOLOX/releases/tag/0.1.1rc0).
- SHA-256: `c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d`
- License: Apache License 2.0, Copyright (c) 2021-2022 Megvii Inc. The YOLOX license text is at
  https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE. The file is unmodified.
- Paper: Ge, Liu, Wang, Li, Sun. "YOLOX: Exceeding YOLO Series in 2021." arXiv:2107.08430.
