"""The optional MiniMax H3 dance model: choice, prompt and file checks (no cloud, no graphics card).

Run from the repository root:
    python -m unittest discover -s test/media -v
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "media"))

import generate  # noqa: E402
import media_h3  # noqa: E402
import media_route as R  # noqa: E402
import media_settings as S  # noqa: E402

SPEC = R.h3_spec()
SIZES = {name: size for name, (size, _digest) in SPEC["files"].items()}
OWN_READY = {"status": "ready", "repo": S.H3_REPO, "revision": S.H3_REVISION, "folder": S.H3_FOLDER, "files": 81}
OWNER_FOLDER = (S.H3_CACHE_VOLUME, f"{S.H3_CACHE_ROOT}/{S.H3_FOLDER}")


class FakeAccount:
    def __init__(self, folders=None, records=None):
        self.folders = folders or {}
        self.records = records or {}

    def file_sizes(self, volume, folder):
        return self.folders.get((volume, folder))

    def read_json(self, volume, path):
        return self.records.get((volume, path))


class SpecTests(unittest.TestCase):
    def test_pinned_list_is_the_official_fl2va_folder(self):
        self.assertEqual((SPEC["repo"], SPEC["revision"], SPEC["folder"]), (S.H3_REPO, S.H3_REVISION, S.H3_FOLDER))
        self.assertEqual(len(SPEC["files"]), 81)
        weights = [digest for _size, digest in SPEC["files"].values() if digest.startswith("sha256:")]
        self.assertEqual(len(weights), 29)
        self.assertEqual(sum(SIZES.values()), 144_051_182_625)
        self.assertRegex(S.H3_REVISION, r"^[0-9a-f]{40}$")
        self.assertIn("@sha256:", S.SGLANG_IMAGE)                 # the software is pinned too

    def test_model_record(self):
        record = S.model_records("h3")[1]
        self.assertEqual((record["repo"], record["revision"], record["license"]),
                         (S.H3_REPO, S.H3_REVISION, "minimax-h3-community-license-agreement"))


class ChoiceTests(unittest.TestCase):
    def test_owner_copy_is_used_read_only(self):
        state = R.inspect_h3(FakeAccount({OWNER_FOLDER: dict(SIZES, extra_file=1)}))
        self.assertEqual(state, {"h3OwnerCopy": True, "h3Own": False})
        route = R.choose_route("h3", state)
        self.assertEqual(route["engine"], "h3")
        self.assertIn("owner's existing copy", route["why"])
        cloud = R.h3_cloud_settings(state)
        self.assertEqual((cloud[R.CLOUD_H3_VOLUME], cloud[R.CLOUD_H3_READ_ONLY], cloud[R.CLOUD_H3_ROOT]),
                         (S.H3_CACHE_VOLUME, "1", S.H3_CACHE_ROOT))
        self.assertFalse(R.h3_prepare_plan(state)["download"])

    def test_incomplete_owner_copy_is_not_used(self):
        broken = dict(SIZES)
        broken.pop(next(iter(broken)))
        self.assertFalse(R.inspect_h3(FakeAccount({OWNER_FOLDER: broken}))["h3OwnerCopy"])
        wrong = dict(SIZES, **{"transformer/model-00001-of-00013.safetensors": 1})
        self.assertFalse(R.inspect_h3(FakeAccount({OWNER_FOLDER: wrong}))["h3OwnerCopy"])

    def test_own_copy(self):
        state = R.inspect_h3(FakeAccount(records={(S.H3_WEIGHTS_VOLUME, "ready.json"): OWN_READY}))
        self.assertEqual(R.choose_route("h3", state)["engine"], "h3")
        cloud = R.h3_cloud_settings(state)
        self.assertEqual((cloud[R.CLOUD_H3_VOLUME], cloud[R.CLOUD_H3_READ_ONLY], cloud[R.CLOUD_H3_ROOT]),
                         (S.H3_WEIGHTS_VOLUME, "0", S.H3_REVISION))
        stale = dict(OWN_READY, revision="0" * 40)
        self.assertFalse(R.inspect_h3(FakeAccount(records={(S.H3_WEIGHTS_VOLUME, "ready.json"): stale}))["h3Own"])

    def test_nothing_there_names_the_command_size_time_and_cost(self):
        route = R.choose_route("h3", R.inspect_h3(FakeAccount()))
        self.assertIsNone(route["engine"])
        self.assertIn(R.H3_PREPARE_COMMAND, route["whatToDo"])
        self.assertIn("144 GB", route["whatToDo"])
        self.assertIn("minutes", route["whatToDo"])
        self.assertIn("$", route["whatToDo"])

    def test_default_route_never_uses_h3(self):
        state = {"ownerCache": False, "ownLtx": False, "wan": True, "h3OwnerCopy": True, "h3Own": True,
                 "ltxGated": False, "hfSecretPresent": False, "hfSecret": S.HF_SECRET_NAME}
        self.assertEqual(R.choose_route(None, state)["engine"], "wan")
        self.assertEqual(S.DEFAULT_ENGINE, "ltx")


class PromptTests(unittest.TestCase):
    def test_prompt_follows_the_first_and_last_frame_layout(self):
        prompt = generate.h3_prompt("Tayne: a dancer in a hat", "grey", 4.0)
        self.assertTrue(prompt.startswith("How the reference pictures align"))
        self.assertIn("Picture 2 (from Shot 1) aligns with the 4.00-second mark", prompt)
        self.assertIn("integrated_multimodal_description: [Shot 1]", prompt)
        self.assertIn("Tayne: a dancer in a hat.", prompt)
        self.assertIn("plain flat grey studio backdrop", prompt)
        self.assertIn("non_diegetic_music:", prompt)


class FileCheckTests(unittest.TestCase):
    """The cloud-side checks, run on a temporary folder with three tiny stand-in files."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "rev" / "FL2VA"
        data = {"transformer/a.safetensors": b"weights", "text_encoder/b.safetensors": b"words",
                "model_index.json": b"{}"}
        files = {}
        for name, content in data.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            digest = ("gitblob:" + hashlib.sha1(b"blob %d\0" % len(content) + content).hexdigest()
                      if name.endswith(".json") else "sha256:" + hashlib.sha256(content).hexdigest())
            files[name] = [len(content), digest]
        patch = mock.patch.object(media_h3, "spec", lambda: {"repo": S.H3_REPO, "revision": "rev",
                                                            "folder": "FL2VA", "files": files})
        patch.start()
        self.addCleanup(patch.stop)

    def test_good_copy_passes(self):
        self.assertEqual(media_h3.check_sizes(self.root), [])
        self.assertEqual(media_h3.check_full(self.root)["bad"], [])
        self.assertEqual(media_h3.check_records(self.root), [])

    def test_changed_file_is_caught(self):
        (self.root / "text_encoder/b.safetensors").write_bytes(b"WORDS")
        self.assertEqual(media_h3.check_sizes(self.root), [])                                    # same size ...
        self.assertEqual(media_h3.check_full(self.root)["bad"], ["text_encoder/b.safetensors"])  # ... caught here

    def test_download_record_naming_another_checksum_is_caught(self):
        record = self.root.parent / ".cache/huggingface/download/FL2VA/transformer/a.safetensors.metadata"
        record.parent.mkdir(parents=True)
        record.write_text("rev\n" + "0" * 64 + "\n1.0\n", encoding="utf-8")
        self.assertEqual(media_h3.check_records(self.root), ["transformer/a.safetensors"])


class CommandTests(unittest.TestCase):
    def run_main(self, argv, h3, extra_patches=()):
        buffer = io.StringIO()
        old = generate._STDOUT
        generate._STDOUT = buffer
        base = {"ownerCache": True, "ownLtx": False, "wan": True, "art": True, "hfSecret": S.HF_SECRET_NAME,
                "hfSecretPresent": False, "ltxGated": False, "ownLtxVolume": S.LTX_WEIGHTS_VOLUME}

        def no_cloud():
            raise generate.Failure("stopped before the cloud")
        patches = [mock.patch.object(generate, "account_state", lambda: dict(base)),
                   mock.patch.object(generate, "h3_state", lambda: dict(h3)),
                   mock.patch.object(generate, "h3_cloud", no_cloud), mock.patch.object(generate, "cloud", no_cloud),
                   mock.patch.dict(os.environ, {}, clear=False), *extra_patches]
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                for patch in patches:
                    patch.start()
                try:
                    code = generate.main(argv)
                    settings = {key: os.environ.get(key) for key in (R.CLOUD_H3_VOLUME, R.CLOUD_H3_READ_ONLY)}
                finally:
                    for patch in reversed(patches):
                        patch.stop()
        finally:
            generate._STDOUT = old
        return code, [json.loads(line) for line in buffer.getvalue().splitlines() if line.strip()], settings

    def test_dry_run_prices_h3(self):
        code, lines, _ = self.run_main(["--name", "T", "--prompt", "a", "--engine", "h3", "--dry-run"],
                                       {"h3OwnerCopy": True, "h3Own": False})
        self.assertEqual(code, 0)
        self.assertEqual((lines[-1]["engine"], lines[-1]["danceModel"]), ("h3", "MiniMax H3"))
        self.assertAlmostEqual(lines[-1]["costUsdEstimate"],
                               round(180 * S.ART_RATE + S.MODAL_DANCE_SECONDS["h3"] * S.H3_RATE, 2))

    def test_run_without_a_copy_stops_with_the_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "new"
            code, lines, _ = self.run_main(["--name", "X", "--prompt", "a", "--out", str(out), "--engine", "h3"],
                                           {"h3OwnerCopy": False, "h3Own": False})
            self.assertFalse(out.exists())
        self.assertNotEqual(code, 0)
        self.assertIn(R.H3_PREPARE_COMMAND, lines[-1]["error"])

    def test_cost_cap_counts_the_whole_time_limit(self):
        self.assertLessEqual(240 * S.ART_RATE + S.H3_TIMEOUT * S.H3_RATE + 240 * S.ART_RATE, 1.5)  # fits the default
        with tempfile.TemporaryDirectory() as tmp:
            code, lines, _ = self.run_main(["--name", "X", "--prompt", "a", "--out", tmp, "--engine", "h3",
                                            "--max-cost", "1"], {"h3OwnerCopy": True, "h3Own": False})
        self.assertNotEqual(code, 0)
        self.assertIn("--max-cost", lines[-1]["error"])

    def test_owner_copy_is_mounted_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, _, settings = self.run_main(["--name", "X", "--prompt", "a", "--out", tmp, "--engine", "h3",
                                            "--stills-only"], {"h3OwnerCopy": True, "h3Own": False})
        self.assertIsNone(settings[R.CLOUD_H3_VOLUME])           # pictures only: H3 is not even set up
        stand_ins = (mock.patch.object(generate, "load_keyframe", lambda out: None),
                     mock.patch.object(generate, "keyframe_on_backdrop", lambda *a: ("grey", (128, 128, 128), b"png")))
        with tempfile.TemporaryDirectory() as tmp:
            _, lines, settings = self.run_main(["--name", "X", "--prompt", "a", "--out", tmp, "--engine", "h3",
                                                "--from-still"], {"h3OwnerCopy": True, "h3Own": False}, stand_ins)
        self.assertEqual((settings[R.CLOUD_H3_VOLUME], settings[R.CLOUD_H3_READ_ONLY]), (S.H3_CACHE_VOLUME, "1"))
        self.assertIn("stopped before the cloud", lines[-1]["error"])

    def test_prepare_dry_run(self):
        code, lines, _ = self.run_main(["--prepare", "--engine", "h3", "--dry-run"],
                                       {"h3OwnerCopy": False, "h3Own": False})
        self.assertEqual(code, 0)
        self.assertTrue(lines[-1]["prepare"]["download"])
        self.assertIn("GB", lines[-1]["prepare"]["summary"])


if __name__ == "__main__":
    unittest.main()
