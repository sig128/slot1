"""Scene + event classifier: one backbone, a softmax scene head and a multi-label event head."""
import torch
from torch import nn

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]


class SceneNet(nn.Module):
    def __init__(self, arch: str, n_scenes: int, n_events: int, pretrained: bool = True):
        super().__init__()
        if arch == "mobilenet_v3_small":
            from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

            weights = MobileNet_V3_Small_Weights.DEFAULT if pretrained else None
            base = mobilenet_v3_small(weights=weights)
            self.features = base.features
            self.pool = nn.AdaptiveAvgPool2d(1)
            width = 576
            self.neck = nn.Sequential(nn.Linear(width, 1024), nn.Hardswish(), nn.Dropout(0.2))
            hidden = 1024
        elif arch == "tiny":
            # Small and fast: for smoke tests and CPU-only experiments, not for production quality.
            self.features = nn.Sequential(
                nn.Conv2d(3, 16, 3, stride=2, padding=1), nn.ReLU(),
                nn.Conv2d(16, 32, 3, stride=2, padding=1), nn.ReLU(),
                nn.Conv2d(32, 64, 3, stride=2, padding=1), nn.ReLU(),
            )
            self.pool = nn.AdaptiveAvgPool2d(1)
            self.neck = nn.Identity()
            hidden = 64
        else:
            raise ValueError(f"unknown arch {arch}")
        self.scene_head = nn.Linear(hidden, n_scenes)
        self.event_head = nn.Linear(hidden, n_events)

    def forward(self, x):
        h = self.pool(self.features(x)).flatten(1)
        h = self.neck(h)
        return self.scene_head(h), self.event_head(h)
