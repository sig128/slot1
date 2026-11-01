"""Write a tiny, deterministic scene/event ONNX model with a dynamic batch axis (test fixture only).

usage: python3 tiny_scene_model.py OUT.onnx SIZE N_SCENES N_EVENTS SEED
"""
import sys

import torch

out, size, n_scenes, n_events, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
torch.manual_seed(seed)


class Tiny(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = torch.nn.Conv2d(3, 8, 3, stride=2, padding=1)
        self.pool = torch.nn.AdaptiveAvgPool2d(1)
        self.scene = torch.nn.Linear(8, n_scenes)
        self.events = torch.nn.Linear(8, n_events)

    def forward(self, x):
        h = self.pool(torch.relu(self.conv(x))).flatten(1)
        return self.scene(h), self.events(h)


model = Tiny().eval()
dummy = torch.randn(1, 3, size, size)
torch.onnx.export(
    model,
    (dummy,),
    out,
    input_names=["input"],
    output_names=["scene_logits", "event_logits"],
    dynamic_axes={"input": {0: "batch"}, "scene_logits": {0: "batch"}, "event_logits": {0: "batch"}},
    opset_version=17,
    dynamo=False,
)
print(out)
