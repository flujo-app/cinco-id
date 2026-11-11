"""Runs inside the cloud container: animate the character picture with LTX-2.5.

The keyframe pipeline is given the same picture as its first and last frame,
so the dance ends in the pose it started with and the clip loops.
Weights come from a verified volume mounted at /ltx: either the owner's existing cache
(read-only) or our own copy, which `prepare_weights` downloads from the publisher's own
Hugging Face account at the pinned revision and checks file by file against the pinned
SHA-256 checksums. Both use the same layout and the same ready.json record.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from media_settings import FPS, LTX_CODE_REVISION, LTX_FILES, LTX_REPO, LTX_REVISION

CACHE_ROOT = Path("/ltx")
SOURCE = Path("/opt/ltx-2")


def snapshot_dir() -> Path:
    return CACHE_ROOT / "hf" / ("models--" + LTX_REPO.replace("/", "--")) / "snapshots" / LTX_REVISION


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(64 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _missing_files() -> list[str]:
    missing = []
    for role, (filename, size, _sha) in LTX_FILES.items():
        path = snapshot_dir() / filename
        if not path.exists() or path.stat().st_size != size:
            missing.append(role)
    return missing


def access_problem(token: str | None) -> str | None:
    """None if Hugging Face lets this sign-in download LTX-2.5, else a short reason code."""
    from huggingface_hub import HfApi
    from huggingface_hub.errors import GatedRepoError, HfHubHTTPError, RepositoryNotFoundError
    try:
        HfApi().auth_check(LTX_REPO, token=token or False)
    except GatedRepoError:
        return "not-accepted" if token else "no-token"
    except RepositoryNotFoundError:
        return "bad-token" if token else "no-token"
    except HfHubHTTPError as error:
        status = getattr(getattr(error, "response", None), "status_code", None)
        if status in (401, 403):
            return "bad-token" if token else "no-token"
        raise RuntimeError(f"Hugging Face could not be reached (answer {status})") from None
    return None


def prepare_weights(commit) -> dict:
    """Get the six pinned LTX-2.5 files into our own volume and check every one.

    Files that are already complete are not downloaded again. The Hugging Face token, if
    the person stored one in Modal, arrives as HF_TOKEN and is never printed or returned.
    """
    started = time.monotonic()
    token = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip() or None
    missing = _missing_files()
    downloaded = False
    if missing:
        problem = access_problem(token)
        if problem:
            return {"status": "needs-sign-in", "problem": problem, "missing": missing}
        from huggingface_hub import snapshot_download
        folder = Path(snapshot_download(LTX_REPO, revision=LTX_REVISION, cache_dir=str(CACHE_ROOT / "hf"),
                                        allow_patterns=[filename for filename, _, _ in LTX_FILES.values()],
                                        token=token or False, max_workers=6))
        commit()
        if folder.resolve() != snapshot_dir().resolve():
            raise RuntimeError("LTX-2.5 landed in an unexpected folder")
        downloaded = True
    download_seconds = time.monotonic() - started

    def check(item):
        role, (filename, size, sha) = item
        path = snapshot_dir() / filename
        if path.stat().st_size != size or _sha256(path) != sha:
            target = path.resolve()
            for bad in {path, target}:
                bad.unlink(missing_ok=True)
            raise RuntimeError(f"{LTX_REPO}/{filename} did not match its published checksum and was removed; "
                               f"run --prepare again to download it once more")
        return role, {"filename": filename, "size": size, "sha256": sha}

    with ThreadPoolExecutor(max_workers=4) as pool:
        checked = dict(pool.map(check, LTX_FILES.items()))
    commit()
    record = {"status": "ready", "repo_id": LTX_REPO, "revision": LTX_REVISION, "files": checked,
              "downloaded_now": downloaded, "download_seconds": round(download_seconds, 1),
              "total_seconds": round(time.monotonic() - started, 1)}
    (CACHE_ROOT / "ready.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    commit()
    return {key: record[key] for key in ("status", "downloaded_now", "download_seconds", "total_seconds")} | {
        "files": len(checked)}


def model_paths() -> dict[str, str]:
    """Locate the pinned files and check them against the cache's own verification record."""
    ready = json.loads((CACHE_ROOT / "ready.json").read_text(encoding="utf-8"))
    if ready.get("repo_id") != LTX_REPO or ready.get("revision") != LTX_REVISION or ready.get("status") != "ready":
        raise RuntimeError("The motion model cache is not the pinned version")
    snapshot = snapshot_dir()
    paths = {}
    for role, (filename, size, sha) in LTX_FILES.items():
        record = ready["files"][role]
        if record["sha256"] != sha or record["size"] != size or record["filename"] != filename:
            raise RuntimeError(f"The cache record for {role} differs from the pin")
        path = snapshot / filename
        if path.stat().st_size != size:
            raise RuntimeError(f"The cached {role} file has the wrong size")
        paths[role] = str(path)
    return paths


def animate(request: dict) -> dict:
    import numpy as np
    import torch
    from dataclasses import replace
    from ltx_core.loader import LTXV_LORA_COMFY_RENAMING_MAP, LoraPathStrengthAndSDOps
    from ltx_core.model.video_vae import AUTO_TILING
    from ltx_pipelines.keyframe_interpolation import KeyframeInterpolationPipeline
    from ltx_pipelines.utils.args import ImageConditioningInput
    from ltx_pipelines.utils.constants import detect_params
    from ltx_pipelines.utils.model_paths import ModelPaths
    from ltx_pipelines.utils.quantization_factory import QuantizationKind
    from ltx_pipelines.utils.types import OffloadMode

    started = time.monotonic()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    if not torch.cuda.is_available():
        raise RuntimeError("No graphics card in the motion container")
    torch.cuda.reset_peak_memory_stats()
    paths = model_paths()
    settings = request["settings"]
    width, height, frames = request["width"], request["height"], request["num_frames"]
    if width % 64 or height % 64 or (frames - 1) % 8:
        raise ValueError("Canvas must be divisible by 64 and frame count must be 8n+1")
    tmp = Path(tempfile.mkdtemp())
    keyframe = tmp / "keyframe.png"
    keyframe.write_bytes(request["keyframe"])
    pipeline = KeyframeInterpolationPipeline(
        model_paths=ModelPaths.from_split(
            transformer_path=paths["transformer"], text_encoder_path=paths["text_encoder"],
            video_vae_path=paths["video_vae"], audio_vae_path=paths["audio_vae"]),
        distilled_lora=[LoraPathStrengthAndSDOps(paths["distilled_lora"], settings["distilled_lora_strength"],
                                                 LTXV_LORA_COMFY_RENAMING_MAP)],
        spatial_upsampler_path=paths["spatial_upsampler"], loras=[],
        quantization=QuantizationKind.FP8_CAST.to_policy(paths["transformer"])
        if settings["quantization"] == "fp8-cast" else None,
        offload_mode=OffloadMode(settings["offload"]),
    )
    params = detect_params(paths["transformer"])
    anchors = [ImageConditioningInput(str(keyframe), 0, 1.0, settings["image_crf"]),
               ImageConditioningInput(str(keyframe), frames - 1, 1.0, settings["image_crf"])]
    began = time.monotonic()
    output = tmp / "motion.mkv"
    encoder = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{width}x{height}", "-r", str(FPS), "-i", "-", "-c:v", "ffv1", "-level", "3",
         "-pix_fmt", "bgr0", str(output)], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    count = 0
    with torch.inference_mode():
        result = pipeline(
            prompt=request["prompt"], negative_prompt=request["negative_prompt"], seed=int(request["seed"]),
            height=height, width=width, num_frames=frames, frame_rate=float(FPS),
            num_inference_steps=settings["num_inference_steps"],
            video_guider_params=replace(params.video_guider_params, cfg_scale=settings["video_cfg"]),
            audio_guider_params=replace(params.audio_guider_params, cfg_scale=settings["audio_cfg"]),
            images=anchors, enhance_prompt=False, enhance_static_cache=False,
            tiling_config=AUTO_TILING, max_batch_size=1,
        )
        video = result.video
        chunks = [video] if isinstance(video, torch.Tensor) else video
        for chunk in chunks:
            array = (chunk.float().clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
            if array.ndim == 5:
                array = array[0]
            encoder.stdin.write(np.ascontiguousarray(array).tobytes())
            count += array.shape[0]
    encoder.stdin.close()
    error = encoder.stderr.read().decode(errors="replace")
    if encoder.wait() != 0:
        raise RuntimeError(f"Saving the motion frames failed: {error[:300]}")
    if count != frames:
        raise RuntimeError(f"The motion model returned {count} frames instead of {frames}")
    torch.cuda.synchronize()
    return {
        "video": output.read_bytes(), "frames": count,
        "timings": {"inference_and_decode": round(time.monotonic() - began, 1),
                    "total": round(time.monotonic() - started, 1)},
        "gpu": torch.cuda.get_device_name(0),
        "peak_vram_bytes": int(torch.cuda.max_memory_reserved()),
        "code_revision": LTX_CODE_REVISION,
    }


def selftest() -> dict:
    """CPU-only: imports, pinned source revision and cached file sizes. Loads no weights."""
    import inspect
    import torch
    import transformers
    from ltx_pipelines.keyframe_interpolation import KeyframeInterpolationPipeline

    revision = subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip()
    if revision != LTX_CODE_REVISION:
        raise RuntimeError("Unexpected motion model source revision")
    parameters = inspect.signature(KeyframeInterpolationPipeline.__call__).parameters
    if not {"images", "num_frames", "frame_rate", "video_guider_params"} <= parameters.keys():
        raise RuntimeError("The motion pipeline interface changed")
    paths = model_paths()
    return {"torch": str(torch.__version__), "transformers": transformers.__version__, "code_revision": revision,
            "files": {role: Path(path).name for role, path in paths.items()}}
