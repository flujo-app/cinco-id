"""Modal app for the media generator. Every function scales to zero, runs one
container at most, never retries and never keeps a warm container.

Used by generate.py through an ephemeral `app.run()`: the app exists only while a
generation is running and stops when it ends.
"""
from __future__ import annotations

import os
from pathlib import Path

import modal

from media_settings import (
    WAN_WEIGHTS_VOLUME, APP_NAME, ART_CPU, ART_GPU, ART_MEMORY_MIB, ART_PACKAGES, ART_TIMEOUT, ART_WEIGHTS_VOLUME,
    DOWNLOAD_CPU, DOWNLOAD_MEMORY_MIB, DOWNLOAD_TIMEOUT, LTX_CACHE_VOLUME, LTX_CODE_REPOSITORY,
    LTX_CODE_REVISION, LTX_PACKAGES, MOTION_CPU, MOTION_GPU, MOTION_MEMORY_MIB, MOTION_TIMEOUT, PREPARE_CPU,
    PREPARE_MEMORY_MIB, PREPARE_TIMEOUT, TORCH_INDEX, TORCH_PACKAGES,
)

# Where LTX-2.5 lives on this account. generate.py decides it (see media_route.py) before it
# imports this file: the owner's verified cache (read-only) or our own volume. The same three
# values are given to the LTX machines through `env`, so the cloud side describes the very
# same storage and secret (Modal requires both sides to match).
LTX_VOLUME_NAME = os.environ.get("MEDIA_CLOUD_LTX_VOLUME") or LTX_CACHE_VOLUME
LTX_READ_ONLY = os.environ.get("MEDIA_CLOUD_LTX_READ_ONLY", "1") == "1"
HF_SECRET = os.environ.get("MEDIA_CLOUD_HF_SECRET") or "none"
_LTX_ENV = {"MEDIA_CLOUD_LTX_VOLUME": LTX_VOLUME_NAME, "MEDIA_CLOUD_LTX_READ_ONLY": "1" if LTX_READ_ONLY else "0",
            "MEDIA_CLOUD_HF_SECRET": HF_SECRET}

_ENV = {"PYTHONUNBUFFERED": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false",
        "HF_HUB_DOWNLOAD_TIMEOUT": "60", "HF_HUB_ETAG_TIMEOUT": "30",
        "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}

base_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0", "ca-certificates")
    .pip_install(*TORCH_PACKAGES, index_url=TORCH_INDEX)
)

art_base = base_image.pip_install(*ART_PACKAGES).env(_ENV)
art_image = art_base.add_local_python_source("media_settings", "media_art")

# Wan2.2 uses the same picture-tool software plus one text-cleaning package.
wan_image = (
    art_base
    .pip_install("ftfy==6.3.1")
    .add_local_python_source("media_settings", "media_wan")
    .add_local_file(str(Path(__file__).with_name("wan_files.json")), "/root/wan_files.json")
)

ltx_image = (
    base_image
    .pip_install(*LTX_PACKAGES)
    .run_commands(
        "git init /opt/ltx-2",
        f"git -C /opt/ltx-2 remote add origin {LTX_CODE_REPOSITORY}",
        f"git -C /opt/ltx-2 fetch --depth 1 origin {LTX_CODE_REVISION}",
        "git -C /opt/ltx-2 checkout --detach FETCH_HEAD",
        f'test "$(git -C /opt/ltx-2 rev-parse HEAD)" = "{LTX_CODE_REVISION}"',
        # Skip upstream's unpinned resolver and optional compiled kernels (as in the known-good worker).
        "pip install --no-cache-dir --no-deps --no-build-isolation /opt/ltx-2/packages/ltx-core /opt/ltx-2/packages/ltx-pipelines",
    )
    .env(_ENV)
    .add_local_python_source("media_settings", "media_ltx")
)

app = modal.App(APP_NAME)
art_weights = modal.Volume.from_name(ART_WEIGHTS_VOLUME, create_if_missing=True)
wan_weights = modal.Volume.from_name(WAN_WEIGHTS_VOLUME, create_if_missing=True)
if LTX_READ_ONLY:
    # Another project's verified LTX cache: read-only, never written.
    ltx_volume = modal.Volume.from_name(LTX_VOLUME_NAME).read_only()
else:
    # Our own copy, filled once by prepare_ltx_weights.
    ltx_volume = modal.Volume.from_name(LTX_VOLUME_NAME, create_if_missing=True)
# A Hugging Face read token (HF_TOKEN) for the download, only when the person stored one in Modal.
_HF_SECRETS = [] if HF_SECRET == "none" else [modal.Secret.from_name(HF_SECRET)]

_ONE_SHOT = dict(min_containers=0, max_containers=1, buffer_containers=0, scaledown_window=2,
                 retries=0, single_use_containers=True)


@app.function(image=art_image, cpu=(PREPARE_CPU, PREPARE_CPU), memory=(PREPARE_MEMORY_MIB, PREPARE_MEMORY_MIB),
              volumes={"/weights": art_weights}, timeout=PREPARE_TIMEOUT, **_ONE_SHOT)
def prepare_art_weights() -> dict:
    import media_art
    return media_art.prepare_weights(art_weights.commit)


@app.function(image=art_image, cpu=(PREPARE_CPU, PREPARE_CPU), memory=(PREPARE_MEMORY_MIB, PREPARE_MEMORY_MIB),
              volumes={"/weights": art_weights}, timeout=300, **_ONE_SHOT)
def selftest_art() -> dict:
    import media_art
    return media_art.selftest()


@app.function(image=ltx_image, cpu=(DOWNLOAD_CPU, DOWNLOAD_CPU), memory=(DOWNLOAD_MEMORY_MIB, DOWNLOAD_MEMORY_MIB),
              volumes={"/ltx": ltx_volume}, secrets=_HF_SECRETS, env=_LTX_ENV, timeout=DOWNLOAD_TIMEOUT,
              **_ONE_SHOT)
def prepare_ltx_weights() -> dict:
    """Download (if needed) and check LTX-2.5 into our own volume. Never used with the read-only cache."""
    if LTX_READ_ONLY:
        raise RuntimeError("The LTX storage is read-only here; nothing to prepare")
    import media_ltx
    return media_ltx.prepare_weights(ltx_volume.commit)


@app.function(image=ltx_image, cpu=(PREPARE_CPU, PREPARE_CPU), memory=(PREPARE_MEMORY_MIB, PREPARE_MEMORY_MIB),
              volumes={"/ltx": ltx_volume}, env=_LTX_ENV, timeout=300, **_ONE_SHOT)
def selftest_motion() -> dict:
    import media_ltx
    return media_ltx.selftest()


@app.function(image=art_image, gpu=ART_GPU, cpu=(ART_CPU, ART_CPU), memory=(ART_MEMORY_MIB, ART_MEMORY_MIB),
              volumes={"/weights": art_weights}, timeout=ART_TIMEOUT, **_ONE_SHOT)
def draw(request: dict) -> dict:
    import media_art
    return media_art.draw(request)


@app.function(image=art_image, gpu=ART_GPU, cpu=(ART_CPU, ART_CPU), memory=(ART_MEMORY_MIB, ART_MEMORY_MIB),
              volumes={"/weights": art_weights}, timeout=ART_TIMEOUT, **_ONE_SHOT)
def cut_out(video: bytes) -> dict:
    import media_art
    return media_art.matte_video(video)


@app.function(image=ltx_image, gpu=MOTION_GPU, cpu=(MOTION_CPU, MOTION_CPU),
              memory=(MOTION_MEMORY_MIB, MOTION_MEMORY_MIB), volumes={"/ltx": ltx_volume}, env=_LTX_ENV,
              timeout=MOTION_TIMEOUT, **_ONE_SHOT)
def animate(request: dict) -> dict:
    import media_ltx
    return media_ltx.animate(request)


@app.function(image=wan_image, cpu=(DOWNLOAD_CPU, DOWNLOAD_CPU), memory=(DOWNLOAD_MEMORY_MIB, DOWNLOAD_MEMORY_MIB),
              volumes={"/wan": wan_weights}, timeout=DOWNLOAD_TIMEOUT, **_ONE_SHOT)
def prepare_wan_weights() -> dict:
    import media_wan
    return media_wan.prepare_weights(wan_weights.commit)


@app.function(image=wan_image, cpu=(PREPARE_CPU, PREPARE_CPU), memory=(PREPARE_MEMORY_MIB, PREPARE_MEMORY_MIB),
              volumes={"/wan": wan_weights}, timeout=300, **_ONE_SHOT)
def selftest_wan() -> dict:
    import media_wan
    return media_wan.selftest()


@app.function(image=wan_image, gpu=MOTION_GPU, cpu=(MOTION_CPU, MOTION_CPU),
              memory=(MOTION_MEMORY_MIB, MOTION_MEMORY_MIB), volumes={"/wan": wan_weights},
              timeout=MOTION_TIMEOUT, **_ONE_SHOT)
def animate_wan(request: dict) -> dict:
    import media_wan
    return media_wan.animate(request)
