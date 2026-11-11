"""Make the three disco loops for the app (src/ui/music) with an open music model on Modal.

    python tools/media/make_music.py                     # the plan and its cost; spends nothing
    python tools/media/make_music.py --yes               # really make them (about $0.40)
    python tools/media/make_music.py --from-work <dir>   # redo the choosing and looping for free
    python tools/media/make_music.py --yes --levels 1 --candidates 1 --seconds 20   # a cheap first try

What happens with --yes:
  1. Once per Modal account: ACE-Step 1.5 XL Turbo (MIT, pinned in music.json) is downloaded into our
     own Modal storage "beta-sequence-music-weights" and every big file is checked (no graphics card).
  2. One cloud graphics card makes a few candidates per disco level from the prompts and fixed seeds
     in music.json and measures each one: tempo and how steady the beat is, peaks, silences, bass and
     treble, and how much singing a separation model hears.
  3. On this computer: the best candidate per level is chosen by those numbers, cut to a whole number
     of bars, its end blended into its start so it loops without a click, set to the same loudness and
     saved as Ogg Opus, with music.json beside the files.

Nobody has to listen: the choice is made by measurements. --sample <file.mp3> also writes a short
listening sample (about 20 seconds of each level, one after another).
Prints one JSON object per line. Needs ffmpeg and numpy/scipy on this computer.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import media_settings as S  # noqa: E402

REPO_ROOT = HERE.parent.parent
RECIPE = HERE / "music.json"
OUT_DIR = REPO_ROOT / "src" / "ui" / "music"
LEDGER = REPO_ROOT / ".local" / "media-ledger.jsonl"
_STDOUT = sys.stdout

SR = 48000
PRE = 0.15            # the loop starts this long before the chosen beat, so the seam is between hits
FADE = 0.12           # length of the blend of the end into the start (ends before the beat's hit)
MAX_TRACK_BYTES = 1_000_000

# Cost model (prices from media_settings, checked there). Seconds are estimates, see docs/MEDIA.md.
GPU_RATE = S.rate_per_second("L40S", 4, 32768)
PREPARE_RATE = S.rate_per_second(None, S.PREPARE_CPU, S.PREPARE_MEMORY_MIB)
LOAD_SECONDS = 150            # start the machine and load the model
CANDIDATE_SECONDS = 30        # make and measure one 100-second candidate
PREPARE_SECONDS = 420         # one-time download (11.1 GB) and checksum check
BUILD_USD = 0.05              # building the cloud software the first time
TIMEOUT_SECONDS = 1200        # the cloud machine is stopped after this, whatever happens


class Failure(Exception):
    """An error whose message is already plain English."""


def emit(**fields) -> None:
    _STDOUT.write(json.dumps(fields, ensure_ascii=False) + "\n")
    _STDOUT.flush()


def load_recipe() -> dict:
    return json.loads(RECIPE.read_text(encoding="utf-8"))


# --- plan and cost --------------------------------------------------------------------------------
def jobs_for(recipe: dict, levels: list[int], candidates: int | None, seconds: float | None) -> list[dict]:
    jobs = []
    for entry in recipe["levels"]:
        if entry["level"] not in levels:
            continue
        for seed in entry["seeds"][:candidates or len(entry["seeds"])]:
            job = {"level": entry["level"], "seed": seed, "prompt": entry["prompt"]}
            if seconds:
                job["seconds"] = seconds
            jobs.append(job)
    return jobs


def estimate(jobs: list[dict], first_time: bool) -> dict:
    make = (LOAD_SECONDS + CANDIDATE_SECONDS * len(jobs)) * GPU_RATE
    prepare = (PREPARE_SECONDS * PREPARE_RATE + BUILD_USD) if first_time else 0.0
    worst = TIMEOUT_SECONDS * GPU_RATE + prepare
    return {"makeUsd": round(make, 3), "prepareUsd": round(prepare, 3), "totalUsd": round(make + prepare, 2),
            "worstCaseUsd": round(worst, 2)}


def weights_ready() -> bool | None:
    """Is the music model already in our Modal storage? (a free look-up; None = could not tell)"""
    try:
        import modal
        with contextlib.redirect_stdout(sys.stderr):
            volume = modal.Volume.from_name("beta-sequence-music-weights")
            return any(entry.path.strip("/") == "ready.json" for entry in volume.listdir("/"))
    except Exception:  # noqa: BLE001 - missing storage or no Modal sign-in: treat as first time
        return False


# --- audio in and out (ffmpeg) -------------------------------------------------------------------
def ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if not found:
        raise Failure("The sound tool ffmpeg is missing. Install ffmpeg and try again.")
    return found


def decode(path: Path) -> np.ndarray:
    """Any sound file -> float32 (samples, 2) at 48 kHz."""
    raw = subprocess.run([ffmpeg(), "-nostdin", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2",
                          "-ar", str(SR), "-"], check=True, capture_output=True, timeout=300).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()


def write_wav(path: Path, audio: np.ndarray) -> None:
    subprocess.run([ffmpeg(), "-nostdin", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                    "-c:a", "pcm_f32le", str(path)], input=np.ascontiguousarray(audio, np.float32).tobytes(),
                   check=True, timeout=300)


def loudness(audio: np.ndarray) -> dict:
    """Integrated loudness (LUFS) and true peak (dBTP), measured by ffmpeg's EBU R128 meter."""
    result = subprocess.run([ffmpeg(), "-nostdin", "-hide_banner", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                             "-af", "ebur128=peak=true", "-f", "null", "-"],
                            input=np.ascontiguousarray(audio, np.float32).tobytes(), capture_output=True, timeout=300)
    text = result.stderr.decode("utf-8", "replace")
    summary = text[text.rfind("Summary:"):]
    integrated = true_peak = None
    for line in summary.splitlines():
        line = line.strip()
        if line.startswith("I:"):
            integrated = float(line.split()[1])
        if line.startswith("Peak:"):
            true_peak = float(line.split()[1])
    if integrated is None or true_peak is None:
        raise Failure("Could not measure the loudness with ffmpeg.")
    return {"lufs": integrated, "truePeakDb": true_peak}


def encode_opus(audio: np.ndarray, path: Path, kbps: int) -> None:
    subprocess.run([ffmpeg(), "-nostdin", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                    "-c:a", "libopus", "-b:a", f"{kbps}k", "-vbr", "on", "-compression_level", "10",
                    "-application", "audio", "-map_metadata", "-1", str(path)],
                   input=np.ascontiguousarray(audio, np.float32).tobytes(), check=True, timeout=300)


# --- finding the loop ------------------------------------------------------------------------------
def beat_grid(beats: list[float]) -> tuple[float, float, float]:
    """A straight line through the beat times: (seconds per beat, time of beat 0, jitter in seconds)."""
    times = np.asarray(beats, float)
    if len(times) < 16:
        raise Failure("Too few beats were found to make a loop")
    index = np.arange(len(times))
    period, start = np.polyfit(index, times, 1)
    for _ in range(2):                      # drop beats far off the line (fills, fades) and fit again
        residual = times - (start + period * index)
        keep = np.abs(residual) < max(0.03, 3 * np.std(residual))
        period, start = np.polyfit(index[keep], times[keep], 1)
    residual = times - (start + period * index)
    return float(period), float(start), float(np.std(residual))


def beat_features(audio: np.ndarray, grid: np.ndarray, period: float) -> tuple[np.ndarray, np.ndarray]:
    """Per beat: a 32-band log spectrum (what is playing) and the loudness (dB)."""
    mono = audio.mean(axis=1)
    size = 4096
    edges = np.geomspace(40, 16000, 33)
    freqs = np.fft.rfftfreq(size, 1 / SR)
    band = np.digitize(freqs, edges) - 1
    window = np.hanning(size)
    features, levels = [], []
    for time in grid:
        begin, end = int(time * SR), int((time + period) * SR)
        part = mono[begin:end]
        hops = range(0, max(1, len(part) - size), size // 2)
        spectrum = np.zeros(len(freqs))
        for hop in hops:
            frame = part[hop:hop + size]
            if len(frame) < size:
                frame = np.pad(frame, (0, size - len(frame)))
            spectrum += np.abs(np.fft.rfft(frame * window)) ** 2
        bands = np.array([spectrum[band == b].sum() for b in range(32)]) + 1e-12
        features.append(np.log10(bands))
        levels.append(10 * np.log10(np.mean(part ** 2) + 1e-12))
    return np.array(features), np.array(levels)


def _similar(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean(axis=-1, keepdims=True)
    b = b - b.mean(axis=-1, keepdims=True)
    return float(np.mean(np.sum(a * b, axis=-1) / (np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1) + 1e-12)))


def choose_loop(audio: np.ndarray, beats: list[float], bar_options=(32, 16), skip: float = 4.0, tail: float = 3.0) -> dict:
    """Pick where to cut: a whole number of bars, starting on a bar line, whose end matches its start."""
    period, start, jitter = beat_grid(beats)
    duration = len(audio) / SR
    first = int(np.ceil((max(skip, PRE + 0.6) - start) / period))
    last = int(np.floor((duration - tail - start) / period))
    grid_index = np.arange(first, last + 1)
    grid = start + period * grid_index
    features, levels = beat_features(audio, grid, period)
    # The bar line: chords change there, so what is playing changes most from the beat before.
    change = np.r_[0, 1 - np.array([_similar(features[i - 1], features[i]) for i in range(1, len(features))])]
    phase = int(np.argmax([change[p::4].mean() for p in range(4)]))
    best = None
    for bars in bar_options:
        span = bars * 4
        for k in range(phase, len(grid) - span - 8):
            if k < 8:
                continue
            seam = _similar(features[k - 8:k + 8], features[k + span - 8:k + span + 8])
            inside = levels[k:k + span]
            steady = np.convolve(inside, np.ones(8) / 8, mode="valid")
            dip = float(np.median(inside) - steady.min())          # a quiet break inside the loop, in dB
            level_jump = abs(float(levels[k:k + 4].mean() - levels[k + span:k + span + 4].mean()))
            score = seam - 0.02 * max(0.0, dip - 3) - 0.02 * level_jump
            if (k - phase) % 4:
                continue
            candidate = {"bars": bars, "beat": int(grid_index[k]), "start": float(grid[k]), "period": period,
                         "seam": round(seam, 4), "dipDb": round(dip, 1), "levelJumpDb": round(level_jump, 2),
                         "score": round(score, 4), "jitterMs": round(jitter * 1000, 1)}
            if best is None or candidate["score"] > best["score"] + (0.0 if candidate["bars"] == best["bars"] else 0.02):
                best = candidate
        if best is not None and best["bars"] == bars and best["seam"] >= 0.9:
            break                                    # a good long loop: no need for a shorter one
    if best is None:
        raise Failure("The candidate is too short for a loop")
    return best


def make_loop(audio: np.ndarray, choice: dict, bpm: float) -> np.ndarray:
    """Cut the chosen bars, set them to exactly `bpm`, and blend the end into the start."""
    from scipy.signal import resample

    target = int(round(choice["bars"] * 4 * 60.0 / bpm * SR))
    ratio = (60.0 / bpm) / choice["period"]
    margin = 0.5
    begin = choice["start"] - PRE - margin
    length = choice["bars"] * 4 * choice["period"] + FADE + 2 * margin
    piece = audio[int(round(begin * SR)):int(round((begin + length) * SR))]
    if abs(ratio - 1) > 1e-5:
        piece = resample(piece, int(round(len(piece) * ratio)), axis=0).astype(np.float32)
    offset = int(round(margin * ratio * SR))
    fade = int(round(FADE * SR))
    body = piece[offset:offset + target + fade].copy()
    if len(body) < target + fade:
        raise Failure("The chosen loop runs past the end of the candidate")
    ramp = np.sin(np.linspace(0, np.pi / 2, fade, endpoint=False)) ** 2
    loop = body[:target].copy()
    loop[:fade] = body[:fade] * ramp[:, None] + body[target:target + fade] * (1 - ramp)[:, None]
    return loop


def seam_check(loop: np.ndarray, beat: float = 0.5) -> dict:
    """How the seam (end back to start) compares with the same spot before every other bar line of the loop.

    wrapStepRank: share of all sample-to-sample steps that are smaller than the step from the last sample
    to the first (a click would be near 1.0). seamFluxRank: share of the other beats where the sound changes
    less than at the seam, measured at the same spot (the seam sits just before a bar line, like those spots).
    seamLevelRank: the same for the loudness change across the spot. Near 0.5 means "like any other beat".
    """
    steps = np.abs(np.diff(loop, axis=0)).max(axis=1)
    beats_per_bar = 4
    wrap = float(np.abs(loop[0] - loop[-1]).max())
    size, hop = 2048, 256
    pad = SR
    ring = np.concatenate([loop[-pad:], loop, loop[:pad]]).mean(axis=1)
    window = np.hanning(size)
    count = (len(ring) - size) // hop
    frames = np.lib.stride_tricks.sliding_window_view(ring, size)[::hop][:count] * window
    logs = np.log1p(np.abs(np.fft.rfft(frames, axis=1)) * 10)
    flux = np.r_[0, np.sqrt(np.mean(np.diff(logs, axis=0).clip(min=0) ** 2, axis=1))]
    centres = (np.arange(len(flux)) * hop + size / 2 - pad) / SR      # loop time of each frame
    beats = int(round(len(loop) / SR / beat))
    spots, jumps = [], []
    for k in range(beats):
        near = np.abs(centres - k * beat) <= 0.064
        spots.append(float(flux[near].max()))
        at = pad + int(k * beat * SR)
        before = np.mean(ring[at - SR // 4:at] ** 2) + 1e-12
        after = np.mean(ring[at:at + SR // 4] ** 2) + 1e-12
        jumps.append(float(abs(10 * np.log10(after / before))))
    others_flux, others_jump = np.array(spots[beats_per_bar::beats_per_bar]), np.array(jumps[beats_per_bar::beats_per_bar])     # the other bar lines
    return {"wrapStepRank": round(float(np.mean(steps < wrap)), 4),
            "seamFluxRank": round(float(np.mean(others_flux < spots[0])), 4),
            "seamLevelRank": round(float(np.mean(others_jump < jumps[0])), 4),
            "seamLevelJumpDb": round(jumps[0], 2)}


# --- choosing ----------------------------------------------------------------------------------------
def longest_quiet(audio: np.ndarray, floor_db: float = -45.0) -> float:
    """The longest stretch (seconds) quieter than `floor_db`, in 0.1-second steps."""
    hop = SR // 10
    frames = len(audio) // hop
    mono = audio[:frames * hop].mean(axis=1).reshape(frames, hop)
    quiet = 10 * np.log10(np.mean(mono ** 2, axis=1) + 1e-12) < floor_db
    longest = run = 0
    for flag in quiet:
        run = run + 1 if flag else 0
        longest = max(longest, run)
    return longest / 10


def rate(measures: dict, loop: dict, bpm: float) -> dict:
    """One number per candidate (higher is better) and the reasons it may be refused."""
    spectrum = measures.get("spectrum", {})
    tempo = measures.get("tempo") or 60.0 / loop["period"]
    fit_tempo = 60.0 / loop["period"]
    problems = []
    if not 118 <= fit_tempo <= 124:
        problems.append(f"tempo {fit_tempo:.1f} BPM")
    if loop["jitterMs"] > 25:
        problems.append(f"unsteady beat ({loop['jitterMs']} ms)")
    if loop.get("quietSeconds", 0) > 0.5:
        problems.append(f"{loop['quietSeconds']} s of near-silence inside the loop")
    if measures.get("vocalShare", 0) > 0.12:
        problems.append(f"singing likely ({measures['vocalShare']:.0%} in the vocal part)")
    if spectrum.get("bass", 0) < 0.04:
        problems.append("thin bass")
    if spectrum.get("top", 0) + spectrum.get("air", 0) < 0.002:
        problems.append("dull top end")
    score = (3 * loop["score"] + min(measures.get("beatStrength", 1.0), 3.0) / 3
             + min(spectrum.get("bass", 0) / 0.12, 1.0) + min((spectrum.get("top", 0) + spectrum.get("air", 0)) / 0.01, 1.0)
             - loop["jitterMs"] / 25 - 4 * measures.get("vocalShare", 0) - abs(fit_tempo - bpm) / 2
             - (0.5 if measures.get("clippedSamples", 0) > 100 else 0))
    return {"score": round(score, 4), "problems": problems, "librosaTempo": tempo, "fitTempo": round(fit_tempo, 3)}


def finish(work: Path, recipe: dict, levels: list[int], sample: Path | None, out_dir: Path = OUT_DIR) -> dict:
    """Choose, loop, level and save. Free: uses only what --yes saved in `work`."""
    bpm = float(recipe["music"]["bpm"])
    bar_options = (recipe["music"]["bars"], recipe["music"]["fallbackBars"])
    index = json.loads((work / "candidates.json").read_text(encoding="utf-8"))
    out_dir.mkdir(parents=True, exist_ok=True)
    chosen = {}
    for entry in recipe["levels"]:
        if entry["level"] not in levels:
            continue
        ranked = []
        for item in (c for c in index["candidates"] if c["level"] == entry["level"]):
            audio = decode(work / item["file"])
            try:
                loop = choose_loop(audio, item["measures"]["beats"], bar_options)
            except Failure as error:
                emit(level=entry["level"], seed=item["seed"], refused=str(error))
                continue
            begin = int((loop["start"] - PRE) * SR)
            loop["quietSeconds"] = longest_quiet(audio[begin:begin + int(loop["bars"] * 4 * loop["period"] * SR)])
            verdict = rate(item["measures"], loop, bpm)
            ranked.append((not verdict["problems"], verdict["score"], item, loop, verdict))
            emit(level=entry["level"], seed=item["seed"], score=verdict["score"], problems=verdict["problems"],
                 tempo=verdict["fitTempo"], loop={k: loop[k] for k in ("bars", "start", "seam", "dipDb", "jitterMs", "quietSeconds")},
                 vocalShare=item["measures"].get("vocalShare"), spectrum=item["measures"].get("spectrum"),
                 beatStrength=item["measures"].get("beatStrength"))
        if not ranked:
            raise Failure(f"No usable candidate for disco level {entry['level']}")
        ranked.sort(key=lambda row: (row[0], row[1]), reverse=True)
        _, _, item, loop, verdict = ranked[0]
        chosen[entry["level"]] = (entry, item, loop, verdict)
    # All levels get the same number of bars, so a switch to the next level stays in time.
    bars = min(loop["bars"] for _, _, loop, _ in chosen.values())
    tracks = []
    loops = {}
    for level, (entry, item, loop, verdict) in sorted(chosen.items()):
        audio = decode(work / item["file"])
        if loop["bars"] != bars:
            loop = choose_loop(audio, item["measures"]["beats"], (bars,))
        made = make_loop(audio, loop, bpm)
        before = loudness(np.tile(made, (2, 1)))
        gain_db = entry["loudnessLufs"] - before["lufs"]
        if before["truePeakDb"] + gain_db > -1.0:                    # keep at least 1 dB of headroom
            gain_db = -1.0 - before["truePeakDb"]
        made = (made * 10 ** (gain_db / 20)).astype(np.float32)
        seconds = len(made) / SR
        kbps = min(128, int(MAX_TRACK_BYTES * 8 * 0.94 / seconds / 1000))
        path = out_dir / entry["file"]
        while True:
            encode_opus(made, path, kbps)
            if path.stat().st_size <= MAX_TRACK_BYTES or kbps <= 64:
                break
            kbps -= 8
        played = decode(path)
        after = loudness(np.tile(played, (2, 1)))
        seam = seam_check(played, 60.0 / bpm)
        loops[level] = played
        record = {"level": level, "name": entry["name"], "file": entry["file"], "bytes": path.stat().st_size,
                  "bpm": bpm, "bars": bars, "seconds": round(seconds, 6), "samples": len(made),
                  "decodedSamples": len(played), "loudnessLufs": after["lufs"], "truePeakDb": after["truePeakDb"],
                  "codec": "opus", "bitrateKbps": kbps,
                  "measured": {"tempoBeforeFit": item["measures"].get("tempo"), "tempoLine": verdict["fitTempo"],
                               "beatJitterMs": loop["jitterMs"], "beatStrength": item["measures"].get("beatStrength"),
                               "vocalShare": item["measures"].get("vocalShare"),
                               "spectrum": item["measures"].get("spectrum"), "clippedSamples": item["measures"].get("clippedSamples"),
                               "loopFrom": round(loop["start"] - PRE, 3), "loopMatch": loop["seam"], **seam},
                  "prompt": entry["prompt"], "lyrics": recipe["music"]["lyrics"], "seed": item["seed"],
                  "key": recipe["music"]["key"]}
        tracks.append(record)
        emit(level=level, chosen=item["seed"], file=str(path), bytes=record["bytes"], lufs=after["lufs"],
             truePeak=after["truePeakDb"], bars=bars, seconds=round(seconds, 3), seam=seam)
    if len(tracks) == len(recipe["levels"]):
        model = recipe["model"]
        manifest = {
            "about": "Three disco loops for the app, one per disco level. Made with the open model ACE-Step 1.5 XL "
                     "Turbo from a style description only (no song, band or artist named, no recording used). "
                     "Made by tools/media/make_music.py from tools/media/music.json.",
            "bpm": bpm, "key": recipe["music"]["key"], "bars": bars, "seconds": tracks[0]["seconds"], "sampleRate": SR,
            "made": index.get("date", datetime.now(timezone.utc).date().isoformat()),
            "model": {"repo": model["repo"], "revision": model["revision"], "license": model["license"],
                      "licenseNote": model["licenseNote"], "code": index.get("code", model["code"]),
                      "settings": {k: recipe["music"][k] for k in ("steps", "shift", "seconds")}},
            "tracks": tracks,
        }
        (out_dir / "music.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if sample and len(loops) == 3:
        write_sample(loops, sample)
        emit(sample=str(sample))
    return {"tracks": tracks}


def write_sample(loops: dict, path: Path, each: float = 20.0, fade: float = 1.0) -> None:
    """About 20 seconds of each level, one after another, blended in time as the app does."""
    length = int(each * 3 * SR)
    out = np.zeros((length, 2), np.float32)
    position = np.arange(length)
    for number, level in enumerate(sorted(loops)):
        loop = loops[level]
        part = loop[position % len(loop)]
        weight = np.clip((position / SR - number * each + fade / 2) / fade, 0, 1) if number else np.ones(length)
        if number < 2:
            weight = weight * np.clip(((number + 1) * each + fade / 2 - position / SR) / fade, 0, 1)
        out += part * weight[:, None]
    tail = int(2 * SR)
    out[-tail:] *= np.linspace(1, 0, tail)[:, None]
    subprocess.run([ffmpeg(), "-nostdin", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                    "-c:a", "libmp3lame", "-b:a", "192k", str(path)], input=out.tobytes(), check=True, timeout=300)


# --- the paid part -----------------------------------------------------------------------------------
def append_ledger(entry: dict) -> None:
    try:
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        with LEDGER.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def run_cloud(recipe: dict, jobs: list[dict], work: Path) -> dict:
    ledger = {"usd": 0.0, "steps": []}

    def timed(function, argument, rate, label):
        began = time.monotonic()
        try:
            return function.remote(argument) if argument is not None else function.remote()
        finally:
            seconds = time.monotonic() - began
            ledger["steps"].append({"step": label, "seconds": round(seconds, 1), "usd": round(seconds * rate, 4)})
            ledger["usd"] += seconds * rate
            emit(stage=label, seconds=round(seconds, 1), usdSoFar=round(ledger["usd"], 3))

    started = time.monotonic()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import media_music as M
            with M.app.run():
                prepared = timed(M.prepare_music_weights, None, PREPARE_RATE, "get music model")
                emit(stage="model ready", bytes=prepared.get("bytes"), alreadyThere=prepared.get("alreadyThere", False))
                made = timed(M.make_candidates, {"jobs": jobs, "music": recipe["music"]}, GPU_RATE, "make candidates")
    finally:
        append_ledger({"time": datetime.now(timezone.utc).isoformat(), "name": "music", "jobs": len(jobs),
                       "usd": round(ledger["usd"], 4), "steps": ledger["steps"],
                       "wallSeconds": round(time.monotonic() - started, 1)})
    work.mkdir(parents=True, exist_ok=True)
    index = {"date": datetime.now(timezone.utc).date().isoformat(), "gpu": made["gpu"], "versions": made["versions"],
             "code": f"diffusers {made['versions']['diffusers']} (AceStepPipeline)", "vocalCheck": made["vocalCheck"],
             "timings": made["timings"], "usd": round(ledger["usd"], 4), "candidates": []}
    for result in made["results"]:
        name = f"level{result['level']}-seed{result['seed']}.flac"
        (work / name).write_bytes(result["flac"])
        index["candidates"].append({k: v for k, v in result.items() if k != "flac"} | {"file": name})
    (work / "candidates.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    emit(stage="candidates saved", folder=str(work), count=len(made["results"]), vocalCheck=made["vocalCheck"],
         gpu=made["gpu"], timings=made["timings"], usd=round(ledger["usd"], 3),
         wallSeconds=round(time.monotonic() - started, 1))
    return index


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--yes", action="store_true", help="really make the music (this spends money)")
    parser.add_argument("--from-work", help="skip the cloud; choose and loop the candidates saved in this folder")
    parser.add_argument("--work", default=str(REPO_ROOT / ".local" / "music-work"),
                        help="folder that keeps the paid candidates, so finishing can be redone for free")
    parser.add_argument("--levels", default="1,2,3", help="which disco levels, e.g. 1 or 1,2,3")
    parser.add_argument("--candidates", type=int, help="candidates per level (default: every seed in music.json)")
    parser.add_argument("--seconds", type=float, help="length of each candidate (default from music.json)")
    parser.add_argument("--out", default=str(OUT_DIR), help="where the loops and their music.json go")
    parser.add_argument("--sample", help="also write a listening sample (MP3) here")
    parser.add_argument("--max-cost", type=float, default=1.5, help="refuse to start above this worst-case cost in USD")
    args = parser.parse_args(argv)
    try:
        recipe = load_recipe()
        levels = sorted({int(part) for part in args.levels.split(",")})
        if args.from_work:
            result = finish(Path(args.from_work), recipe, levels, Path(args.sample) if args.sample else None, Path(args.out))
            emit(done=True, tracks=len(result["tracks"]), costUsd=0)
            return 0
        jobs = jobs_for(recipe, levels, args.candidates, args.seconds)
        first_time = not weights_ready()
        cost = estimate(jobs, first_time)
        emit(plan="disco loops", model=f"{recipe['model']['repo']}@{recipe['model']['revision'][:12]}",
             candidates=len(jobs), firstTimeDownload=first_time, **cost)
        if cost["worstCaseUsd"] > args.max_cost:
            raise Failure(f"This could cost up to ${cost['worstCaseUsd']:.2f}, above the allowed ${args.max_cost:.2f} (--max-cost)")
        if not args.yes:
            emit(dryRun=True, message=f"Nothing was done. Add --yes to make the music for about ${cost['totalUsd']:.2f}.")
            return 0
        work = Path(args.work)
        if work.exists() and any(work.iterdir()):
            work = work / datetime.now().strftime("%Y%m%d-%H%M%S")
        index = run_cloud(recipe, jobs, work)
        if args.seconds and args.seconds < 60:
            emit(done=True, message="A short try: candidates saved, no loops made.", folder=str(work), costUsd=index["usd"])
            return 0
        result = finish(work, recipe, levels, Path(args.sample) if args.sample else None, Path(args.out))
        emit(done=True, tracks=len(result["tracks"]), costUsd=index["usd"], folder=str(work))
        return 0
    except Failure as error:
        emit(error=str(error))
        return 1
    except Exception as error:  # noqa: BLE001
        emit(error=f"Something went wrong while making the music ({type(error).__name__}: {str(error)[:300]})")
        return 1


if __name__ == "__main__":
    sys.exit(main())
