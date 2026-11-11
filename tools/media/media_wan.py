"""Runs inside the cloud container: animate the character picture with Wan2.2 image-to-video (A14B).

The same picture is given as first and last frame (diffusers' `last_image`), so the
dance ends in the pose it started with and the clip loops. Weights are the
publisher's own diffusers release, pinned and checksum-verified once on download.
"""
from __future__ import annotations

import hashlib
import io
import json
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path("/wan")
SPEC = json.loads((Path(__file__).parent / "wan_files.json").read_text(encoding="utf-8-sig"))
REPO, REVISION = SPEC["repo"], SPEC["revision"]
FPS = 16                      # Wan2.2 A14B makes 16 frames per second
FRAMES = 81                   # 4n+1 frames: 5 seconds
STEPS = 40
GUIDANCE = 3.5


def snapshot() -> Path:
    return ROOT / "hf" / ("models--" + REPO.replace("/", "--")) / "snapshots" / REVISION


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(32 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def prepare_weights(commit) -> dict:
    from huggingface_hub import snapshot_download

    started = time.monotonic()
    folder = Path(snapshot_download(REPO, revision=REVISION, cache_dir=str(ROOT / "hf"), token=False,
                                    ignore_patterns=["assets/*", "examples/*", "*.md", ".gitattributes"],
                                    max_workers=8))
    commit()
    if folder.resolve() != snapshot().resolve():
        raise RuntimeError("Wan landed in an unexpected folder")
    downloaded = time.monotonic() - started

    def check(item):
        name, (size, sha) = item
        path = folder / name
        if path.stat().st_size != size or _sha256(path) != sha:
            raise RuntimeError(f"{REPO}/{name} does not match its pinned checksum")
        return name

    with ThreadPoolExecutor(max_workers=4) as pool:
        checked = list(pool.map(check, SPEC["files"].items()))
    report = {"repo": REPO, "revision": REVISION, "files": len(checked),
              "download_seconds": round(downloaded, 1), "total_seconds": round(time.monotonic() - started, 1)}
    (ROOT / "ready.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    commit()
    return report


def check_ready() -> None:
    ready = ROOT / "ready.json"
    if not ready.exists():
        raise RuntimeError("The Wan dance model is not downloaded yet")
    report = json.loads(ready.read_text(encoding="utf-8"))
    if (report.get("repo"), report.get("revision")) != (REPO, REVISION):
        raise RuntimeError("The downloaded Wan model is not the pinned version")
    for name, (size, _sha) in SPEC["files"].items():
        if (snapshot() / name).stat().st_size != size:
            raise RuntimeError(f"{name} changed since it was checked")


def animate(request: dict) -> dict:
    import numpy as np
    import torch
    from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
    from PIL import Image

    started = time.monotonic()
    check_ready()
    width, height = int(request["width"]), int(request["height"])
    if width % 16 or height % 16:
        raise ValueError("Wan needs a canvas divisible by 16")
    vae = AutoencoderKLWan.from_pretrained(str(snapshot()), subfolder="vae", torch_dtype=torch.float32)
    pipe = WanImageToVideoPipeline.from_pretrained(str(snapshot()), vae=vae, torch_dtype=torch.bfloat16)
    pipe.to("cuda")
    loaded = time.monotonic()
    picture = Image.open(io.BytesIO(request["keyframe"])).convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
    with torch.inference_mode():
        frames = pipe(image=picture, last_image=picture, prompt=request["prompt"],
                      negative_prompt=request["negative_prompt"], height=height, width=width,
                      num_frames=FRAMES, num_inference_steps=STEPS, guidance_scale=GUIDANCE,
                      guidance_scale_2=GUIDANCE, output_type="np",
                      generator=torch.Generator("cuda").manual_seed(int(request["seed"]))).frames[0]
    torch.cuda.synchronize()
    generated = time.monotonic()
    array = (np.clip(frames, 0, 1) * 255).round().astype(np.uint8)
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "motion.mkv"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                        "-s", f"{width}x{height}", "-r", str(FPS), "-i", "-", "-c:v", "ffv1", "-level", "3",
                        "-pix_fmt", "bgr0", str(output)], input=array.tobytes(), check=True, timeout=300)
        video = output.read_bytes()
    return {"video": video, "frames": int(len(array)), "fps": FPS, "gpu": torch.cuda.get_device_name(0),
            "peak_vram_bytes": int(torch.cuda.max_memory_reserved()),
            "timings": {"load": round(loaded - started, 1), "generate": round(generated - loaded, 1),
                        "total": round(time.monotonic() - started, 1)}}


def selftest() -> dict:
    import diffusers
    from diffusers import WanImageToVideoPipeline
    import inspect
    check_ready()
    config = json.loads((snapshot() / "model_index.json").read_text(encoding="utf-8"))
    if "last_image" not in inspect.signature(WanImageToVideoPipeline.__call__).parameters:
        raise RuntimeError("This diffusers version cannot take a last frame")
    return {"diffusers": diffusers.__version__, "boundary_ratio": config.get("boundary_ratio"),
            "transformers": [config.get("transformer"), config.get("transformer_2")]}
