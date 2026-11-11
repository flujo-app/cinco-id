"""Modal app for the media generator. Every function scales to zero, runs one
container at most, never retries and never keeps a warm container.

Used by generate.py through an ephemeral `app.run()`: the app exists only while a
generation is running and stops when it ends.
"""
from __future__ import annotations

import modal

from media_settings import (
    APP_NAME, ART_CPU, ART_GPU, ART_MEMORY_MIB, ART_PACKAGES, ART_TIMEOUT, ART_WEIGHTS_VOLUME,
    LTX_CACHE_VOLUME, LTX_CODE_REPOSITORY, LTX_CODE_REVISION, LTX_PACKAGES, MOTION_CPU, MOTION_GPU,
    MOTION_MEMORY_MIB, MOTION_TIMEOUT, PREPARE_CPU, PREPARE_MEMORY_MIB, PREPARE_TIMEOUT, TORCH_INDEX,
    TORCH_PACKAGES,
)

_ENV = {"PYTHONUNBUFFERED": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false",
        "HF_HUB_DOWNLOAD_TIMEOUT": "60", "HF_HUB_ETAG_TIMEOUT": "30",
        "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}

base_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0", "ca-certificates")
    .pip_install(*TORCH_PACKAGES, index_url=TORCH_INDEX)
)

art_image = (
    base_image
    .pip_install(*ART_PACKAGES)
    .env(_ENV)
    .add_local_python_source("media_settings", "media_art")
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
# Another project's verified LTX cache: read-only, never written.
ltx_cache = modal.Volume.from_name(LTX_CACHE_VOLUME).read_only()

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


@app.function(image=ltx_image, cpu=(PREPARE_CPU, PREPARE_CPU), memory=(PREPARE_MEMORY_MIB, PREPARE_MEMORY_MIB),
              volumes={"/ltx": ltx_cache}, timeout=300, **_ONE_SHOT)
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
              memory=(MOTION_MEMORY_MIB, MOTION_MEMORY_MIB), volumes={"/ltx": ltx_cache},
              timeout=MOTION_TIMEOUT, **_ONE_SHOT)
def animate(request: dict) -> dict:
    import media_ltx
    return media_ltx.animate(request)
