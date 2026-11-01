import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from slot1_ml.metrics import average_precision, classification_report, iou, mean_ap  # noqa: E402


class MetricsTest(unittest.TestCase):
    def test_classification_report(self):
        r = classification_report([0, 0, 1, 2], [0, 1, 1, 2], ["a", "b", "c", "d"])
        self.assertAlmostEqual(r["accuracy"], 0.75)
        self.assertAlmostEqual(r["per_class"]["a"]["recall"], 0.5)
        self.assertAlmostEqual(r["per_class"]["b"]["precision"], 0.5)
        # "d" has no support and doesn't count toward macro F1.
        self.assertAlmostEqual(r["macro_f1"], (2 / 3 + 2 / 3 + 1.0) / 3)

    def test_iou(self):
        self.assertAlmostEqual(iou([0, 0, 2, 2], [1, 1, 3, 3]), 1 / 7)
        self.assertEqual(iou([0, 0, 1, 1], [2, 2, 3, 3]), 0.0)

    def test_average_precision(self):
        gt = {0: [[0, 0, 10, 10]], 1: [[0, 0, 10, 10]]}
        perfect = [(0, 0.9, [0, 0, 10, 10]), (1, 0.8, [1, 1, 10, 10])]
        self.assertAlmostEqual(average_precision(perfect, gt), 1.0)
        # A confident false positive ranked first halves precision at the first hit.
        noisy = [(0, 0.95, [50, 50, 60, 60]), (0, 0.9, [0, 0, 10, 10]), (1, 0.8, [0, 0, 10, 10])]
        self.assertAlmostEqual(average_precision(noisy, gt), 2 / 3)
        self.assertTrue(average_precision([], {}) != average_precision([], {}))  # NaN without ground truth
        self.assertAlmostEqual(mean_ap({"a": 1.0, "b": float("nan"), "c": 0.5}), 0.75)


if __name__ == "__main__":
    unittest.main()
