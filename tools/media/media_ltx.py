"""Runs inside the cloud container: animate the character picture with LTX-2.5.

The keyframe pipeline is given the same picture as its first and last frame,
so the dance ends in the pose it started with and the clip loops.
Weights come from a read-only, already verified cache; nothing is downloaded.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

from media_settings import FPS, LTX_CODE_REVISION, LTX_FILES, LTX_REPO, LTX_REVISION

CACHE_ROOT = Path("/ltx")
SOURCE = Path("/opt/ltx-2")


def model_paths() -> dict[str, str]:
    """Locate the pinned files and check them against the cache's own verification record."""
    ready = json.loads((CACHE_ROOT / "ready.json").read_text(encoding="utf-8"))
    if ready.get("repo_id") != LTX_REPO or ready.get("revision") != LTX_REVISION or ready.get("status") != "ready":
        raise RuntimeError("The motion model cache is not the pinned version")
    snapshot = CACHE_ROOT / "hf" / ("models--" + LTX_REPO.replace("/", "--")) / "snapshots" / LTX_REVISION
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
