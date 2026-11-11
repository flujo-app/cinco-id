"""Runs inside the cloud container: animate the character picture with MiniMax H3 (FL2VA).

The official SGLang server runs on one H200 inside the same container, is given the same
picture as its first and its last frame, makes one clip, and is stopped again. The weights
are the publisher's own FL2VA files at the pinned revision, from a volume mounted at /h3:
either the owner's existing copy (read-only) or our own copy made by `prepare_weights`.
Every file is checked against the pinned list in h3_files.json.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC_PATH = HERE / "h3_files.json" if (HERE / "h3_files.json").exists() else Path("/root/h3_files.json")
MOUNT = Path("/h3")
PORT = 30010


def spec() -> dict:
    return json.loads(SPEC_PATH.read_text(encoding="utf-8"))


def files_root() -> Path:
    """The FL2VA folder inside the mounted volume (its first folder level is the revision it was made at)."""
    return MOUNT / os.environ.get("MEDIA_CLOUD_H3_ROOT", spec()["revision"]) / spec()["folder"]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(64 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _git_blob(path: Path) -> str:
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def check_sizes(root: Path | None = None) -> list[str]:
    """Names of pinned files that are missing or have the wrong size (fast)."""
    root = root or files_root()
    wrong = []
    for name, (size, _digest) in spec()["files"].items():
        path = root / name
        if not path.is_file() or path.stat().st_size != size:
            wrong.append(name)
    return wrong


def check_records(root: Path | None = None) -> list[str]:
    """Weight files whose own download record (written by Hugging Face's tool) names another checksum."""
    root = root or files_root()
    records = root.parent / ".cache" / "huggingface" / "download" / spec()["folder"]
    wrong = []
    for name, (_size, digest) in spec()["files"].items():
        kind, expected = digest.split(":", 1)
        record = records / f"{name}.metadata"
        if kind == "sha256" and record.is_file():
            lines = record.read_text(encoding="utf-8").splitlines()
            if len(lines) < 2 or lines[1].strip() != expected:
                wrong.append(name)
    return wrong


def check_full(root: Path | None = None) -> dict:
    """Check every pinned file's checksum (SHA-256 for the weights, git's id for the small files)."""
    root = root or files_root()
    started = time.monotonic()

    def check(item):
        name, (size, digest) = item
        path = root / name
        kind, expected = digest.split(":", 1)
        if not path.is_file() or path.stat().st_size != size:
            return name
        actual = _sha256(path) if kind == "sha256" else _git_blob(path)
        return None if actual == expected else name

    with ThreadPoolExecutor(max_workers=8) as pool:
        bad = [name for name in pool.map(check, spec()["files"].items()) if name]
    return {"files": len(spec()["files"]), "bad": bad, "seconds": round(time.monotonic() - started, 1)}


def check_copy() -> dict:
    """--prepare on a read-only copy: full checksum check, nothing is written."""
    report = check_full()
    report["bad"] = sorted(set(report["bad"]) | set(check_records()))
    report["ffmpeg"] = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
    report["sglang"] = bool(shutil.which("sglang"))
    return report


def prepare_weights(commit) -> dict:
    """Download the pinned FL2VA folder into our own volume (only what is missing), then check it."""
    from huggingface_hub import snapshot_download

    data = spec()
    started = time.monotonic()
    downloaded = False
    if check_sizes():
        snapshot_download(data["repo"], revision=data["revision"], local_dir=str(MOUNT / data["revision"]),
                          allow_patterns=[f"{data['folder']}/*", "model_index.json"], token=False, max_workers=8)
        commit()
        downloaded = True
    download_seconds = time.monotonic() - started
    report = check_full()
    if report["bad"]:
        for name in report["bad"]:
            (files_root() / name).unlink(missing_ok=True)
        commit()
        raise RuntimeError(f"{len(report['bad'])} MiniMax H3 files did not match their published checksums and "
                           f"were removed; run --prepare --engine h3 again")
    record = {"status": "ready", "repo": data["repo"], "revision": data["revision"], "folder": data["folder"],
              "files": report["files"], "downloaded_now": downloaded, "download_seconds": round(download_seconds, 1),
              "check_seconds": report["seconds"]}
    (MOUNT / "ready.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    commit()
    return record


# --- the dance ------------------------------------------------------------------------
def _get(url: str, timeout: float = 30) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def _post_json(url: str, payload: dict, timeout: float = 120) -> dict:
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"The H3 server refused the request ({error.code}): "
                           f"{error.read().decode(errors='replace')[:1500]}") from None


def _tail(path: Path, size: int = 4000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[-size:]
    except OSError:
        return ""


def animate(request: dict) -> dict:
    """Start the server, make one first-and-last-frame clip, stop the server. Returns an mp4."""
    started = time.monotonic()
    wrong = check_sizes() + check_records()
    if wrong:
        raise RuntimeError(f"The MiniMax H3 files are not complete ({len(wrong)} differ from the pin)")
    work = Path(tempfile.mkdtemp(prefix="h3-"))
    view = work / "minimax-h3"                   # the name lets SGLang recognise the model
    view.mkdir()
    (view / spec()["folder"]).symlink_to(files_root(), target_is_directory=True)
    shutil.copyfile(files_root() / "model_index.json", view / "model_index.json")
    keyframe = work / "keyframe.png"
    keyframe.write_bytes(request["keyframe"])
    log_path = work / "server.log"
    settings = request["settings"]
    command = ["sglang", "serve", "--model-path", str(view), "--model-variant", "fl2va", "--num-gpus", "1",
               "--host", "127.0.0.1", "--port", str(PORT), "--output-path", str(work / "out")]
    environment = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                       PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True")
    base = f"http://127.0.0.1:{PORT}"
    timings = {}
    with log_path.open("w", encoding="utf-8") as log:
        server = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=environment)
        try:
            deadline = time.monotonic() + request.get("load_timeout", 600)
            while True:
                if server.poll() is not None:
                    raise RuntimeError("The H3 server stopped while loading:\n" + _tail(log_path))
                if time.monotonic() > deadline:
                    raise RuntimeError("The H3 server did not finish loading in time:\n" + _tail(log_path))
                try:
                    if _get(base + "/health", timeout=5)[0] == 200:
                        break
                except OSError:
                    pass
                time.sleep(3)
            timings["load"] = round(time.monotonic() - started, 1)
            seconds = settings["duration_seconds"]
            job = _post_json(base + "/v1/videos", {
                "task": "fl2va", "prompt": request["prompt"],
                "conditions": [
                    {"type": "image", "uri": f"file://{keyframe}", "role": "keyframe", "frame_index": 0},
                    {"type": "image", "uri": f"file://{keyframe}", "role": "keyframe", "frame_index": -1},
                ],
                "target": {"short_edge": settings["short_edge"], "aspect_ratio": settings["aspect_ratio"],
                           "duration_seconds": seconds},
                "seconds": int(seconds), "seed": int(request["seed"]),
                "num_inference_steps": settings["num_inference_steps"],
            })
            began = time.monotonic()
            deadline = began + request.get("generate_timeout", 600)
            status = job
            while status.get("status") not in ("completed", "failed"):
                if server.poll() is not None:
                    raise RuntimeError("The H3 server stopped while making the clip:\n" + _tail(log_path))
                if time.monotonic() > deadline:
                    raise RuntimeError("The H3 clip was not ready in time:\n" + _tail(log_path))
                time.sleep(5)
                code, body = _get(f"{base}/v1/videos/{job['id']}")
                if code == 200:
                    status = json.loads(body)
            if status.get("status") != "completed":
                raise RuntimeError(f"The H3 clip failed: {json.dumps(status)[:1500]}\n" + _tail(log_path))
            timings["generate"] = round(time.monotonic() - began, 1)
            code, video = _get(f"{base}/v1/videos/{job['id']}/content", timeout=120)
            if code != 200 or not video:
                raise RuntimeError(f"The H3 clip could not be fetched ({code})")
            gpu = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used", "--format=csv,noheader"],
                                 capture_output=True, text=True).stdout.strip()
        finally:
            server.terminate()
            try:
                server.wait(timeout=30)
            except subprocess.TimeoutExpired:
                server.kill()
    clip = work / "clip.mp4"
    clip.write_bytes(video)
    probe = json.loads(subprocess.check_output(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,nb_read_frames,avg_frame_rate,codec_name", "-of", "json", str(clip)], timeout=120))
    # Like the other dance models: picture only (the model also makes sound), lossless, for the cut-out.
    lossless = work / "motion.mkv"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(clip), "-map", "0:v:0", "-an",
                    "-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgr0", str(lossless)], check=True, timeout=300)
    timings["total"] = round(time.monotonic() - started, 1)
    return {"video": lossless.read_bytes(), "original_mp4": video, "stream": probe["streams"][0],
            "timings": timings, "gpu": gpu, "log_tail": _tail(log_path, 2500)}
