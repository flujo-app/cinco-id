"""Make a new dancing sequence: picture -> dance -> cut-out -> seamless loop -> files.

    python tools/media/generate.py --name "Tayne" --prompt "<character and dance>" --out <folder>
                                   [--expressions smiling] [--seed N] [--max-cost 1.5]
    python tools/media/generate.py --prepare      # one-time download and checks, no graphics card

Prints one JSON object per line on stdout while it works and finishes with
{"done": true, "media": "<path to media.json>", "costUsdEstimate": 0.31}.
On failure prints {"error": "<plain reason>"} and exits with a non-zero code.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import sys
import tempfile
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import media_settings as S  # noqa: E402

REPO_ROOT = HERE.parent.parent
LEDGER = REPO_ROOT / ".local" / "media-ledger.jsonl"
_STDOUT = sys.stdout

STYLE = ("Low-fi early-1990s public-access TV computer graphics look, simple chunky shapes, soft flat lighting, "
         "slightly dated 3D render.")
POSE = ("Full-body view of the whole character from the very top of the head down to the shoes, standing upright "
        "and facing the viewer in a relaxed ready-to-dance pose with the arms a little away from the body, "
        "centred in the picture with empty space all around, nothing cropped.")
BACKDROP = ("Plain flat even light grey studio background with nothing else in the picture: no floor, no shadow, "
            "no props, no text, no logo.")
NEGATIVE = ("camera movement, zoom in, zoom out, pan, tilt, cut, scene change, second character, crowd, text, "
            "subtitles, watermark, logo, floor, cast shadow, cropped feet, cropped head, leaving the frame, blurry, "
            "distorted body, extra limbs, melting, morphing, flicker, photorealistic person")


class Failure(Exception):
    """An error whose message is already plain English."""


def emit(**fields) -> None:
    _STDOUT.write(json.dumps(fields, ensure_ascii=False) + "\n")
    _STDOUT.flush()


def progress(stage: str, value: float, message: str) -> None:
    emit(stage=stage, progress=round(value, 2), message=message)


def build_prompts(name: str, prompt: str, key_color_name: str | None, expressions: list[str]) -> dict:
    description = prompt.strip().rstrip(".")
    image = f"{description}. {POSE} {BACKDROP} {STYLE}"
    prompts = {"image": image}
    for expression in expressions:
        prompts[f"expression:{expression}"] = (
            f"{image} The character is {expression}: clearly {expression} with a big, happy expression.")
    if key_color_name:
        prompts["motion"] = motion_prompt(description, key_color_name)
    return prompts


def motion_prompt(description: str, key_color_name: str) -> str:
    return (f"{description}. The character dances energetically on the spot in the middle of the frame and "
            f"finishes the dance back in exactly the pose it started in. The whole body stays in view from head "
            f"to feet the entire time. Locked-off static camera with no zoom, no pan and no cuts. The background "
            f"is a plain flat {key_color_name} backdrop that stays perfectly even and still, with no shadows. "
            f"{STYLE} Smooth, playful, rhythmic motion.")


def append_ledger(entry: dict) -> None:
    try:
        LEDGER.parent.mkdir(parents=True, exist_ok=True)
        with LEDGER.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry) + "\n")
    except OSError:
        pass  # The ledger is a convenience; never fail a finished generation over it.


def friendly(error: BaseException) -> str:
    text = f"{type(error).__name__}: {error}"
    lowered = text.lower()
    if isinstance(error, Failure):
        return str(error)
    if "token" in lowered and ("modal" in lowered or "auth" in lowered):
        return "Could not sign in to the cloud computer service (Modal). Run 'modal setup' once."
    if "not found" in lowered and "volume" in lowered:
        return "The cloud storage with the dance model is missing, so no dance can be made."
    if "timeout" in lowered or "timed out" in lowered:
        return "The cloud computer took too long and was stopped. Nothing is left running; please try again."
    if "ffmpeg" in lowered or "ffprobe" in lowered:
        return "The video tool ffmpeg is missing or failed. Install ffmpeg and try again."
    if "connection" in lowered or "network" in lowered:
        return "Could not reach the cloud computer service. Check the internet connection."
    return f"Something went wrong while making the dancer ({text[:200]})."


def run_remote(function, argument, rate: float, ledger: dict, label: str):
    began = time.monotonic()
    try:
        return function.remote(argument) if argument is not None else function.remote()
    finally:
        seconds = time.monotonic() - began
        ledger["steps"].append({"step": label, "seconds": round(seconds, 1), "usd": round(seconds * rate, 4)})
        ledger["usd"] += seconds * rate


def remote_step(work: Path | None, label: str, request, run):
    """Run one cloud step, or reuse its saved result from --work when the request is identical."""
    import hashlib
    import pickle
    if work is None:
        return run()
    payload = request if isinstance(request, bytes) else json.dumps(request, sort_keys=True, default=lambda b: hashlib.sha256(b).hexdigest()).encode()
    path = work / f"{label}-{hashlib.sha256(payload).hexdigest()[:16]}.pickle"
    if path.exists():
        with path.open("rb") as stream:
            return pickle.load(stream)
    result = run()
    work.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as stream:
        pickle.dump(result, stream)
    return result


def load_rgb_alpha(picture_png: bytes, alpha_png: bytes):
    import numpy as np
    from PIL import Image
    with Image.open(io.BytesIO(picture_png)) as image:
        rgb = np.asarray(image.convert("RGB"))
    with Image.open(io.BytesIO(alpha_png)) as image:
        alpha = np.asarray(image.convert("L"), np.float32) / 255.0
    return rgb, alpha


def make_still(picture_png: bytes, alpha_png: bytes):
    """Cut-out on the final clip canvas, laid out exactly like the dance."""
    import media_finish as F
    rgb, alpha = load_rgb_alpha(picture_png, alpha_png)
    rgba = F.cutout(rgb, alpha)
    placed, _ = F.place_figure(rgba, (S.MOTION_WIDTH, S.MOTION_HEIGHT), S.FIGURE_HEIGHT_SHARE,
                               S.FIGURE_MAX_WIDTH_SHARE, S.FEET_LINE)
    return rgb, alpha, rgba, placed


def generate(args: argparse.Namespace) -> dict:
    import numpy as np
    import media_finish as F
    from media_contract import build_media, validate_folder, write_media

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    expressions = []
    for item in args.expressions or []:
        expressions += [part.strip().lower() for part in item.split(",") if part.strip()]
    for expression in expressions:
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", expression):
            raise Failure(f"'{expression}' is not a valid expression name")
    seed = args.seed if args.seed is not None else zlib.crc32(args.name.encode("utf-8")) % (2 ** 31)
    if S.WORST_CASE_USD > args.max_cost:
        raise Failure(f"One dancer can cost up to ${S.WORST_CASE_USD:.2f}, above the allowed ${args.max_cost:.2f}")
    ledger = {"usd": 0.0, "steps": []}
    started = time.monotonic()
    work = Path(args.work).resolve() if args.work else None

    progress("setup", 0.02, "Waking up the cloud computers")
    with contextlib.redirect_stdout(sys.stderr):
        import modal
        import media_cloud as C
        with C.app.run():
            names = {entry.path.strip("/") for entry in C.art_weights.listdir("/")}
            if "ready.json" not in names:
                progress("setup", 0.04, "Downloading the drawing tools (first time only, takes a few minutes)")
                run_remote(C.prepare_art_weights, None, S.PREPARE_RATE, ledger, "download picture models")

            # 1. Character picture (+ expressions), cut out.
            prompts = build_prompts(args.name, args.prompt, None, expressions)
            progress("image", 0.08, "Drawing the character")
            draw_request = {"prompt": prompts["image"], "seed": seed,
                            "expressions": {e: prompts[f"expression:{e}"] for e in expressions}}
            drawn = remote_step(work, "draw", draw_request, lambda: run_remote(
                C.draw, draw_request, S.ART_RATE, ledger, "draw and cut out stills"))
            progress("image", 0.25, "Cutting the character out of the picture")
            rgb, alpha, rgba, placed = make_still(drawn["picture"], drawn["alpha"])
            key_name, key_color = F.choose_key_color(rgb, rgba[..., 3])
            keyframe = F.over_color(placed, key_color)
            buffer = io.BytesIO()
            from PIL import Image
            Image.fromarray(keyframe, "RGB").save(buffer, format="PNG")
            prompts["motion"] = motion_prompt(args.prompt.strip().rstrip("."), key_name)

            # 2. Dance.
            progress("motion", 0.3, "Teaching the character to dance (this is the slow part, about 3 to 5 minutes)")
            motion_request = {
                "keyframe": buffer.getvalue(), "prompt": prompts["motion"], "negative_prompt": NEGATIVE,
                "seed": seed, "width": S.MOTION_WIDTH, "height": S.MOTION_HEIGHT,
                "num_frames": S.MOTION_FRAMES, "settings": S.LTX_SETTINGS,
            }
            moved = remote_step(work, "dance", motion_request, lambda: run_remote(
                C.animate, motion_request, S.MOTION_RATE, ledger, "dance"))

            # 3. Cut the dancer out of every frame.
            progress("cutout", 0.7, "Removing the background from every frame")
            matted = remote_step(work, "cutout", moved["video"], lambda: run_remote(
                C.cut_out, moved["video"], S.ART_RATE, ledger, "cut out frames"))

    progress("loop", 0.8, "Making the dance loop smoothly")
    with tempfile.TemporaryDirectory(prefix="beta-sequence-media-") as tmp:
        video_path = Path(tmp) / "motion.mkv"
        video_path.write_bytes(moved["video"])
        frames_rgb = F.decode_video_rgb(video_path)
    alphas = np.load(io.BytesIO(matted["alpha"]))["alpha"].astype(np.float32) / 255.0
    if len(frames_rgb) != len(alphas):
        raise Failure("The dance and its cut-out have different lengths")
    key = np.array(key_color, np.float32) / 255.0
    frames = []
    for frame, frame_alpha in zip(frames_rgb, alphas):
        backdrop = F.border_color(frame)
        if np.linalg.norm(backdrop - key) > 0.35:
            backdrop = key
        cut = F.cutout(frame, frame_alpha, backdrop, key=key)
        frames.append(F.resize_rgba(cut, (S.OUTPUT_WIDTH, S.OUTPUT_HEIGHT)))
    looped, loop_report = F.make_loop(frames)

    progress("encode", 0.9, "Saving the see-through video and pictures")
    clip_info = F.encode_webm(looped, out / "loop.webm", fps=S.FPS)
    still = F.resize_rgba(placed, (S.OUTPUT_WIDTH, S.OUTPUT_HEIGHT))
    F.save_png(still, out / "still.png")
    for expression in expressions:
        drawn_expression = drawn["expressions"][expression]
        _, _, _, placed_expression = make_still(drawn_expression["picture"], drawn_expression["alpha"])
        F.save_png(F.resize_rgba(placed_expression, (S.OUTPUT_WIDTH, S.OUTPUT_HEIGHT)), out / f"{expression}.png")
    hat = F.hat_line(still[..., 3])
    cost = round(ledger["usd"], 2)
    prompts["negative"] = NEGATIVE
    media = build_media(
        width=S.OUTPUT_WIDTH, height=S.OUTPUT_HEIGHT, fps=S.FPS, frames=len(looped), expressions=expressions,
        hat_line=hat, models=S.model_records(), prompts=prompts, cost_usd=cost,
        extra={"seed": seed, "backdropForCutout": key_name, "loop": loop_report,
               "seconds": round(time.monotonic() - started), "machineGenerated": True},
    )
    media_path = write_media(out, media)
    problems = validate_folder(out)
    if problems:
        raise Failure("The finished files did not pass the check: " + "; ".join(problems))
    append_ledger({"time": datetime.now(timezone.utc).isoformat(), "name": args.name, "out": str(out),
                   "seed": seed, "usd": round(ledger["usd"], 4), "steps": ledger["steps"],
                   "clipBytes": clip_info["bytes"], "loop": loop_report})
    return {"done": True, "media": str(media_path), "costUsdEstimate": cost}


def prepare() -> dict:
    ledger = {"usd": 0.0, "steps": []}
    progress("setup", 0.05, "Getting the cloud tools ready (first time can take 15 minutes)")
    with contextlib.redirect_stdout(sys.stderr):
        import media_cloud as C
        with C.app.run():
            names = {entry.path.strip("/") for entry in C.art_weights.listdir("/")}
            if "ready.json" not in names:
                progress("setup", 0.2, "Downloading the drawing tools")
                run_remote(C.prepare_art_weights, None, S.PREPARE_RATE, ledger, "download picture models")
            progress("setup", 0.6, "Checking the drawing tools")
            art = run_remote(C.selftest_art, None, S.PREPARE_RATE, ledger, "check picture tools")
            progress("setup", 0.8, "Checking the dance tools")
            motion = run_remote(C.selftest_motion, None, S.PREPARE_RATE, ledger, "check dance tools")
    append_ledger({"time": datetime.now(timezone.utc).isoformat(), "name": "prepare",
                   "usd": round(ledger["usd"], 4), "steps": ledger["steps"]})
    return {"done": True, "art": art, "motion": motion, "costUsdEstimate": round(ledger["usd"], 2)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Make a see-through dancing loop for a sequence.")
    parser.add_argument("--name")
    parser.add_argument("--prompt")
    parser.add_argument("--out")
    parser.add_argument("--expressions", action="append", help="for example: smiling (repeat or comma-separate)")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--max-cost", type=float, default=1.5, help="refuse to start above this many US dollars")
    parser.add_argument("--prepare", action="store_true", help="download and check the tools only")
    parser.add_argument("--work", help="folder that keeps the raw cloud results, so finishing can be redone for free")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:
        if exit_.code:
            emit(error="The command was not understood. Use --name, --prompt and --out.")
        return int(exit_.code or 0)
    os.environ.setdefault("PYTHONUTF8", "1")
    try:
        if args.prepare:
            emit(**prepare())
            return 0
        if not (args.name and args.prompt and args.out):
            raise Failure("Please give a name, a description and an output folder.")
        if len(args.prompt) > 2000 or len(args.name) > 80:
            raise Failure("The name or description is too long.")
        emit(**generate(args))
        return 0
    except KeyboardInterrupt:
        emit(error="Stopped before it was finished.")
        return 130
    except BaseException as error:  # noqa: BLE001 - every failure must become one plain JSON line
        emit(error=friendly(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
