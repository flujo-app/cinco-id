"""Modal app for the optional MiniMax H3 dance model. Kept apart from media_cloud.py, so the
normal routes never touch H3 storage. Same habits: scale to zero, one machine at most, no
retries, no warm machine; generate.py only uses it inside an ephemeral `app.run()`.

Which storage holds the H3 files is decided by generate.py (see media_route.py) before this
file is imported, and handed to the cloud machines through `env`, so both sides describe the
same storage.
"""
from __future__ import annotations

import os
from pathlib import Path

import modal

from media_settings import (
    APP_NAME, H3_CPU, H3_GPU, H3_MEMORY_MIB, H3_REVISION, H3_TIMEOUT, H3_WEIGHTS_VOLUME, SGLANG_IMAGE,
)

H3_VOLUME_NAME = os.environ.get("MEDIA_CLOUD_H3_VOLUME") or H3_WEIGHTS_VOLUME
H3_READ_ONLY = os.environ.get("MEDIA_CLOUD_H3_READ_ONLY", "0") == "1"
H3_ROOT = os.environ.get("MEDIA_CLOUD_H3_ROOT") or H3_REVISION
_H3_ENV = {"MEDIA_CLOUD_H3_VOLUME": H3_VOLUME_NAME, "MEDIA_CLOUD_H3_READ_ONLY": "1" if H3_READ_ONLY else "0",
           "MEDIA_CLOUD_H3_ROOT": H3_ROOT}

h3_image = (
    modal.Image.from_registry(SGLANG_IMAGE)
    .entrypoint([])
    .env({"PYTHONUNBUFFERED": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "SGLANG_DISABLE_USAGE_STATS": "1"})
    .add_local_python_source("media_settings", "media_h3")
    .add_local_file(str(Path(__file__).with_name("h3_files.json")), "/root/h3_files.json")
)

app = modal.App(f"{APP_NAME}-h3")
if H3_READ_ONLY:
    h3_volume = modal.Volume.from_name(H3_VOLUME_NAME).read_only()      # another project's copy: never written
else:
    h3_volume = modal.Volume.from_name(H3_VOLUME_NAME, create_if_missing=True)

_ONE_SHOT = dict(min_containers=0, max_containers=1, buffer_containers=0, scaledown_window=2,
                 retries=0, single_use_containers=True)


@app.function(image=h3_image, cpu=(8, 8), memory=(16384, 16384), volumes={"/h3": h3_volume}, env=_H3_ENV,
              timeout=3600, **_ONE_SHOT)
def prepare_h3_weights() -> dict:
    """Read-only copy: check every checksum. Our own volume: download what is missing, then check."""
    import media_h3
    if H3_READ_ONLY:
        return media_h3.check_copy()
    return media_h3.prepare_weights(h3_volume.commit)


@app.function(image=h3_image, gpu=H3_GPU, cpu=(H3_CPU, H3_CPU), memory=(H3_MEMORY_MIB, H3_MEMORY_MIB),
              volumes={"/h3": h3_volume}, env=_H3_ENV, timeout=H3_TIMEOUT, **_ONE_SHOT)
def animate_h3(request: dict) -> dict:
    import media_h3
    return media_h3.animate(request)
