"""Dance step through a hosted video model on OpenRouter (paid per clip).

Any model in OpenRouter's public video catalogue that accepts a first AND a last
frame picture can be used (default: Seedance 2.5; MiniMax H3 Max also checked).
The catalogue is read live before every clip to confirm the model still offers
what we ask for and to compute the price, which may be listed per second or per
"video token".

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
    OPENROUTER_API, SEEDANCE_FPS, SEEDANCE_MODEL, SEEDANCE_SECONDS,
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


DEFAULT_MODEL = SEEDANCE_MODEL
# Typical pixel count per resolution name, used to pick the matching 3:4 size from the catalogue.
RESOLUTION_PIXELS = {"360p": 360 * 640, "480p": 480 * 854, "720p": 720 * 1280, "768p": 768 * 1365,
                     "1080p": 1080 * 1920}


def find_model(catalog: dict, model_id: str = DEFAULT_MODEL) -> dict:
    matches = [m for m in catalog.get("data", []) if isinstance(m, dict) and m.get("id") == model_id]
    if len(matches) != 1:
        raise SeedanceError(f"{model_id} is not in the OpenRouter video catalogue")
    return matches[0]


def _portrait_size(model: dict, resolution: str) -> str | None:
    """The catalogue's 3:4 portrait size closest to this resolution, if the model lists sizes."""
    portrait = []
    for size in model.get("supported_sizes") or []:
        width, _, height = size.partition("x")
        if width.isdigit() and height.isdigit() and int(width) < int(height) \
                and abs(int(width) / int(height) - 0.75) < 0.02:
            portrait.append(size)
    target = RESOLUTION_PIXELS.get(resolution, 480 * 854)
    pixels = {size: int(size.split("x")[0]) * int(size.split("x")[1]) for size in portrait}
    close = [size for size in portrait if abs(pixels[size] - target) <= 0.35 * target]
    return min(close, key=lambda s: abs(pixels[s] - target)) if close else None


def _price(model: dict, resolution: str) -> tuple[str, str, Decimal]:
    """(kind, price name, US dollars) for a silent picture-to-video clip at this resolution."""
    skus = model.get("pricing_skus") or {}
    per_second = [f"image_to_video_duration_seconds_{resolution}", f"duration_seconds_without_audio_{resolution}",
                  f"duration_seconds_{resolution}", "duration_seconds_without_audio", "duration_seconds",
                  f"duration_seconds_with_audio_{resolution}", "duration_seconds_with_audio"]
    for sku in per_second:
        if sku in skus:
            return "second", sku, money(skus[sku])
    for sku in (f"cents_per_second_output_{resolution}", "cents_per_second_output"):
        if sku in skus:
            return "second", sku, money(skus[sku]) / 100
    for sku in (f"video_tokens_{resolution}", "video_tokens_without_audio", "video_tokens"):
        if sku in skus:
            return "token", sku, money(skus[sku])
    raise SeedanceError(f"{model.get('id')} has no price this tool understands")


def plan_clip(model: dict, resolution: str, seconds: int = SEEDANCE_SECONDS) -> dict:
    """Check the live catalogue offers what the loop trick needs and price one clip."""
    name = model.get("id", "?")
    if not {"first_frame", "last_frame"} <= set(model.get("supported_frame_images") or []):
        raise SeedanceError(f"{name} cannot take both a first and a last frame picture, so it cannot loop")
    if seconds not in (model.get("supported_durations") or []):
        raise SeedanceError(f"{name} does not offer {seconds}-second clips")
    if resolution not in (model.get("supported_resolutions") or []):
        offered = ", ".join(model.get("supported_resolutions") or []) or "none"
        raise SeedanceError(f"{name} does not offer {resolution} (it offers {offered})")
    if "3:4" not in (model.get("supported_aspect_ratios") or []):
        raise SeedanceError(f"{name} does not offer the 3:4 portrait shape")
    size = _portrait_size(model, resolution)
    kind, sku, rate = _price(model, resolution)
    if kind == "token":
        if not size:
            raise SeedanceError(f"{name} is priced per video token but lists no 3:4 size to count them")
        usd = video_tokens(size, seconds) * rate
    else:
        usd = rate * seconds
    return {"model": name, "canonical": model.get("canonical_slug", name), "resolution": resolution,
            "aspect": "3:4", "size": size, "seconds": seconds, "priceKind": kind, "priceSku": sku,
            "rate": str(rate), "usd": usd.quantize(Decimal("0.001")), "seed": bool(model.get("seed"))}


def check_model(model: dict, resolution: str, seconds: int = SEEDANCE_SECONDS) -> dict:
    return plan_clip(model, resolution, seconds)


def video_tokens(size: str, seconds: int = SEEDANCE_SECONDS, fps: int = SEEDANCE_FPS) -> Decimal:
    """Video tokens = width x height x frames per second x seconds / 1024.

    This matches the catalogue's headline for Seedance 2.5, "from $0.1028/second" at
    480x854 (480 * 854 * 24 / 1024 = 9607.5 tokens/s x $0.0000107 = $0.1028/s).
    """
    width, height = (int(part) for part in size.split("x"))
    return Decimal(width * height * fps * seconds) / Decimal(1024)


def estimate_usd(model: dict, resolution: str, seconds: int = SEEDANCE_SECONDS) -> Decimal:
    return plan_clip(model, resolution, seconds)["usd"]


# --- request, polling, download ------------------------------------------------------
def build_request(prompt: str, keyframe_png: bytes, plan: dict, seed: int) -> dict:
    if not keyframe_png.startswith(b"\x89PNG"):
        raise SeedanceError("The first-frame picture must be a PNG")
    if len(keyframe_png) > MAX_IMAGE_BYTES:
        raise SeedanceError("The first-frame picture is too large")
    url = "data:image/png;base64," + base64.b64encode(keyframe_png).decode("ascii")
    request = {
        "model": plan["model"], "prompt": prompt, "duration": plan["seconds"], "resolution": plan["resolution"],
        "aspect_ratio": plan["aspect"], "generate_audio": False,
        # The same picture as first AND last frame: the dance ends where it started, so it loops.
        "frame_images": [
            {"type": "image_url", "image_url": {"url": url}, "frame_type": "first_frame"},
            {"type": "image_url", "image_url": {"url": url}, "frame_type": "last_frame"},
        ],
    }
    if plan.get("size"):
        request["size"] = plan["size"]
    if plan.get("seed"):
        request["seed"] = int(seed) % (2 ** 31)
    return request


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
