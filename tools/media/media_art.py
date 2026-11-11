"""Runs inside the cloud container: draw the character (Z-Image-Turbo) and cut it out (BiRefNet).

Heavy imports happen inside functions so this file can be imported anywhere.
"""
from __future__ import annotations

import hashlib
import io
import json
import time
from pathlib import Path

from media_settings import (
    BIREFNET_FILES, BIREFNET_INPUT_SIZE, BIREFNET_REPO, BIREFNET_REVISION, EXPRESSION_STRENGTH,
    PICTURE_HEIGHT, PICTURE_WIDTH, ZIMAGE_FILES, ZIMAGE_IGNORE, ZIMAGE_REPO, ZIMAGE_REVISION, ZIMAGE_STEPS,
)

WEIGHTS_ROOT = Path("/weights")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(16 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _snapshot_dir(repo: str, revision: str) -> Path:
    return WEIGHTS_ROOT / "hf" / ("models--" + repo.replace("/", "--")) / "snapshots" / revision


def prepare_weights(commit) -> dict:
    """Download the pinned picture and cut-out models once and check every big file."""
    from huggingface_hub import snapshot_download

    started = time.monotonic()
    report = {"files": {}}
    for repo, revision, files, ignore in ((ZIMAGE_REPO, ZIMAGE_REVISION, ZIMAGE_FILES, ZIMAGE_IGNORE),
                                          (BIREFNET_REPO, BIREFNET_REVISION, BIREFNET_FILES, ["*.md"])):
        folder = Path(snapshot_download(repo, revision=revision, cache_dir=str(WEIGHTS_ROOT / "hf"),
                                        ignore_patterns=ignore, token=False))
        if folder.resolve() != _snapshot_dir(repo, revision).resolve():
            raise RuntimeError(f"{repo} landed in an unexpected folder")
        for name, (size, sha) in files.items():
            path = folder / name
            if path.stat().st_size != size or _sha256(path) != sha:
                raise RuntimeError(f"{repo}/{name} does not match its pinned checksum")
            report["files"][f"{repo}/{name}"] = {"size": size, "sha256": sha}
        commit()
    report.update({"zimage": [ZIMAGE_REPO, ZIMAGE_REVISION], "birefnet": [BIREFNET_REPO, BIREFNET_REVISION],
                   "seconds": round(time.monotonic() - started, 1)})
    (WEIGHTS_ROOT / "ready.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    commit()
    return report


def check_ready() -> dict:
    ready = WEIGHTS_ROOT / "ready.json"
    if not ready.exists():
        raise RuntimeError("The picture models are not downloaded yet")
    report = json.loads(ready.read_text(encoding="utf-8"))
    if report.get("zimage") != [ZIMAGE_REPO, ZIMAGE_REVISION] or report.get("birefnet") != [BIREFNET_REPO, BIREFNET_REVISION]:
        raise RuntimeError("The downloaded picture models are not the pinned versions")
    for repo, revision, files in ((ZIMAGE_REPO, ZIMAGE_REVISION, ZIMAGE_FILES),
                                  (BIREFNET_REPO, BIREFNET_REVISION, BIREFNET_FILES)):
        for name, (size, _sha) in files.items():
            if (_snapshot_dir(repo, revision) / name).stat().st_size != size:
                raise RuntimeError(f"{repo}/{name} changed since it was checked")
    return report


# --- cut-out model -------------------------------------------------------------
def load_birefnet(device: str):
    """Load BiRefNet from the pinned snapshot (its own published code, pinned with the weights)."""
    import torch
    from transformers import AutoModelForImageSegmentation

    model = AutoModelForImageSegmentation.from_pretrained(
        str(_snapshot_dir(BIREFNET_REPO, BIREFNET_REVISION)), trust_remote_code=True, local_files_only=True)
    model.eval().to(device)
    if device == "cuda":
        model.half()
    return model, torch


def matte_pictures(model, torch, pictures, device: str, batch: int = 4):
    """Return one float32 alpha array (H, W) in 0..1 per RGB PIL picture."""
    import numpy as np
    import torch.nn.functional as F

    mean = torch.tensor([0.485, 0.456, 0.406], device=device).view(1, 3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225], device=device).view(1, 3, 1, 1)
    dtype = torch.float16 if device == "cuda" else torch.float32
    results = []
    for start in range(0, len(pictures), batch):
        group = pictures[start:start + batch]
        size = group[0].size
        tensor = torch.stack([
            torch.from_numpy(np.asarray(p.convert("RGB").resize((BIREFNET_INPUT_SIZE, BIREFNET_INPUT_SIZE)),
                                        np.float32) / 255.0).permute(2, 0, 1) for p in group]).to(device)
        tensor = ((tensor - mean) / std).to(dtype)
        with torch.inference_mode():
            prediction = model(tensor)[-1].sigmoid().float()
        prediction = F.interpolate(prediction, size=(size[1], size[0]), mode="bilinear", align_corners=False)
        results.extend(prediction[:, 0].cpu().numpy().astype(np.float32))
    return results


def _png(image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _alpha_png(alpha) -> bytes:
    import numpy as np
    from PIL import Image
    return _png(Image.fromarray(np.clip(np.rint(alpha * 255), 0, 255).astype(np.uint8), "L"))


# --- drawing -----------------------------------------------------------------------
def draw(request: dict) -> dict:
    """Draw the character, optional expression variants, and cut each one out."""
    import torch
    from diffusers import ZImageImg2ImgPipeline, ZImagePipeline

    started = time.monotonic()
    check_ready()
    timings = {}
    pipe = ZImagePipeline.from_pretrained(str(_snapshot_dir(ZIMAGE_REPO, ZIMAGE_REVISION)),
                                          torch_dtype=torch.bfloat16, local_files_only=True).to("cuda")
    timings["load_picture_model"] = round(time.monotonic() - started, 1)
    seed = int(request["seed"])
    began = time.monotonic()
    restyle = ZImageImg2ImgPipeline(**pipe.components)
    if request.get("base"):
        # Re-dress an existing character: same person, pose and hat, new outfit.
        from PIL import Image
        base = Image.open(io.BytesIO(request["base"])).convert("RGB").resize((PICTURE_WIDTH, PICTURE_HEIGHT))
        picture = restyle(prompt=request["prompt"], image=base, strength=float(request.get("base_strength", 0.7)),
                          num_inference_steps=max(ZIMAGE_STEPS, 14), guidance_scale=0.0,
                          generator=torch.Generator("cuda").manual_seed(seed)).images[0]
    else:
        picture = pipe(prompt=request["prompt"], width=PICTURE_WIDTH, height=PICTURE_HEIGHT,
                       num_inference_steps=ZIMAGE_STEPS, guidance_scale=0.0,
                       generator=torch.Generator("cuda").manual_seed(seed)).images[0]
    expressions = {}
    if request.get("expressions"):
        for name, prompt in request["expressions"].items():
            expressions[name] = restyle(prompt=prompt, image=picture, strength=EXPRESSION_STRENGTH,
                                        num_inference_steps=max(ZIMAGE_STEPS, 14), guidance_scale=0.0,
                                        generator=torch.Generator("cuda").manual_seed(seed + 1)).images[0]
    timings["drawing"] = round(time.monotonic() - began, 1)
    del pipe
    torch.cuda.empty_cache()
    began = time.monotonic()
    model, _ = load_birefnet("cuda")
    pictures = [picture, *expressions.values()]
    alphas = matte_pictures(model, torch, pictures, "cuda", batch=1)
    timings["cutout"] = round(time.monotonic() - began, 1)
    out = {"picture": _png(picture), "alpha": _alpha_png(alphas[0]), "expressions": {}}
    for index, (name, image) in enumerate(expressions.items(), start=1):
        out["expressions"][name] = {"picture": _png(image), "alpha": _alpha_png(alphas[index])}
    timings["total"] = round(time.monotonic() - started, 1)
    out["timings"] = timings
    out["gpu"] = torch.cuda.get_device_name(0)
    return out


def matte_video(video: bytes) -> dict:
    """Cut the figure out of every frame of a lossless clip; returns alpha frames (uint8, compressed)."""
    import subprocess
    import tempfile
    import numpy as np
    import torch
    from PIL import Image

    started = time.monotonic()
    check_ready()
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "clip.mkv"
        source.write_bytes(video)
        info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json",
                                                   str(source)], timeout=60))["streams"][0]
        width, height = int(info["width"]), int(info["height"])
        raw = subprocess.check_output(["ffmpeg", "-nostdin", "-v", "error", "-i", str(source), "-f", "rawvideo",
                                       "-pix_fmt", "rgb24", "-"], timeout=300)
    frames = np.frombuffer(raw, np.uint8).reshape(-1, height, width, 3)
    model, _ = load_birefnet("cuda")
    loaded = time.monotonic()
    alphas = matte_pictures(model, torch, [Image.fromarray(frame) for frame in frames], "cuda", batch=4)
    stack = np.clip(np.rint(np.stack(alphas) * 255), 0, 255).astype(np.uint8)
    buffer = io.BytesIO()
    np.savez_compressed(buffer, alpha=stack)
    return {"alpha": buffer.getvalue(), "frames": int(len(frames)),
            "timings": {"load": round(loaded - started, 1), "cutout": round(time.monotonic() - loaded, 1),
                        "total": round(time.monotonic() - started, 1)},
            "gpu": torch.cuda.get_device_name(0)}


def selftest() -> dict:
    """CPU-only import and loading check (no drawing)."""
    import diffusers
    import transformers
    from diffusers import ZImageImg2ImgPipeline, ZImagePipeline  # noqa: F401
    from PIL import Image

    report = check_ready()
    model, torch = load_birefnet("cpu")
    alpha = matte_pictures(model, torch, [Image.new("RGB", (64, 96), (128, 128, 128))], "cpu")[0]
    return {"diffusers": diffusers.__version__, "transformers": transformers.__version__,
            "torch": str(torch.__version__), "birefnet_output_shape": list(alpha.shape),
            "weights_checked_seconds": report.get("seconds")}
