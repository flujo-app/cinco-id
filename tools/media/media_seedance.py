"""Dance step through Seedance 2.5 on OpenRouter (a paid, hosted service).

- The key is read only from the OPENROUTER_API_KEY environment variable.
- One clip = one POST. A POST is never retried, even after a timeout, so a
  clip can never be paid for twice by accident.
- The key is only ever sent to the OpenRouter API address. Downloads that are
  redirected to a storage server go there without the key.
- The dry run reads the public catalogue (no key, no cost) and prices one clip.

Standard library only, so it can be tested with a fake local server.
"""
from __future__ import annotations

import base64
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from media_settings import (
    OPENROUTER_API, SEEDANCE_FPS, SEEDANCE_MODEL, SEEDANCE_PRICE_SKU, SEEDANCE_SECONDS, SEEDANCE_SIZES,
)

TERMINAL_FAILURES = {"failed", "cancelled", "expired"}
KNOWN_STATUSES = {"pending", "in_progress", "completed", *TERMINAL_FAILURES}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 256 * 1024 * 1024


class SeedanceError(Exception):
    """A plain-English error that never contains the key."""


def read_key() -> str:
    """The key comes from the environment variable and nowhere else."""
    return os.environ.get("OPENROUTER_API_KEY", "").strip()


def scrub(text: str, key: str = "") -> str:
    text = str(text)
    if key:
        text = text.replace(key, "[key]")
    text = re.sub(r"sk-or-[A-Za-z0-9_-]+", "[key]", text)
    text = re.sub(r"(?i)bearer\s+\S+", "Bearer [key]", text)
    text = re.sub(r"data:[^\s\"']+", "[picture]", text)
    text = re.sub(r"(https?://[^\s\"'?]+)\?\S+", r"\1?[hidden]", text)
    return text[:400]


@dataclass
class Reply:
    status: int
    headers: dict
    body: bytes


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Http:
    def __init__(self, api: str = OPENROUTER_API, key: str = "", timeout: float = 60):
        self.api = api.rstrip("/")
        self.key = key
        self.timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirect)
        origin = urllib.parse.urlsplit(self.api)
        self._origin = (origin.scheme, origin.netloc)
        self._prefix = origin.path.rstrip("/") + "/"

    def _allowed(self, url: str) -> urllib.parse.SplitResult:
        parts = urllib.parse.urlsplit(url)
        local = parts.hostname in {"127.0.0.1", "localhost", "::1"}
        if parts.username or parts.password or not (parts.scheme == "https" or (parts.scheme == "http" and local)):
            raise SeedanceError("Refusing an unsafe web address")
        return parts

    def is_api(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        return (parts.scheme, parts.netloc) == self._origin and (parts.path + "/").startswith(self._prefix)

    def fetch(self, method: str, url: str, payload: dict | None = None, auth: bool = False,
              limit: int = 4 * 1024 * 1024) -> Reply:
        self._allowed(url)
        headers = {"Accept": "application/json", "User-Agent": "beta-sequence-media/1"}
        if auth:
            if not self.is_api(url):
                raise SeedanceError("Refusing to send the key anywhere except the OpenRouter API")
            if not self.key:
                raise SeedanceError("No OpenRouter key: set the OPENROUTER_API_KEY environment variable")
            headers["Authorization"] = f"Bearer {self.key}"
        data = None
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            try:
                response = self._opener.open(request, timeout=self.timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                body = response.read(limit + 1)
                if len(body) > limit:
                    raise SeedanceError("The reply from the video service was too large")
                return Reply(response.status, {k.lower(): v for k, v in response.headers.items()}, body)
        except SeedanceError:
            raise
        except Exception as error:  # network errors can carry addresses; keep only the kind
            raise SeedanceError(f"Could not reach the video service ({type(error).__name__})") from None

    def json(self, method: str, path: str, payload: dict | None = None, auth: bool = False) -> dict:
        reply = self.fetch(method, self.api + path, payload, auth)
        if not 200 <= reply.status < 300:
            raise HttpError(reply.status, scrub(reply.body.decode("utf-8", "replace"), self.key))
        try:
            value = json.loads(reply.body)
        except ValueError:
            raise SeedanceError("The video service sent an unreadable reply") from None
        if not isinstance(value, dict):
            raise SeedanceError("The video service sent an unexpected reply")
        return value


class HttpError(SeedanceError):
    def __init__(self, status: int, detail: str):
        self.status = status
        plain = {400: "The video service did not accept the request",
                 401: "The OpenRouter key was not accepted",
                 402: "The OpenRouter account has too little credit",
                 403: "The video service refused this request (it may block this picture)",
                 429: "The video service is busy or the account hit a limit"}.get(status, "The video service reported a problem")
        super().__init__(f"{plain} (HTTP {status}: {detail})")


# --- catalogue and price -----------------------------------------------------------
def money(value) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise SeedanceError("The catalogue price is not a number") from None
    if not result.is_finite() or result <= 0:
        raise SeedanceError("The catalogue price is missing or zero")
    return result


def find_model(catalog: dict) -> dict:
    matches = [m for m in catalog.get("data", []) if isinstance(m, dict) and m.get("id") == SEEDANCE_MODEL]
    if len(matches) != 1:
        raise SeedanceError(f"{SEEDANCE_MODEL} is not in the OpenRouter video catalogue")
    return matches[0]


def check_model(model: dict, resolution: str, seconds: int = SEEDANCE_SECONDS) -> dict:
    """Confirm the catalogue still offers exactly what we ask for; returns the price facts."""
    if resolution not in SEEDANCE_SIZES:
        raise SeedanceError("Resolution must be 480p or 720p")
    size = SEEDANCE_SIZES[resolution]
    needs = [("supported_resolutions", resolution), ("supported_sizes", size),
             ("supported_aspect_ratios", "3:4"), ("supported_durations", seconds)]
    for field, value in needs:
        if value not in model.get(field, []):
            raise SeedanceError(f"The catalogue no longer offers {value} for {SEEDANCE_MODEL}")
    if not {"first_frame", "last_frame"} <= set(model.get("supported_frame_images", [])):
        raise SeedanceError("The catalogue no longer offers first and last frame pictures")
    price = money(model.get("pricing_skus", {}).get(SEEDANCE_PRICE_SKU))
    return {"size": size, "usdPerVideoToken": str(price), "canonical": model.get("canonical_slug", SEEDANCE_MODEL)}


def video_tokens(size: str, seconds: int = SEEDANCE_SECONDS, fps: int = SEEDANCE_FPS) -> Decimal:
    """Video tokens = width x height x frames per second x seconds / 1024.

    This matches the catalogue's headline "from $0.1028/second" at 480x854
    (480 * 854 * 24 / 1024 = 9607.5 tokens/s x $0.0000107 = $0.1028/s).
    """
    width, height = (int(part) for part in size.split("x"))
    return Decimal(width * height * fps * seconds) / Decimal(1024)


def estimate_usd(model: dict, resolution: str, seconds: int = SEEDANCE_SECONDS) -> Decimal:
    facts = check_model(model, resolution, seconds)
    return (video_tokens(facts["size"], seconds) * Decimal(facts["usdPerVideoToken"])).quantize(Decimal("0.001"))


# --- request, polling, download ------------------------------------------------------
def build_request(prompt: str, keyframe_png: bytes, resolution: str, seed: int,
                  seconds: int = SEEDANCE_SECONDS) -> dict:
    if not keyframe_png.startswith(b"\x89PNG"):
        raise SeedanceError("The first-frame picture must be a PNG")
    if len(keyframe_png) > MAX_IMAGE_BYTES:
        raise SeedanceError("The first-frame picture is too large")
    if resolution not in SEEDANCE_SIZES:
        raise SeedanceError("Resolution must be 480p or 720p")
    url = "data:image/png;base64," + base64.b64encode(keyframe_png).decode("ascii")
    return {
        "model": SEEDANCE_MODEL, "prompt": prompt, "duration": seconds, "resolution": resolution,
        "aspect_ratio": "3:4", "size": SEEDANCE_SIZES[resolution], "generate_audio": False,
        "seed": int(seed) % (2 ** 31),
        # The same picture as first AND last frame: the dance ends where it started, so it loops.
        "frame_images": [
            {"type": "image_url", "image_url": {"url": url}, "frame_type": "first_frame"},
            {"type": "image_url", "image_url": {"url": url}, "frame_type": "last_frame"},
        ],
    }


def describe_request(request: dict) -> dict:
    """The request without the picture data, for printing."""
    shown = {key: value for key, value in request.items() if key != "frame_images"}
    shown["frame_images"] = [f"{item['frame_type']}: PNG picture ({len(item['image_url']['url']) * 3 // 4:,} bytes)"
                             for item in request["frame_images"]]
    return shown


def _job(value: dict, expected: str | None = None) -> dict:
    job_id = value.get("id") or expected
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", job_id):
        raise SeedanceError("The video service returned no usable job number")
    if expected and job_id != expected:
        raise SeedanceError("The video service answered about a different job")
    status = value.get("status")
    if status not in KNOWN_STATUSES:
        raise SeedanceError("The video service reported an unknown job state")
    job = {"id": job_id, "status": status}
    if value.get("error"):
        job["error"] = scrub(value["error"])
    usage = value.get("usage")
    if isinstance(usage, dict) and usage.get("cost") is not None:
        try:
            job["cost"] = float(Decimal(str(usage["cost"])))
        except (InvalidOperation, ValueError):
            pass
    return job


def submit(http: Http, request: dict) -> dict:
    """Exactly one POST. Never retried: an unclear answer may still have been charged."""
    try:
        return _job(http.json("POST", "/videos", request, auth=True))
    except HttpError:
        raise
    except SeedanceError as error:
        raise SeedanceError(f"{error}. The clip may or may not have started; it was not sent again") from None


def wait(http: Http, job_id: str, max_wait: float = 900, interval: float = 10,
         clock=time.monotonic, sleep=time.sleep, on_status=None) -> dict:
    deadline = clock() + max_wait
    while True:
        job = _job(http.json("GET", f"/videos/{job_id}", auth=True), job_id)
        if on_status:
            on_status(job)
        if job["status"] == "completed":
            return job
        if job["status"] in TERMINAL_FAILURES:
            reason = job.get("error") or job["status"]
            raise SeedanceError(f"The video service could not make the dance ({reason})")
        if clock() >= deadline:
            raise SeedanceError(f"The dance was not ready in time; job {job_id} may still finish on OpenRouter")
        sleep(interval)


def download(http: Http, job_id: str) -> bytes:
    url = f"{http.api}/videos/{job_id}/content?index=0"
    for _ in range(5):
        reply = http.fetch("GET", url, auth=http.is_api(url), limit=MAX_VIDEO_BYTES)
        if reply.status in {301, 302, 303, 307, 308}:
            if not reply.headers.get("location"):
                raise SeedanceError("The video download pointed nowhere")
            url = urllib.parse.urljoin(url, reply.headers["location"])
            continue
        if reply.status != 200:
            raise HttpError(reply.status, scrub(reply.body.decode("utf-8", "replace"), http.key))
        if len(reply.body) < 12 or reply.body[4:8] != b"ftyp":
            raise SeedanceError("The downloaded dance is not an MP4 video")
        return reply.body
    raise SeedanceError("The video download was redirected too many times")


def make_clip(http: Http, request: dict, on_status=None, max_wait: float = 900, interval: float = 10,
              sleep=time.sleep, clock=time.monotonic) -> dict:
    began = clock()
    job = submit(http, request)
    if on_status:
        on_status(job)
    job = wait(http, job["id"], max_wait=max_wait, interval=interval, sleep=sleep, clock=clock, on_status=on_status)
    video = download(http, job["id"])
    return {"video": video, "job": job["id"], "costUsd": job.get("cost"), "seconds": round(clock() - began, 1)}


def catalogue(http: Http) -> dict:
    """Public catalogue: no key is sent."""
    return http.json("GET", "/videos/models")
