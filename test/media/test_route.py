"""Which dance model a Modal account can use (no cloud, no graphics card, no key).

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
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "media"))

import generate  # noqa: E402
import media_ltx  # noqa: E402
import media_route as R  # noqa: E402
import media_settings as S  # noqa: E402

LTX_READY = {"status": "ready", "repo_id": S.LTX_REPO, "revision": S.LTX_REVISION,
             "files": {role: {"filename": f, "size": size, "sha256": sha} for role, (f, size, sha) in S.LTX_FILES.items()}}
WAN_READY = {"repo": S.WAN_REPO, "revision": S.WAN_REVISION, "files": 30}
ART_READY = {"zimage": [S.ZIMAGE_REPO, S.ZIMAGE_REVISION], "birefnet": [S.BIREFNET_REPO, S.BIREFNET_REVISION]}
SECRET_LIKE = "hf_"     # the start of every Hugging Face token; must never appear in a message


class FakeAccount:
    """Stands in for the Modal look-ups: volumes that exist with their ready.json, and secret names."""

    def __init__(self, volumes=None, secrets=()):
        self.volumes = volumes or {}
        self.secrets = set(secrets)
        self.reads = []

    def read_json(self, volume, path):
        self.reads.append(volume)
        return self.volumes.get(volume, {}).get(path)

    def secret_exists(self, name):
        return name in self.secrets


def account(owner=False, own=False, wan=True, art=True, secrets=()):
    volumes = {}
    if owner:
        volumes[S.LTX_CACHE_VOLUME] = {"ready.json": LTX_READY}
    if own:
        volumes[S.LTX_WEIGHTS_VOLUME] = {"ready.json": LTX_READY}
    if wan:
        volumes[S.WAN_WEIGHTS_VOLUME] = {"ready.json": WAN_READY}
    if art:
        volumes[S.ART_WEIGHTS_VOLUME] = {"ready.json": ART_READY}
    return FakeAccount(volumes, secrets)


def state_of(fake, gated=True, environ=None):
    return R.inspect_account(fake, gated=gated, environ=environ if environ is not None else {})


class ChoiceTests(unittest.TestCase):
    def test_owner_cache_is_used_read_only_as_before(self):
        state = state_of(account(owner=True), gated=lambda: self.fail("Hugging Face asked although LTX is ready"))
        route = R.choose_route(None, state)
        self.assertEqual(route["engine"], "ltx")
        self.assertFalse(route["fallback"])
        self.assertIn("owner's existing copy", route["why"])
        cloud = R.cloud_settings(state)
        self.assertEqual(cloud[R.CLOUD_LTX_VOLUME], S.LTX_CACHE_VOLUME)
        self.assertEqual(cloud[R.CLOUD_LTX_READ_ONLY], "1")
        self.assertEqual(cloud[R.CLOUD_HF_SECRET], R.NO_SECRET)
        plan = R.prepare_plan(state)
        self.assertFalse([step for step in plan["downloads"] if step["model"].startswith("LTX")])
        self.assertEqual(plan["downloadGb"], 0)

    def test_owner_cache_with_another_version_is_not_used(self):
        other = dict(LTX_READY, revision="0" * 40)
        fake = FakeAccount({S.LTX_CACHE_VOLUME: {"ready.json": other}, S.WAN_WEIGHTS_VOLUME: {"ready.json": WAN_READY}})
        self.assertFalse(state_of(fake)["ownerCache"])
        broken = json.loads(json.dumps(LTX_READY))
        broken["files"]["transformer"]["sha256"] = "1" * 64
        self.assertFalse(R.ltx_record_ok(broken))
        self.assertTrue(R.ltx_record_ok(LTX_READY))

    def test_own_volume_prepared(self):
        state = state_of(account(own=True))
        route = R.choose_route(None, state)
        self.assertEqual(route["engine"], "ltx")
        self.assertIn("this account's own copy", route["why"])
        cloud = R.cloud_settings(state)
        self.assertEqual(cloud[R.CLOUD_LTX_VOLUME], S.LTX_WEIGHTS_VOLUME)
        self.assertEqual(cloud[R.CLOUD_LTX_READ_ONLY], "0")
        self.assertEqual(R.prepare_plan(state)["alreadyReady"], ["picture and cut-out models", "LTX-2.5", "Wan2.2"])

    def test_only_wan_prepared_falls_back_with_a_plain_message(self):
        state = state_of(account(wan=True), gated=False)
        route = R.choose_route(None, state)
        self.assertEqual(route["engine"], "wan")
        self.assertTrue(route["fallback"])
        self.assertIn("made with Wan2.2 instead", route["why"])
        self.assertIn(R.PREPARE_COMMAND, route["why"])
        # Asking for LTX by name does not silently switch.
        asked = R.choose_route("ltx", state)
        self.assertIsNone(asked["engine"])
        self.assertEqual(asked["whatToDo"], R.PREPARE_COMMAND)

    def test_nothing_prepared_names_the_command(self):
        state = state_of(account(wan=False, art=False))
        route = R.choose_route(None, state)
        self.assertIsNone(route["engine"])
        self.assertIn(R.PREPARE_COMMAND, route["whatToDo"])
        self.assertIn("GB", route["whatToDo"])
        plan = R.prepare_plan(state)
        self.assertEqual([step["model"].split()[0] for step in plan["downloads"]], ["picture", "LTX-2.5", "Wan2.2"])
        self.assertEqual(plan["downloadGb"], round(S.PREPARE_GB["art"] + S.PREPARE_GB["ltx"] + S.PREPARE_GB["wan"], 1))
        self.assertGreater(plan["usdEstimate"], 0.1)
        self.assertLess(plan["usdEstimate"], 0.5)
        self.assertIn("minutes", plan["summary"])

    def test_sign_in_needed(self):
        state = state_of(account(), gated=True)
        self.assertFalse(state["hfSecretPresent"])
        plan = R.prepare_plan(state)
        step = next(step for step in plan["downloads"] if step["model"].startswith("LTX"))
        self.assertTrue(step["needsSignIn"])
        self.assertIn("accept the licence", plan["ltxSignIn"])
        self.assertIn(f"modal secret create {S.HF_SECRET_NAME} HF_TOKEN=<your token>", plan["ltxSignIn"])
        self.assertIn(S.LTX_PAGE, plan["ltxSignIn"])
        self.assertNotIn(SECRET_LIKE, plan["ltxSignIn"])
        route = R.choose_route(None, state)
        self.assertEqual(route["engine"], "wan")
        self.assertIn("Hugging Face sign-in", route["why"])
        self.assertEqual(R.cloud_settings(state)[R.CLOUD_HF_SECRET], R.NO_SECRET)
        for problem in ("not-accepted", "bad-token"):
            self.assertIn("Modal secret", R.sign_in_steps(S.HF_SECRET_NAME, problem))

    def test_stored_sign_in_is_handed_to_the_download_by_name_only(self):
        state = state_of(account(secrets=[S.HF_SECRET_NAME]), gated=True)
        plan = R.prepare_plan(state)
        self.assertIsNone(plan["ltxSignIn"])
        self.assertEqual(R.cloud_settings(state)[R.CLOUD_HF_SECRET], S.HF_SECRET_NAME)
        other = state_of(account(secrets=["huggingface-secret"]), environ={S.ENV_HF_SECRET: "huggingface-secret"})
        self.assertEqual(R.cloud_settings(other)[R.CLOUD_HF_SECRET], "huggingface-secret")

    def test_testing_switch_ignores_the_owner_cache(self):
        fake = account(owner=True)
        environ = {S.ENV_IGNORE_LTX_CACHE: "1", S.ENV_LTX_VOLUME: "beta-sequence-ltx-weights-temp-test"}
        state = state_of(fake, gated=True, environ=environ)
        self.assertNotIn(S.LTX_CACHE_VOLUME, fake.reads)
        self.assertFalse(state["ownerCache"])
        self.assertEqual(R.choose_route(None, state)["engine"], "wan")
        cloud = R.cloud_settings(state)
        self.assertEqual(cloud[R.CLOUD_LTX_VOLUME], "beta-sequence-ltx-weights-temp-test")
        self.assertEqual(cloud[R.CLOUD_LTX_READ_ONLY], "0")

    def test_explicit_engines(self):
        state = state_of(account(owner=True, wan=False))
        self.assertEqual(R.choose_route("wan", state)["engine"], "wan")
        self.assertIn("downloaded first", R.choose_route("wan", state)["why"])
        self.assertEqual(R.choose_route("openrouter", state)["engine"], "openrouter")
        self.assertEqual(R.choose_route("ltx", state)["engine"], "ltx")


class CommandTests(unittest.TestCase):
    def run_main(self, argv, state):
        buffer = io.StringIO()
        old = generate._STDOUT
        generate._STDOUT = buffer

        def no_cloud():
            raise generate.Failure("stopped before the cloud")
        try:
            with redirect_stdout(io.StringIO()), mock.patch.object(generate, "account_state", lambda: state), \
                    mock.patch.object(generate, "cloud", no_cloud), mock.patch.dict(os.environ, {}, clear=False):
                code = generate.main(argv)
                settings = {key: os.environ.get(key) for key in (R.CLOUD_LTX_VOLUME, R.CLOUD_LTX_READ_ONLY)}
        finally:
            generate._STDOUT = old
        return code, [json.loads(line) for line in buffer.getvalue().splitlines() if line.strip()], settings

    def test_dry_run_says_which_model_and_why(self):
        code, lines, _ = self.run_main(["--name", "Tayne", "--prompt", "A dancer", "--dry-run"],
                                       state_of(account(wan=True), gated=True))
        self.assertEqual(code, 0)
        result = lines[-1]
        self.assertEqual((result["engine"], result["danceModel"]), ("wan", "Wan2.2"))
        self.assertTrue(result["fallback"])
        self.assertIn("Hugging Face", result["why"])
        self.assertAlmostEqual(result["costUsdEstimate"],
                               round(180 * S.ART_RATE + S.MODAL_DANCE_SECONDS["wan"] * S.MOTION_RATE, 2))
        code, lines, _ = self.run_main(["--name", "Tayne", "--prompt", "A dancer", "--dry-run"],
                                       state_of(account(owner=True)))
        self.assertEqual((lines[-1]["engine"], lines[-1]["fallback"]), ("ltx", False))

    def test_default_run_with_nothing_prepared_stops_with_the_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "new"
            code, lines, _ = self.run_main(["--name", "X", "--prompt", "a", "--out", str(out)],
                                           state_of(account(wan=False, art=False)))
            self.assertFalse(out.exists())
        self.assertNotEqual(code, 0)
        self.assertIn(R.PREPARE_COMMAND, lines[-1]["error"])

    def test_default_run_falls_back_to_wan_and_says_so(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, lines, settings = self.run_main(["--name", "X", "--prompt", "a", "--out", tmp],
                                                  state_of(account(wan=True), gated=True))
        self.assertNotEqual(code, 0)                         # stopped on purpose before the cloud
        self.assertIn("Wan2.2 instead", lines[0]["message"])
        self.assertEqual(settings[R.CLOUD_LTX_VOLUME], S.LTX_WEIGHTS_VOLUME)
        self.assertEqual(settings[R.CLOUD_LTX_READ_ONLY], "0")

    def test_owner_run_keeps_the_read_only_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, lines, settings = self.run_main(["--name", "X", "--prompt", "a", "--out", tmp],
                                               state_of(account(owner=True)))
        self.assertIn("LTX-2.5", lines[0]["message"])
        self.assertEqual(settings[R.CLOUD_LTX_VOLUME], S.LTX_CACHE_VOLUME)
        self.assertEqual(settings[R.CLOUD_LTX_READ_ONLY], "1")

    def test_prepare_dry_run_states_size_time_and_cost(self):
        code, lines, _ = self.run_main(["--prepare", "--dry-run"], state_of(account(wan=False, art=False)))
        self.assertEqual(code, 0)
        result = lines[-1]
        self.assertTrue(result["dryRun"])
        self.assertIsNone(result["danceModelNow"])
        self.assertIn("GB", result["prepare"]["summary"])
        self.assertIn("$", result["prepare"]["summary"])
        self.assertTrue(result["prepare"]["ltxSignIn"])


class LtxDownloadTests(unittest.TestCase):
    """The cloud-side LTX preparation, run on a temporary folder with three tiny stand-in files."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.files = {}
        for role, data in {"transformer": b"weights", "text_encoder": b"words", "video_vae": b"pictures"}.items():
            self.files[role] = (f"sub/{role}.safetensors", len(data), hashlib.sha256(data).hexdigest())
        patches = [mock.patch.object(media_ltx, "CACHE_ROOT", root), mock.patch.object(media_ltx, "LTX_FILES", self.files)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.tmp.cleanup)
        self.root = root

    def write_files(self, broken=None):
        for role, (filename, _size, _sha) in self.files.items():
            path = media_ltx.snapshot_dir() / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            data = {"transformer": b"weights", "text_encoder": b"words", "video_vae": b"pictures"}[role]
            path.write_bytes(data.upper() if role == broken else data)

    def test_without_sign_in_nothing_is_downloaded(self):
        with mock.patch.object(media_ltx, "access_problem", lambda token: "no-token"), \
                mock.patch.dict(os.environ, {"HF_TOKEN": ""}):
            result = media_ltx.prepare_weights(lambda: None)
        self.assertEqual(result["status"], "needs-sign-in")
        self.assertEqual(result["problem"], "no-token")
        self.assertFalse((self.root / "ready.json").exists())

    def test_complete_files_are_checked_not_downloaded(self):
        self.write_files()
        with mock.patch.object(media_ltx, "access_problem", lambda token: self.fail("asked Hugging Face")):
            result = media_ltx.prepare_weights(lambda: None)
        self.assertEqual((result["status"], result["downloaded_now"], result["files"]), ("ready", False, 3))
        record = json.loads((self.root / "ready.json").read_text(encoding="utf-8"))
        self.assertEqual((record["repo_id"], record["revision"]), (S.LTX_REPO, S.LTX_REVISION))
        self.assertEqual(set(media_ltx.model_paths()), set(self.files))

    def test_a_file_with_the_wrong_checksum_is_removed(self):
        self.write_files(broken="text_encoder")
        with self.assertRaises(RuntimeError) as caught:
            media_ltx.prepare_weights(lambda: None)
        self.assertIn("checksum", str(caught.exception))
        self.assertFalse((media_ltx.snapshot_dir() / self.files["text_encoder"][0]).exists())
        self.assertFalse((self.root / "ready.json").exists())


if __name__ == "__main__":
    unittest.main()
