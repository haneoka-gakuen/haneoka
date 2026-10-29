"""Synthetic grid regressions; no private screenshots or release assets."""
import unittest

import cv2
import numpy as np

from .grid import grid, regular_positions


def card_list(kind, columns, rows, *, badges=True):
    w, h = (150, 200) if kind == "members" else (220, 124)
    gap, left, top = 20, 70, 80
    image = np.full((top + rows * (h + gap) + 10, left * 2 + columns * (w + gap), 3), 55, np.uint8)
    for row in range(rows):
        for column in range(columns):
            x, y = left + column * (w + gap), top + row * (h + gap)
            cv2.rectangle(image, (x, y), (x + w - 1, y + h - 1), (230, 210, 120), -1)
            cv2.rectangle(image, (x + 4, y + 4), (x + w - 5, y + h - 5), (70, 95, 130), -1)
            if badges:
                cv2.circle(image, (x + 5, y + 5), 10, (250, 80, 150), -1)
                if kind == "snapshots" and (row + column) % 3:
                    cv2.rectangle(image, (x + w // 2, y - 15), (x + w // 2 + 30, y + 18), (220, 240, 80), -1)
    return image


class GridTests(unittest.TestCase):
    def test_complete_rows_and_columns(self):
        for kind, columns, rows in (("members", 6, 3), ("snapshots", 4, 5)):
            for scale in (.5, .75, 1, 1.5):
                with self.subTest(kind=kind, scale=scale):
                    image = card_list(kind, columns, rows)
                    image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
                    result = grid(image)
                    self.assertEqual(result["kind"], kind)
                    self.assertEqual(len(result["boxes"]), columns * rows)
                    boxes = [box["bbox"] for box in result["boxes"]]
                    self.assertLess(min(box[1] for box in boxes), 100 * scale)
                    for x, y, w, h in boxes:
                        self.assertGreater(min(w, h), 0)
                        self.assertGreaterEqual(min(x, y), 0)
                        self.assertLessEqual(x + w, image.shape[1])
                        self.assertLessEqual(y + h, image.shape[0])

    def test_unadorned_cards(self):
        for kind in ("members", "snapshots"):
            with self.subTest(kind=kind):
                result = grid(card_list(kind, 4, 3, badges=False))
                self.assertEqual(result["kind"], kind)
                self.assertEqual(len(result["boxes"]), 12)

    def test_blank_image(self):
        self.assertEqual(grid(np.zeros((480, 640, 3), np.uint8))["boxes"], [])

    def test_fill_only_a_supported_lattice(self):
        self.assertEqual(regular_positions([20, 100, 260], 70), [20, 100, 180, 260])
        self.assertIsNone(regular_positions([20, 100, 295], 70))
        self.assertIsNone(regular_positions([20], 70))


if __name__ == "__main__":
    unittest.main()
