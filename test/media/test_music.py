"""Fast local tests for the disco-loop maker (no graphics card, no cloud).

Run from the repository root:
    python -m unittest discover -s test/media -v
"""
from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "media"))

import make_music as M  # noqa: E402

SR = M.SR


def groove(bpm: float = 120.4, seconds: float = 100.0, seed: int = 1):
    """A stand-in for a candidate: a kick on every beat and a four-bar chord pattern, plus beat times."""
    rng = np.random.default_rng(seed)
    period = 60 / bpm
    signal = np.zeros(int(seconds * SR))
    chords = [220.0, 293.66, 196.0, 261.63]
    beats = []
    for beat in range(int((seconds - 1) / period)):
        start = int((0.3 + beat * period) * SR)
        length = int(0.15 * SR)
        beats.append(0.3 + beat * period + rng.normal(0, 0.004))
        if start + length < len(signal):
            signal[start:start + length] += np.sin(2 * np.pi * 55 * np.arange(length) / SR) * np.exp(-np.arange(length) / SR * 30)
        end = min(len(signal), start + int(period * SR))
        signal[start:end] += 0.2 * np.sin(2 * np.pi * chords[(beat // 4) % 4] * np.arange(end - start) / SR)
    signal += 0.01 * rng.standard_normal(len(signal))
    return np.stack([signal, signal], axis=1).astype(np.float32), beats


class LoopTests(unittest.TestCase):
    def test_recipe_is_pinned_and_style_only(self):
        recipe = M.load_recipe()
        self.assertRegex(recipe["model"]["revision"], r"^[0-9a-f]{40}$")
        self.assertEqual(recipe["model"]["license"], "mit")
        self.assertEqual(recipe["music"]["lyrics"], "[Instrumental]")
        self.assertEqual([level["level"] for level in recipe["levels"]], [1, 2, 3])
        for level in recipe["levels"]:
            self.assertIn("1970s disco instrumental", level["prompt"])
            self.assertIn("no vocals", level["prompt"])
            self.assertTrue(all(isinstance(seed, int) for seed in level["seeds"]))

    def test_beat_grid_finds_the_tempo(self):
        _, beats = groove(bpm=121.0)
        period, _, jitter = M.beat_grid(beats)
        self.assertAlmostEqual(60 / period, 121.0, delta=0.05)
        self.assertLess(jitter, 0.01)

    def test_loop_starts_on_a_bar_line_and_is_whole_bars_at_exactly_120(self):
        audio, beats = groove()
        choice = M.choose_loop(audio, beats)
        self.assertEqual(choice["bars"], 32)
        self.assertEqual(choice["beat"] % 4, 0, "the chords change every 4 beats from beat 0")
        self.assertGreater(choice["seam"], 0.95)
        loop = M.make_loop(audio, choice, 120)
        self.assertEqual(len(loop), 32 * 4 * SR // 2)       # 64.000 seconds
        seam = M.seam_check(loop)
        self.assertLess(seam["wrapStepRank"], 0.999, "the jump back to the start is an ordinary step")
        self.assertLess(seam["seamFluxRank"], 0.95, "the seam changes no more than an ordinary beat")

    def test_falls_back_to_16_bars_when_the_candidate_is_short(self):
        audio, beats = groove(seconds=50)
        self.assertEqual(M.choose_loop(audio, beats)["bars"], 16)

    def test_refuses_without_beats(self):
        audio, _ = groove(seconds=20)
        with self.assertRaises(M.Failure):
            M.choose_loop(audio, [0.5, 1.0, 1.5])

    def test_rating_refuses_wrong_tempo_and_singing(self):
        loop = {"period": 60 / 120, "jitterMs": 5.0, "score": 0.98}
        good = {"spectrum": {"bass": 0.2, "top": 0.01, "air": 0.001}, "vocalShare": 0.02, "beatStrength": 2.0}
        self.assertEqual(M.rate(good, loop, 120)["problems"], [])
        self.assertTrue(M.rate({**good, "vocalShare": 0.3}, loop, 120)["problems"])
        self.assertTrue(M.rate(good, {**loop, "period": 60 / 131}, 120)["problems"])

    def test_cost_is_shown_and_nothing_is_spent_without_yes(self):
        recipe = M.load_recipe()
        jobs = M.jobs_for(recipe, [1, 2, 3], None, None)
        self.assertEqual(len(jobs), 12)
        cost = M.estimate(jobs, first_time=True)
        self.assertLess(cost["totalUsd"], 1.0)
        self.assertGreater(cost["worstCaseUsd"], cost["totalUsd"])
        output = io.StringIO()
        original, ready = M._STDOUT, M.weights_ready
        M._STDOUT, M.weights_ready = output, (lambda: True)
        try:
            self.assertEqual(M.main(["--levels", "1"]), 0)
        finally:
            M._STDOUT, M.weights_ready = original, ready
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(lines[-1]["dryRun"])

    @unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
    def test_opus_file_decodes_to_exactly_the_loop_length(self):
        audio, beats = groove()
        loop = M.make_loop(audio, M.choose_loop(audio, beats), 120) * 0.3
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "loop.ogg"
            M.encode_opus(loop, path, 112)
            size = path.stat().st_size
            decoded = M.decode(path)
        self.assertEqual(len(decoded), len(loop))
        self.assertLess(size, M.MAX_TRACK_BYTES)
        self.assertLess(M.seam_check(decoded)["wrapStepRank"], 0.999)


if __name__ == "__main__":
    unittest.main()
