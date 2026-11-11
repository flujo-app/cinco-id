"""Seedance dance step against a fake local OpenRouter (no network, no key, no cost).

Run from the repository root:
    python -m unittest discover -s test/media -v
"""
from __future__ import annotations

import io
import json
import os
import sys
import threading
import unittest
from contextlib import redirect_stdout
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "media"))

import generate  # noqa: E402
import make_cast  # noqa: E402
import media_seedance as SD  # noqa: E402

KEY = "sk-or-test-0123456789abcdef"
REAL_HTTP = SD.Http
JOB = "gen-vid-1786141253-abcdefghij0123456789"
FAKE_MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
CATALOG = {"data": [{
    "id": "bytedance/seedance-2.5", "canonical_slug": "bytedance/seedance-2.5-20260807",
    "supported_resolutions": ["480p", "720p"], "supported_aspect_ratios": ["16:9", "3:4", "9:16"],
    "supported_sizes": ["854x480", "560x752", "480x854", "834x1112", "720x1280"],
    "supported_durations": list(range(4, 31)), "supported_frame_images": ["first_frame", "last_frame"],
    "pricing_skus": {"video_tokens": "0.0000107", "video_tokens_without_audio": "0.0000107"},
}]}


class Fake:
    """Shared state of the fake API and the fake storage server."""

    def __init__(self):
        self.posts = []
        self.statuses = ["pending", "in_progress", "completed"]
        self.submit_status = 202
        self.final_error = None
        self.storage_saw_key = None
        self.api_requests = []


def make_handler(fake: Fake, storage_url_holder: dict):
    class Api(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, payload=None, headers=None, raw=None):
            body = raw if raw is not None else json.dumps(payload).encode()
            self.send_response(status)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            fake.api_requests.append((self.path, self.headers.get("Authorization")))
            if self.path == "/api/v1/videos/models":
                return self.send(200, CATALOG)
            if self.path == f"/api/v1/videos/{JOB}":
                status = fake.statuses.pop(0) if len(fake.statuses) > 1 else fake.statuses[0]
                payload = {"id": JOB, "status": status, "polling_url": f"/api/v1/videos/{JOB}"}
                if status == "completed":
                    payload["usage"] = {"cost": 0.528}
                if status == "failed":
                    payload["error"] = fake.final_error or "blocked"
                return self.send(200, payload)
            if self.path == f"/api/v1/videos/{JOB}/content?index=0":
                return self.send(302, {}, {"Location": storage_url_holder["url"] + "/stored/clip.mp4?sig=secret"})
            return self.send(404, {"error": "no such thing"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            fake.posts.append({"body": body, "auth": self.headers.get("Authorization")})
            if fake.submit_status != 202:
                return self.send(fake.submit_status, {"error": {"message": f"bad request, key was {KEY}"}})
            return self.send(202, {"id": JOB, "polling_url": f"/api/v1/videos/{JOB}", "status": "pending"})

    class Storage(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            fake.storage_saw_key = self.headers.get("Authorization")
            self.send_response(200)
            self.send_header("Content-Length", str(len(FAKE_MP4)))
            self.end_headers()
            self.wfile.write(FAKE_MP4)

    return Api, Storage


class FakeServers:
    def __enter__(self):
        self.fake = Fake()
        holder = {}
        api, storage = make_handler(self.fake, holder)
        self.api = ThreadingHTTPServer(("127.0.0.1", 0), api)
        self.storage = ThreadingHTTPServer(("127.0.0.1", 0), storage)
        holder["url"] = f"http://localhost:{self.storage.server_address[1]}"   # a different origin
        for server in (self.api, self.storage):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.api.server_address[1]}/api/v1"
        return self

    def __exit__(self, *exc):
        for server in (self.api, self.storage):
            server.shutdown()
            server.server_close()

    def http(self, key=KEY):
        return SD.Http(api=self.base, key=key, timeout=10)


class PriceTests(unittest.TestCase):
    def test_token_formula_matches_catalogue_headline(self):
        per_second = SD.video_tokens("480x854", seconds=1) * Decimal("0.0000107")
        self.assertEqual(per_second.quantize(Decimal("0.0001")), Decimal("0.1028"))

    def test_cost_per_clip(self):
        model = SD.find_model(CATALOG)
        self.assertEqual(SD.estimate_usd(model, "480p"), Decimal("0.528"))
        self.assertEqual(SD.estimate_usd(model, "720p"), Decimal("1.163"))

    def test_catalogue_changes_are_caught(self):
        model = json.loads(json.dumps(SD.find_model(CATALOG)))
        model["supported_sizes"].remove("560x752")
        with self.assertRaises(SD.SeedanceError):
            SD.check_model(model, "480p")
        model = json.loads(json.dumps(SD.find_model(CATALOG)))
        model["pricing_skus"] = {}
        with self.assertRaises(SD.SeedanceError):
            SD.check_model(model, "720p")
        with self.assertRaises(SD.SeedanceError):
            SD.find_model({"data": []})


class RequestTests(unittest.TestCase):
    def test_same_picture_first_and_last_no_audio(self):
        request = SD.build_request("dance", PNG, "480p", seed=7)
        self.assertEqual(request["model"], "bytedance/seedance-2.5")
        self.assertEqual((request["duration"], request["size"], request["aspect_ratio"]), (5, "560x752", "3:4"))
        self.assertIs(request["generate_audio"], False)
        frames = request["frame_images"]
        self.assertEqual([f["frame_type"] for f in frames], ["first_frame", "last_frame"])
        self.assertEqual(frames[0]["image_url"], frames[1]["image_url"])
        self.assertTrue(frames[0]["image_url"]["url"].startswith("data:image/png;base64,"))
        shown = json.dumps(SD.describe_request(request))
        self.assertNotIn("base64", shown)

    def test_rejects_non_png_and_bad_resolution(self):
        with self.assertRaises(SD.SeedanceError):
            SD.build_request("dance", b"GIF89a", "480p", 1)
        with self.assertRaises(SD.SeedanceError):
            SD.build_request("dance", PNG, "1080p", 1)

    def test_key_only_from_environment(self):
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": "  sk-or-abc  "}):
            self.assertEqual(SD.read_key(), "sk-or-abc")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(SD.read_key(), "")

    def test_key_never_sent_elsewhere(self):
        http = SD.Http(api="https://openrouter.ai/api/v1", key=KEY)
        with self.assertRaises(SD.SeedanceError):
            http.fetch("GET", "https://example.com/api/v1/videos", auth=True)
        with self.assertRaises(SD.SeedanceError):
            http.fetch("GET", "http://openrouter.ai/api/v1/videos", auth=True)   # not https


class FlowTests(unittest.TestCase):
    def test_happy_path_polls_and_downloads(self):
        with FakeServers() as servers:
            statuses = []
            result = SD.make_clip(servers.http(), SD.build_request("dance", PNG, "480p", 3),
                                  on_status=lambda job: statuses.append(job["status"]), sleep=lambda s: None)
            fake = servers.fake
        self.assertEqual(result["video"], FAKE_MP4)
        self.assertEqual(result["costUsd"], 0.528)
        self.assertEqual(len(fake.posts), 1)
        self.assertEqual(fake.posts[0]["auth"], f"Bearer {KEY}")
        self.assertEqual(fake.posts[0]["body"]["frame_images"][0]["frame_type"], "first_frame")
        self.assertEqual(statuses, ["pending", "pending", "in_progress", "completed"])
        self.assertIsNone(fake.storage_saw_key)          # the redirected download carried no key

    def test_failed_job_is_reported_and_not_resent(self):
        with FakeServers() as servers:
            servers.fake.statuses = ["pending", "failed"]
            servers.fake.final_error = "the picture was refused"
            with self.assertRaises(SD.SeedanceError) as caught:
                SD.make_clip(servers.http(), SD.build_request("dance", PNG, "480p", 3), sleep=lambda s: None)
            self.assertEqual(len(servers.fake.posts), 1)
        self.assertIn("could not make the dance", str(caught.exception))

    def test_rejected_submit_is_not_retried_and_hides_key(self):
        with FakeServers() as servers:
            servers.fake.submit_status = 400
            with self.assertRaises(SD.HttpError) as caught:
                SD.make_clip(servers.http(), SD.build_request("dance", PNG, "480p", 3), sleep=lambda s: None)
            self.assertEqual(len(servers.fake.posts), 1)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertIn("did not accept", str(caught.exception))

    def test_polling_gives_up_after_the_time_limit(self):
        with FakeServers() as servers:
            servers.fake.statuses = ["in_progress"]
            ticks = iter(range(0, 10000, 100))
            with self.assertRaises(SD.SeedanceError) as caught:
                SD.make_clip(servers.http(), SD.build_request("dance", PNG, "480p", 3), max_wait=250,
                             sleep=lambda s: None, clock=lambda: next(ticks))
        self.assertIn("not ready in time", str(caught.exception))

    def test_missing_key_stops_before_sending(self):
        with FakeServers() as servers:
            with self.assertRaises(SD.SeedanceError):
                SD.make_clip(servers.http(key=""), SD.build_request("dance", PNG, "480p", 3), sleep=lambda s: None)
            self.assertEqual(servers.fake.posts, [])

    def test_catalogue_is_read_without_key(self):
        with FakeServers() as servers:
            SD.catalogue(SD.Http(api=servers.base, key=KEY))
            path, auth = servers.fake.api_requests[-1]
        self.assertEqual(path, "/api/v1/videos/models")
        self.assertIsNone(auth)


class CommandTests(unittest.TestCase):
    def capture(self, function, argv):
        buffer = io.StringIO()
        old = generate._STDOUT
        generate._STDOUT = buffer
        try:
            with redirect_stdout(buffer):
                code = function(argv)
        finally:
            generate._STDOUT = old
        return code, [json.loads(line) for line in buffer.getvalue().splitlines() if line.strip()]

    def test_dry_run_prices_both_resolutions_and_spends_nothing(self):
        with FakeServers() as servers:
            fake_http = lambda *a, **k: REAL_HTTP(api=servers.base, key="", timeout=10)  # noqa: E731
            with mock.patch.object(SD, "Http", fake_http), mock.patch.dict(os.environ, {}, clear=True):
                code, lines = self.capture(generate.main, ["--name", "Tayne", "--prompt", "A dancer",
                                                           "--engine", "seedance", "--dry-run"])
            self.assertEqual(servers.fake.posts, [])
        self.assertEqual(code, 0)
        result = lines[-1]
        self.assertTrue(result["dryRun"])
        self.assertEqual(result["seedanceUsdPerClip"], {"480p": 0.528, "720p": 1.163})
        self.assertFalse(result["keyPresent"])
        self.assertEqual(result["request"]["size"], "560x752")

    def test_engine_default_follows_key(self):
        with mock.patch.dict(os.environ, {"OPENROUTER_API_KEY": KEY}):
            self.assertEqual(generate.choose_engine(None), "seedance")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(generate.choose_engine(None), "ltx")
        self.assertEqual(generate.choose_engine("ltx"), "ltx")

    def test_real_seedance_run_without_key_spends_nothing(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            code, lines = self.capture(generate.main, ["--name", "X", "--prompt", "a", "--out", str(ROOT / ".no-such"),
                                                       "--engine", "seedance", "--from-still"])
        self.assertNotEqual(code, 0)
        self.assertIn("OPENROUTER_API_KEY", lines[-1]["error"])
        self.assertFalse((ROOT / ".no-such").exists())        # nothing was even created

    def test_make_cast_without_yes_only_prints_the_plan(self):
        with FakeServers() as servers:
            fake_http = lambda *a, **k: REAL_HTTP(api=servers.base, key="", timeout=10)  # noqa: E731
            with mock.patch.object(SD, "Http", fake_http), \
                    mock.patch.object(make_cast, "subprocess") as never_called:
                buffer = io.StringIO()
                with redirect_stdout(buffer):
                    make_cast.main(["--engine", "seedance", "--resolution", "720p"])
                never_called.Popen.assert_not_called()
            self.assertEqual(servers.fake.posts, [])
        lines = [json.loads(line) for line in buffer.getvalue().splitlines()]
        plan = lines[0]
        self.assertEqual(len(plan["sequences"]), 4)
        each = plan["sequences"][0]["costUsdEstimate"]
        self.assertGreater(each, 1.163)                    # Seedance clip plus the cut-out step
        self.assertAlmostEqual(plan["totalUsdEstimate"], round(4 * each, 2), places=2)


if __name__ == "__main__":
    unittest.main()
