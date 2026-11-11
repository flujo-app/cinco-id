"""The output contract from docs/PROJECTS.md: building and checking media.json folders.

Needs NumPy, Pillow and ffprobe/ffmpeg. No GPU, no network.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

MAX_CLIP_BYTES = 4 * 1024 * 1024 + 256 * 1024   # "under about 4 MB"
_REVISION = re.compile(r"[0-9a-f]{40}\Z")
_EXPRESSION = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")


def build_media(*, width: int, height: int, fps: int, frames: int, expressions: list[str], hat_line: float,
                models: list[dict], prompts: dict, cost_usd: float, extra: dict | None = None) -> dict:
    stills = {"default": "still.png"}
    for name in expressions:
        stills[name] = f"{name}.png"
    provenance = {
        "created": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "models": models,
        "prompts": prompts,
        "costUsdEstimate": round(float(cost_usd), 2),
    }
    provenance.update(extra or {})
    return {
        "clip": "loop.webm",
        "width": width,
        "height": height,
        "fps": fps,
        "frames": frames,
        "stills": stills,
        "hatLine": round(float(hat_line), 3),
        "provenance": provenance,
    }


def write_media(folder: Path, media: dict) -> Path:
    path = Path(folder) / "media.json"
    path.write_text(json.dumps(media, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def validate_media_dict(media: dict) -> list[str]:
    """Problems with the media.json structure itself (empty list = fine)."""
    problems = []
    required = {"clip", "width", "height", "fps", "frames", "stills", "hatLine", "provenance"}
    missing = required - set(media)
    if missing:
        return [f"media.json is missing {sorted(missing)}"]
    if media["clip"] != "loop.webm":
        problems.append("clip must be loop.webm")
    for key in ("width", "height", "fps", "frames"):
        if type(media[key]) is not int or media[key] <= 0:
            problems.append(f"{key} must be a positive whole number")
    if not problems:
        if not 480 <= media["height"] <= 720:
            problems.append("height must be 480 to 720 pixels")
        if media["width"] >= media["height"]:
            problems.append("clip must be portrait")
        seconds = media["frames"] / media["fps"]
        if not 3.0 <= seconds <= 6.0:
            problems.append(f"loop must last 3 to 6 seconds, not {seconds:.2f}")
    stills = media["stills"]
    if not isinstance(stills, dict) or stills.get("default") != "still.png":
        problems.append("stills.default must be still.png")
    elif any(not _EXPRESSION.fullmatch(name) and name != "default" for name in stills):
        problems.append("expression names must be short lowercase words")
    if type(media["hatLine"]) not in (int, float) or not 0 < media["hatLine"] < 1:
        problems.append("hatLine must be between 0 and 1")
    provenance = media["provenance"]
    if not isinstance(provenance, dict):
        return problems + ["provenance must be an object"]
    for key in ("created", "models", "prompts", "costUsdEstimate"):
        if key not in provenance:
            problems.append(f"provenance.{key} is missing")
    for model in provenance.get("models", []):
        hosted = isinstance(model, dict) and "service" in model
        if hosted:
            if not model.get("model") or not model.get("version"):
                problems.append("a hosted model needs its model name and dated version")
        elif not isinstance(model, dict) or "/" not in str(model.get("repo", "")) or \
                not _REVISION.fullmatch(str(model.get("revision", ""))):
            problems.append("each model needs a publisher/model repo and a pinned 40-character revision")
    prompts = provenance.get("prompts", {})
    if not isinstance(prompts, dict) or not prompts.get("image") or not prompts.get("motion"):
        problems.append("provenance.prompts needs image and motion prompts")
    if type(provenance.get("costUsdEstimate")) not in (int, float) or provenance.get("costUsdEstimate", -1) < 0:
        problems.append("provenance.costUsdEstimate must be a number")
    return problems


def validate_folder(folder: Path, check_alpha: bool = True) -> list[str]:
    """Check a sequence (or variant) folder against the contract. Empty list = fine."""
    from media_finish import decode_webm_rgba, probe

    folder = Path(folder)
    path = folder / "media.json"
    if not path.exists():
        return ["media.json is missing"]
    media = json.loads(path.read_text(encoding="utf-8"))
    problems = validate_media_dict(media)
    if problems:
        return problems
    clip = folder / media["clip"]
    if not clip.exists():
        return problems + ["loop.webm is missing"]
    if clip.stat().st_size > MAX_CLIP_BYTES:
        problems.append("loop.webm is larger than about 4 MB")
    info = probe(clip)
    stream = info["streams"][0]
    tags = {key.lower(): value for key, value in stream.get("tags", {}).items()}
    if stream.get("codec_name") != "vp9":
        problems.append("loop.webm must be VP9")
    if tags.get("alpha_mode") != "1":
        problems.append("loop.webm has no alpha channel marker")
    if (int(stream["width"]), int(stream["height"])) != (media["width"], media["height"]):
        problems.append("loop.webm size differs from media.json")
    if int(stream.get("nb_read_frames", 0)) != media["frames"]:
        problems.append("loop.webm frame count differs from media.json")
    if check_alpha:
        frames = decode_webm_rgba(clip)
        alpha = frames[..., 3]
        if alpha.min() > 10:
            problems.append("loop.webm has no see-through pixels")
        if alpha.max() < 245:
            problems.append("loop.webm has no solid pixels")
        edge = np.concatenate([alpha[:, :2].ravel(), alpha[:, -2:].ravel(), alpha[:, :, :2].ravel(),
                               alpha[:, :, -2:].ravel()])
        if np.mean(edge > 128) > 0.01:
            problems.append("the figure touches the edge of the clip")
    for name, filename in media["stills"].items():
        still = folder / filename
        if not still.exists():
            problems.append(f"{filename} is missing")
            continue
        with Image.open(still) as image:
            if image.mode != "RGBA":
                problems.append(f"{filename} must be a see-through PNG")
                continue
            extrema = image.getchannel("A").getextrema()
            if extrema[0] > 10 or extrema[1] < 245:
                problems.append(f"{filename} has no proper see-through background")
    return problems
