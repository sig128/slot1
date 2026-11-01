"""Reads a dataset export downloaded from SLOT1 (Studio → GTA model → Export)."""
import json
import os
import tempfile
import zipfile
from typing import Optional

from PIL import Image


class DatasetExport:
    """A folder or .zip with dataset.json, classes.json, manifest.jsonl and images/."""

    def __init__(self, path: str, cache_dir: Optional[str] = None):
        if os.path.isdir(path):
            self.root = path
        elif zipfile.is_zipfile(path):
            self.root = cache_dir or tempfile.mkdtemp(prefix="slot1-dataset-")
            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    target = os.path.realpath(os.path.join(self.root, name))
                    if not target.startswith(os.path.realpath(self.root) + os.sep):
                        raise ValueError(f"unsafe path in dataset zip: {name}")
                z.extractall(self.root)
        else:
            raise FileNotFoundError(f"not a dataset folder or zip: {path}")
        with open(os.path.join(self.root, "dataset.json")) as f:
            self.meta = json.load(f)
        with open(os.path.join(self.root, "classes.json")) as f:
            self.classes = json.load(f)
        with open(os.path.join(self.root, "manifest.jsonl")) as f:
            self.items = [json.loads(line) for line in f if line.strip()]

    @property
    def scenes(self):
        return list(self.classes["scenes"])

    @property
    def events(self):
        return list(self.classes["events"])

    @property
    def boxes(self):
        return list(self.classes["boxes"])

    def split(self, name: str):
        return [i for i in self.items if i["split"] == name]

    def image(self, item) -> Image.Image:
        return Image.open(os.path.join(self.root, item["file"])).convert("RGB")

    def evaluation_header(self):
        """Identifies the frozen test split an evaluation was computed on."""
        return {
            "datasetVersionId": self.meta["datasetVersionId"],
            "datasetVersion": int(self.meta["version"]),
            "testSplitHash": self.meta["testSplitHash"],
        }
