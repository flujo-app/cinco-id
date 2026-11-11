"""Modal app for the disco music: ACE-Step 1.5 XL Turbo makes the candidates on one cloud graphics
card, and the same machine measures each one (tempo and beats, loudness peaks, silences, bass and
treble, how much singing a separation model hears).

Same habits as media_cloud.py: every function scales to zero, runs one machine at most, never
retries and never keeps a warm machine. make_music.py only uses it inside an ephemeral
`app.run()`, so the app exists only while a run is going and stops when it ends.

The weights are the publisher's own Diffusers release, pinned to one revision in music.json and
checked against their checksums once, when they are downloaded into our own Modal storage.
"""
from __future__ import annotations

import hashlib
import io
import json
import time
from pathlib import Path

import modal

from media_settings import APP_NAME, PREPARE_CPU, PREPARE_MEMORY_MIB, TORCH_INDEX, TORCH_PACKAGES

RECIPE_FILE = Path(__file__).with_name("music.json")
RECIPE = json.loads(RECIPE_FILE.read_text(encoding="utf-8")) if RECIPE_FILE.exists() else \
    json.loads((Path("/root") / "music.json").read_text(encoding="utf-8"))
MODEL = RECIPE["model"]
CHECK = RECIPE["vocalCheck"]

MUSIC_WEIGHTS_VOLUME = "beta-sequence-music-weights"   # ours: ACE-Step + the singing check
MUSIC_GPU = "L40S"                                      # 48 GB: the 11 GB model fits easily
MUSIC_CPU = 4
MUSIC_MEMORY_MIB = 32768
MUSIC_TIMEOUT = 1200                                    # the limit also caps the cost
PREPARE_TIMEOUT = 1800
MUSIC_PACKAGES = (
    "diffusers==0.42.1", "transformers==5.22.2", "accelerate==1.15.0", "safetensors==0.8.0",
    "huggingface-hub==1.32.0", "numpy==2.2.6", "scipy==1.17.0", "soundfile==0.13.1",
    "librosa==0.11.0", "numba==0.62.1", "llvmlite==0.45.1", "demucs==4.0.1",
)

ROOT = Path("/music")

_ENV = {"PYTHONUNBUFFERED": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false",
        "HF_HUB_DOWNLOAD_TIMEOUT": "60", "HF_HUB_ETAG_TIMEOUT": "30", "TORCH_HOME": "/music/torch",
        "NUMBA_CACHE_DIR": "/tmp/numba", "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}

music_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libsndfile1", "ca-certificates")
    .pip_install(*TORCH_PACKAGES, index_url=TORCH_INDEX)
    .pip_install(*MUSIC_PACKAGES)
    .env(_ENV)
    .add_local_file(str(RECIPE_FILE), "/root/music.json")
    .add_local_python_source("media_settings", "media_music")
)

app = modal.App(f"{APP_NAME}-music")
music_weights = modal.Volume.from_name(MUSIC_WEIGHTS_VOLUME, create_if_missing=True)

_ONE_SHOT = dict(min_containers=0, max_containers=1, buffer_containers=0, scaledown_window=2,
                 retries=0, single_use_containers=True)


# --- storage --------------------------------------------------------------------------------
def snapshot() -> Path:
    return ROOT / "hf" / ("models--" + MODEL["repo"].replace("/", "--")) / "snapshots" / MODEL["revision"]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(32 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _ready() -> dict | None:
    marker = ROOT / "ready.json"
    if not marker.exists():
        return None
    report = json.loads(marker.read_text(encoding="utf-8"))
    if report.get("repo") != MODEL["repo"] or report.get("revision") != MODEL["revision"]:
        return None
    for name, (size, _sha) in MODEL["files"].items():
        path = snapshot() / name
        if not path.exists() or path.stat().st_size != size:
            return None
    if not Path(report.get("vocalCheckFile", "/missing")).exists():
        return None
    return report


def _vocal_model():
    from demucs.pretrained import get_model
    return get_model("htdemucs")      # the publisher's file; torch checks the hash in its name


def prepare_weights(commit) -> dict:
    """Download the pinned music model and the singing check once and check every big file."""
    report = _ready()
    if report:
        return {**report, "alreadyThere": True}
    from huggingface_hub import snapshot_download

    started = time.monotonic()
    folder = Path(snapshot_download(MODEL["repo"], revision=MODEL["revision"], cache_dir=str(ROOT / "hf"),
                                    token=False, ignore_patterns=["*.md", ".gitattributes"], max_workers=8))
    commit()
    if folder.resolve() != snapshot().resolve():
        raise RuntimeError("The music model landed in an unexpected folder")
    for name, (size, sha) in MODEL["files"].items():
        path = folder / name
        if path.stat().st_size != size or _sha256(path) != sha:
            raise RuntimeError(f"{MODEL['repo']}/{name} does not match its pinned checksum")
    _vocal_model()
    check_files = sorted((ROOT / "torch").rglob("*.th"))
    check_file = next(path for path in check_files if CHECK["sha256Prefix"] in path.name)
    check_sha = _sha256(check_file)
    if not check_sha.startswith(CHECK["sha256Prefix"]):
        raise RuntimeError("The singing-check model does not match its published checksum")
    total = sum(path.stat().st_size for path in ROOT.rglob("*") if path.is_file() and not path.is_symlink())
    report = {"repo": MODEL["repo"], "revision": MODEL["revision"], "files": len(MODEL["files"]),
              "vocalCheckFile": str(check_file), "vocalCheckSha256": check_sha, "bytes": total,
              "seconds": round(time.monotonic() - started, 1)}
    (ROOT / "ready.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    commit()
    return report


# --- measuring ------------------------------------------------------------------------------
def measure(audio, sr: int, bpm: float, vocal_model=None) -> dict:
    """Plain numbers about one candidate. `audio` is float32 (channels, samples)."""
    import librosa
    import numpy as np
    from scipy.signal import welch

    mono = audio.mean(axis=0)
    peak = float(np.abs(audio).max())
    near_full = np.abs(audio) >= 0.999
    clipped_runs = int(np.count_nonzero(near_full[:, 1:] & near_full[:, :-1]))

    hop = sr // 10                                              # 0.1 s steps
    frames = len(mono) // hop
    rms = np.sqrt(np.mean(mono[:frames * hop].reshape(frames, hop) ** 2, axis=1) + 1e-12)
    rms_db = 20 * np.log10(rms)
    quiet = rms_db < -45
    longest_quiet = 0
    run = 0
    for flag in quiet:
        run = run + 1 if flag else 0
        longest_quiet = max(longest_quiet, run)

    freqs, power = welch(mono, fs=sr, nperseg=8192)
    total = float(power.sum()) + 1e-20
    bands = {"bass": (20, 120), "low_mid": (120, 500), "mid": (500, 2000), "high_mid": (2000, 6000),
             "top": (6000, 16000), "air": (16000, 24000)}
    share = {name: round(float(power[(freqs >= lo) & (freqs < hi)].sum()) / total, 5) for name, (lo, hi) in bands.items()}

    hop_length = 512
    envelope = librosa.onset.onset_strength(y=mono, sr=sr, hop_length=hop_length)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=envelope, sr=sr, hop_length=hop_length,
                                                 start_bpm=bpm, units="frames")
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)
    report = {"seconds": round(len(mono) / sr, 3), "peak": round(peak, 4), "clippedSamples": clipped_runs,
              "longestQuietSeconds": round(longest_quiet * 0.1, 1), "spectrum": share,
              "librosaTempo": round(float(np.atleast_1d(tempo)[0]), 2), "beats": [round(float(t), 4) for t in beats]}
    if len(beats) >= 16:
        index = np.arange(len(beats))
        period, start = np.polyfit(index, beats, 1)
        residual = beats - (start + period * index)
        on_beat = envelope[np.clip(beat_frames, 0, len(envelope) - 1)]
        report.update({"tempo": round(60.0 / period, 3), "beatJitterMs": round(float(np.std(residual)) * 1000, 1),
                       "beatStrength": round(float(on_beat.mean() / (envelope.mean() + 1e-9)), 3)})
    if vocal_model is not None:
        report.update(vocal_share(audio, sr, vocal_model))
    return report


def vocal_share(audio, sr: int, model) -> dict:
    """How much of the sound the separation model puts in its 'vocals' part (0 = none)."""
    import numpy as np
    import torch
    import torchaudio.functional as AF
    from demucs.apply import apply_model

    wav = torch.from_numpy(audio).float()
    wav = AF.resample(wav, sr, model.samplerate)
    reference = wav.mean(0)
    wav = (wav - reference.mean()) / (reference.std() + 1e-8)
    with torch.inference_mode():
        sources = apply_model(model, wav[None].cuda(), device="cuda", split=True, overlap=0.25, progress=False)[0]
    sources = sources.float().cpu().numpy()
    vocals = sources[model.sources.index("vocals")]
    mix = sources.sum(axis=0)
    window = model.samplerate * 2
    count = vocals.shape[1] // window
    ratios = []
    for part in range(count):
        part_v = vocals[:, part * window:(part + 1) * window]
        part_m = mix[:, part * window:(part + 1) * window]
        ratios.append(float((part_v ** 2).sum() / ((part_m ** 2).sum() + 1e-9)))
    return {"vocalShare": round(float((vocals ** 2).sum() / ((mix ** 2).sum() + 1e-9)), 4),
            "vocalShareWorst2s": round(max(ratios) if ratios else 0.0, 4)}


def _flac(audio, sr: int) -> bytes:
    import soundfile
    buffer = io.BytesIO()
    soundfile.write(buffer, audio.T, sr, format="FLAC", subtype="PCM_24")
    return buffer.getvalue()


# --- making music -------------------------------------------------------------------------------
def compose(request: dict) -> dict:
    """Make every candidate in `request["jobs"]` and measure it."""
    import numpy as np
    import torch
    from diffusers import AceStepPipeline

    started = time.monotonic()
    if not _ready():
        raise RuntimeError("The music model is not downloaded yet")
    settings = request["music"]
    pipe = AceStepPipeline.from_pretrained(str(snapshot()), torch_dtype=torch.bfloat16, local_files_only=True).to("cuda")
    if hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
    vocal_model = None
    vocal_error = None
    try:
        vocal_model = _vocal_model().cuda().eval()
    except Exception as error:  # noqa: BLE001 - the singing check is a help, not a must
        vocal_error = f"{type(error).__name__}: {error}"[:300]
    timings = {"load": round(time.monotonic() - started, 1)}
    results = []
    for job in request["jobs"]:
        began = time.monotonic()
        output = pipe(prompt=job["prompt"], lyrics=settings["lyrics"], vocal_language=settings["language"],
                      audio_duration=float(job.get("seconds", settings["seconds"])),
                      num_inference_steps=int(settings["steps"]), shift=float(settings["shift"]), guidance_scale=1.0,
                      bpm=int(settings["bpm"]), keyscale=settings["key"], timesignature=settings["timeSignature"],
                      generator=torch.Generator("cuda").manual_seed(int(job["seed"])))
        made = time.monotonic() - began
        audio = output.audios[0].float().cpu().numpy().astype(np.float32)
        if audio.ndim == 1:
            audio = np.stack([audio, audio])
        sr = int(pipe.sample_rate)
        try:
            numbers = measure(audio, sr, float(settings["bpm"]), vocal_model)
        except Exception as error:  # noqa: BLE001 - a candidate without numbers is simply not chosen
            if vocal_model is None:
                raise
            vocal_error = f"{type(error).__name__}: {error}"[:300]
            vocal_model = None
            numbers = measure(audio, sr, float(settings["bpm"]), None)
        peak = float(np.abs(audio).max())
        scale = 0.98 / peak if peak > 0.98 else 1.0        # room for 24-bit storage; noted below
        results.append({"level": job["level"], "seed": job["seed"], "sampleRate": sr,
                        "flac": _flac(audio * scale, sr), "storedScale": round(scale, 5), "measures": numbers,
                        "seconds": {"make": round(made, 1), "measure": round(time.monotonic() - began - made, 1)}})
        del output
        torch.cuda.empty_cache()
    timings["total"] = round(time.monotonic() - started, 1)
    import diffusers
    import transformers
    return {"results": results, "timings": timings, "gpu": torch.cuda.get_device_name(0),
            "versions": {"diffusers": diffusers.__version__, "transformers": transformers.__version__,
                         "torch": str(torch.__version__)},
            "vocalCheck": "used" if vocal_model is not None else f"not available ({vocal_error})"}


# --- the Modal functions ------------------------------------------------------------------------
@app.function(image=music_image, cpu=(PREPARE_CPU, PREPARE_CPU), memory=(PREPARE_MEMORY_MIB, PREPARE_MEMORY_MIB),
              volumes={"/music": music_weights}, timeout=PREPARE_TIMEOUT, **_ONE_SHOT)
def prepare_music_weights() -> dict:
    return prepare_weights(music_weights.commit)


@app.function(image=music_image, gpu=MUSIC_GPU, cpu=(MUSIC_CPU, MUSIC_CPU), memory=(MUSIC_MEMORY_MIB, MUSIC_MEMORY_MIB),
              volumes={"/music": music_weights}, timeout=MUSIC_TIMEOUT, **_ONE_SHOT)
def make_candidates(request: dict) -> dict:
    return compose(request)
