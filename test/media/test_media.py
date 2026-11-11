"""Fast local tests for the media generator (no graphics card, no cloud).

Run from the repository root:
    python -m unittest discover -s test/media -v
"""
from __future__ import annotations

import io
import json
import math
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "media"))

import generate  # noqa: E402
import media_contract as C  # noqa: E402
import media_finish as F  # noqa: E402
import media_settings as S  # noqa: E402

W, H = S.OUTPUT_WIDTH, S.OUTPUT_HEIGHT


def dancer_frame(phase: float, width: int = W, height: int = H) -> np.ndarray:
    """A simple see-through 'figure': body, head and a wide hat swaying side to side."""
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    sway = 40 * math.sin(2 * math.pi * phase)
    cx = width / 2 + sway
    body = ((xx - cx) / 60) ** 2 + ((yy - height * 0.62) / 220) ** 2 <= 1
    head = ((xx - cx) / 45) ** 2 + ((yy - height * 0.30) / 50) ** 2 <= 1
    brim = (np.abs(xx - cx) <= 110) & (np.abs(yy - height * 0.22) <= 8)
    crown = (np.abs(xx - cx) <= 50) & (yy >= height * 0.12) & (yy <= height * 0.22)
    alpha = (body | head | brim | crown).astype(np.float32)
    # soft edge
    alpha = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).resize((width // 2, height // 2))
                       .resize((width, height), Image.Resampling.BILINEAR), np.float32) / 255
    color = np.zeros((height, width, 3), np.float32)
    color[..., 0], color[..., 1], color[..., 2] = 0.07, 0.64, 0.6
    color[yy < height * 0.23] = (0.11, 0.11, 0.16)
    return np.dstack([color, alpha]).astype(np.float32)


class ContractTests(unittest.TestCase):
    def sample(self, **changes):
        media = C.build_media(width=480, height=720, fps=24, frames=96, expressions=["smiling"], hat_line=0.23,
                              models=S.model_records(), prompts={"image": "a", "motion": "b"}, cost_usd=0.4)
        media.update(changes)
        return media

    def test_matches_documented_shape(self):
        media = self.sample()
        self.assertEqual(set(media), {"clip", "width", "height", "fps", "frames", "stills", "hatLine", "provenance"})
        self.assertEqual(media["stills"], {"default": "still.png", "smiling": "smiling.png"})
        self.assertTrue(media["provenance"]["created"].endswith("Z"))
        self.assertEqual(C.validate_media_dict(media), [])

    def test_rejects_bad_values(self):
        self.assertTrue(C.validate_media_dict(self.sample(height=800)))
        self.assertTrue(C.validate_media_dict(self.sample(width=900)))       # landscape
        self.assertTrue(C.validate_media_dict(self.sample(frames=48)))       # 2 seconds
        self.assertTrue(C.validate_media_dict(self.sample(hatLine=1.2)))
        bad = self.sample()
        bad["provenance"]["models"] = [{"repo": "someone/model", "revision": "main"}]
        self.assertTrue(C.validate_media_dict(bad))

    def test_every_model_is_pinned_to_its_publisher(self):
        publishers = {record["repo"].split("/")[0] for record in S.model_records()}
        self.assertEqual(publishers, {"Tongyi-MAI", "Lightricks", "ZhengPeng7"})
        for record in S.model_records():
            self.assertRegex(record["revision"], r"^[0-9a-f]{40}$")
            self.assertTrue(record["license"])


class FinishingTests(unittest.TestCase):
    def test_decontaminate_removes_backdrop_tint(self):
        magenta = np.array([1.0, 0.0, 1.0], np.float32)
        fg = np.array([0.1, 0.7, 0.2], np.float32)
        alpha = np.full((4, 4), 0.5, np.float32)
        mixed = to_u8(fg * 0.5 + magenta * 0.5)
        rgb = np.broadcast_to(mixed, (4, 4, 3)).copy()
        clean = F.decontaminate(rgb, alpha, magenta)
        self.assertLess(np.abs(clean[0, 0] - fg).max(), 0.02)

    def test_cutout_drops_plain_backdrop_and_specks(self):
        rgb = np.zeros((96, 64, 3), np.uint8)
        rgb[:] = (255, 0, 255)
        rgb[20:80, 20:44] = (30, 160, 60)
        alpha = np.zeros((96, 64), np.float32)
        alpha[20:80, 20:44] = 1.0
        alpha[2:4, 2:4] = 0.8                       # speck in the corner
        alpha[90:96] = 0.02                         # faint haze
        rgba = F.cutout(rgb, alpha, np.array([1, 0, 1], np.float32))
        self.assertEqual(rgba[3, 3, 3], 0.0)
        self.assertEqual(rgba[93, 30, 3], 0.0)
        self.assertEqual(rgba[50, 30, 3], 1.0)

    def test_despill_removes_backdrop_glow_on_edges_only(self):
        magenta = np.array([1.0, 0.0, 1.0], np.float32)
        rgb = np.full((40, 40, 3), 0.5, np.float32)
        rgb[:, :20] = (0.62, 0.42, 0.62)                         # grey with a magenta glow
        alpha = np.zeros((40, 40), np.float32)
        alpha[:, 12:] = 1.0                                      # edge at column 12
        cleaned = F.despill(rgb, alpha, magenta)
        edge = cleaned[20, 13]
        self.assertLess(abs(edge[0] - edge[1]), 0.02)            # glow gone: grey again
        self.assertTrue(np.allclose(cleaned[20, 30], rgb[20, 30]))  # interior untouched
        solid = np.zeros((20, 20), np.float32)
        solid[:, 5:] = 1.0
        for color in [(0.2, 0.8, 0.2), (0.85, 0.62, 0.5), (0.07, 0.64, 0.6)]:   # celery, skin, teal suit
            patch = np.full((20, 20, 3), color, np.float32)
            cleaned = F.despill(patch, solid, magenta)
            self.assertTrue(np.allclose(cleaned[:, 8:], patch[:, 8:]))          # a few pixels in: untouched
            self.assertTrue(np.allclose(cleaned[..., [0, 2]], patch[..., [0, 2]]))  # red and blue never pulled

    def test_blurred_hand_keeps_skin_colour(self):
        magenta = np.array([1.0, 0.0, 1.0], np.float32)
        rgb = np.zeros((30, 30, 3), np.uint8)
        rgb[:] = (255, 0, 255)
        rgb[10:20, 10:20] = (217, 158, 128)                      # skin
        alpha = np.zeros((30, 30), np.float32)
        alpha[10:20, 10:20] = 0.6                                # matte unsure about a blurred hand
        rgba = F.cutout(rgb, alpha, magenta, key=magenta)
        r, g, b = rgba[15, 15, :3]
        self.assertGreater(r, g)                                 # still skin: red above green ...
        self.assertGreater(g, b)                                 # ... and green above blue, not green-tinted
        self.assertEqual(rgba[15, 15, 3], 1.0)

    def test_shiny_patch_inside_the_figure_is_not_stained(self):
        magenta = np.array([1.0, 0.0, 1.0], np.float32)
        rgb = np.zeros((60, 60, 3), np.uint8)
        rgb[:] = (255, 0, 255)
        rgb[10:50, 10:50] = (150, 150, 150)                        # grey satin shirt
        rgb[25:35, 25:35] = (190, 140, 190)                        # ... mirroring the magenta backdrop
        alpha = np.zeros((60, 60), np.float32)
        alpha[10:50, 10:50] = 1.0
        alpha[25:35, 25:35] = 0.7                                  # matte unsure about the shiny patch
        rgba = F.cutout(rgb, alpha, magenta, key=magenta)
        self.assertEqual(rgba[30, 30, 3], 1.0)
        r, g, b = rgba[30, 30, :3]
        self.assertGreater(r, g)                                   # still a pinkish reflection, never green
        self.assertTrue(np.allclose(rgba[30, 30, :3], np.array([190, 140, 190]) / 255, atol=0.01))

    def test_half_blurred_hand_is_not_made_solid(self):
        magenta = np.array([1.0, 0.0, 1.0], np.float32)
        skin = np.array([0.85, 0.62, 0.5], np.float32)
        rgb = np.zeros((30, 30, 3), np.uint8)
        rgb[:] = (255, 0, 255)
        rgb[10:20, 10:20] = F.to_uint8(0.5 * skin + 0.5 * magenta)   # truly half see-through
        alpha = np.zeros((30, 30), np.float32)
        alpha[10:20, 10:20] = 0.5
        rgba = F.cutout(rgb, alpha, magenta, key=magenta)
        self.assertLess(rgba[15, 15, 3], 0.7)
        self.assertLess(np.abs(rgba[15, 15, :3] - skin).max(), 0.06)  # the un-mixed colour is skin, not pink

    def test_green_halo_beside_magenta_is_removed(self):
        rgb = np.full((20, 20, 3), (0.9, 0.9, 0.85), np.float32)       # white boot ...
        rgb[:, 5] = (0.6, 0.9, 0.55)                                    # ... with a green halo on its edge
        alpha = np.zeros((20, 20), np.float32)
        alpha[:, 5:] = 1.0
        cleaned = F.despill(rgb, alpha, np.array([1.0, 0.0, 1.0], np.float32))
        self.assertLessEqual(cleaned[10, 5, 1], max(cleaned[10, 5, 0], cleaned[10, 5, 2]) + 1e-6)

    def test_key_color_prefers_neutral_grey(self):
        rgb = np.zeros((40, 40, 3), np.uint8)
        rgb[:20] = (18, 163, 153)                    # teal suit
        rgb[20:] = (217, 158, 128)                   # skin
        name, _ = F.choose_key_color(rgb, np.ones((40, 40), np.float32))
        self.assertEqual(name, "grey")
        rgb[:] = (120, 122, 125)                     # a grey suit clashes with grey
        name, _ = F.choose_key_color(rgb, np.ones((40, 40), np.float32))
        self.assertEqual(name, "blue")

    def test_key_color_avoids_figure_colours(self):
        rgb = np.zeros((40, 40, 3), np.uint8)
        rgb[:] = (20, 200, 20)                       # a very green figure (celery!)
        name, _ = F.choose_key_color(rgb, np.ones((40, 40), np.float32))
        self.assertNotEqual(name, "green")

    def test_place_figure_keeps_margins(self):
        figure = dancer_frame(0.0, 300, 300)
        placed, layout = F.place_figure(figure, (640, 960), S.FIGURE_HEIGHT_SHARE, S.FIGURE_MAX_WIDTH_SHARE,
                                        S.FEET_LINE)
        left, top, right, bottom = F.figure_box(placed[..., 3])
        self.assertGreater(left, 0)
        self.assertGreater(top, 0)
        self.assertLess(right, 640)
        self.assertLessEqual(bottom, round(S.FEET_LINE * 960) + 1)

    def test_hat_line_finds_brim(self):
        frame = dancer_frame(0.0)
        line = F.hat_line(frame[..., 3])
        self.assertGreater(line, 0.2)
        self.assertLess(line, 0.3)

    def test_loop_drops_repeated_last_frame(self):
        frames = [dancer_frame(i / 48) for i in range(49)]      # frame 48 == frame 0
        looped, report = F.make_loop(frames)
        self.assertEqual(len(looped), 48)
        self.assertEqual(report["crossfadeFrames"], 0)
        self.assertLess(report["seamAfter"], 2 * report["typicalStep"])

    def test_loop_crossfades_a_visible_jump(self):
        frames = [dancer_frame(i / 70) for i in range(49)]      # stops part-way: big jump back
        looped, report = F.make_loop(frames, crossfade=6)
        self.assertEqual(report["crossfadeFrames"], 6)
        self.assertEqual(len(looped), 48 - 6)
        self.assertLess(report["seamAfter"], report["seamBefore"])


class EncodeRoundTripTests(unittest.TestCase):
    """A real ffmpeg round trip: the see-through background must survive encoding."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.tmp.name)
        frames = [dancer_frame(i / 72) for i in range(73)]
        cls.looped, cls.loop_report = F.make_loop(frames)
        cls.info = F.encode_webm(cls.looped, cls.folder / "loop.webm", fps=24)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_alpha_survives(self):
        probe = F.probe(self.folder / "loop.webm")
        stream = probe["streams"][0]
        self.assertEqual(stream["codec_name"], "vp9")
        tags = {key.lower(): value for key, value in stream.get("tags", {}).items()}
        self.assertEqual(tags.get("alpha_mode"), "1")
        decoded = F.decode_webm_rgba(self.folder / "loop.webm")
        self.assertEqual(decoded.shape, (72, H, W, 4))
        self.assertEqual(int(decoded[0, 5, 5, 3]), 0)                     # corner is see-through
        self.assertGreater(int(decoded[0, int(H * 0.62), W // 2, 3]), 250)  # body is solid
        original = F.to_uint8(np.stack([frame[..., 3] for frame in self.looped]))
        self.assertLess(np.mean(np.abs(original.astype(int) - decoded[..., 3].astype(int))), 3.0)
        self.assertLess(self.info["bytes"], 4 * 1024 * 1024)

    def test_finished_folder_passes_contract(self):
        F.save_png(self.looped[0], self.folder / "still.png")
        F.save_png(self.looped[10], self.folder / "smiling.png")
        media = C.build_media(width=W, height=H, fps=24, frames=len(self.looped), expressions=["smiling"],
                              hat_line=F.hat_line(self.looped[0][..., 3]), models=S.model_records(),
                              prompts={"image": "test", "motion": "test"}, cost_usd=0.0)
        C.write_media(self.folder, media)
        self.assertEqual(C.validate_folder(self.folder), [])
        saved = json.loads((self.folder / "media.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["frames"], 72)

    def test_contract_notices_missing_alpha(self):
        bad = self.folder / "opaque"
        bad.mkdir(exist_ok=True)
        opaque = [np.dstack([frame[..., :3], np.ones(frame.shape[:2], np.float32)]) for frame in self.looped]
        F.encode_webm(opaque, bad / "loop.webm")
        F.save_png(opaque[0], bad / "still.png")
        C.write_media(bad, C.build_media(width=W, height=H, fps=24, frames=len(opaque), expressions=[],
                                         hat_line=0.2, models=S.model_records(),
                                         prompts={"image": "t", "motion": "t"}, cost_usd=0))
        problems = C.validate_folder(bad)
        self.assertTrue(any("see-through" in problem for problem in problems))


class CommandLineTests(unittest.TestCase):
    def run_main(self, argv):
        buffer = io.StringIO()
        old = generate._STDOUT
        generate._STDOUT = buffer
        try:
            with redirect_stdout(io.StringIO()):
                code = generate.main(argv)
        finally:
            generate._STDOUT = old
        lines = [json.loads(line) for line in buffer.getvalue().splitlines() if line.strip()]
        return code, lines

    def test_missing_arguments_give_plain_error(self):
        code, lines = self.run_main(["--name", "Tayne"])
        self.assertNotEqual(code, 0)
        self.assertEqual(len(lines), 1)
        self.assertIn("error", lines[0])

    def test_cost_cap_is_enforced_before_starting(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, lines = self.run_main(["--name", "X", "--prompt", "a dancer", "--out", tmp, "--max-cost", "0.05"])
        self.assertNotEqual(code, 0)
        self.assertIn("cost", lines[-1]["error"])

    def test_bad_expression_name_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, lines = self.run_main(["--name", "X", "--prompt", "a", "--out", tmp, "--expressions", "../x"])
        self.assertNotEqual(code, 0)
        self.assertIn("expression", lines[-1]["error"])

    def test_prompts_mention_backdrop_and_loop(self):
        prompts = generate.build_prompts("Tayne", "A dancer in a hat. Dance: strut.", "magenta", ["smiling"])
        self.assertIn("grey studio backdrop", prompts["image"])
        self.assertIn("invented person", prompts["image"])
        self.assertIn("magenta studio backdrop", prompts["motion"])
        self.assertIn("same pose", prompts["motion"].replace("exactly the pose", "same pose"))
        self.assertIn("smiling", prompts["expression:smiling"])


def to_u8(value):
    return np.clip(np.rint(np.asarray(value) * 255), 0, 255).astype(np.uint8)


if __name__ == "__main__":
    unittest.main()
