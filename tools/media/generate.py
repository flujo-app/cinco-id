"""Make a new dancing sequence: picture -> dance -> cut-out -> seamless loop -> files.

    python tools/media/generate.py --name "Tayne" --prompt "<person and dance>" --out <folder>
                                   [--expressions smiling] [--seed N]
                                   [--engine seedance|ltx] [--resolution 480p|720p] [--dry-run]
                                   [--stills-only | --from-still] [--max-cost 1.5]
    python tools/media/generate.py --prepare      # one-time download and checks, no graphics card

Prints one JSON object per line on stdout while it works and finishes with
{"done": true, "media": "<path to media.json>", "costUsdEstimate": 0.31}.
On failure prints {"error": "<plain reason>"} and exits with a non-zero code.

Engines for the dance step:
  seedance  Seedance 2.5 through OpenRouter. Paid per clip with the owner's key, read only
            from the OPENROUTER_API_KEY environment variable. Default when that key is set.
  ltx       LTX-2.5 on our own Modal cloud graphics card. Default without a key.
Pictures and background removal always run on Modal with pinned open models.
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

STYLE = ("Realistic video footage of a real-looking, ordinary, invented person who is not any celebrity or real "
         "individual. Early-1990s public-access TV or corporate training tape look: slightly soft analogue video "
         "picture, warm colours, bright even studio lighting.")
POSE = ("Full-body shot of the whole person from the very top of the head (or hat) down to the shoes, standing "
        "upright and facing the camera in a relaxed ready-to-dance pose with the arms a little away from the body, "
        "centred with empty space all around, nothing cropped.")
BACKDROP = ("Plain seamless solid light grey studio backdrop with nothing else in the picture: no props, no text, "
            "no logo.")
NEGATIVE = ("camera movement, zoom in, zoom out, pan, tilt, cut, scene change, second person, crowd, text, "
            "subtitles, watermark, logo, cropped feet, cropped head, leaving the frame, blurry, distorted body, "
            "extra limbs, melting, morphing, flicker, talking")
EXPRESSION_WORDS = {"smiling": "clearly smiling with a big, warm, happy smile"}


class Failure(Exception):
    """An error whose message is already plain English."""


def emit(**fields) -> None:
    _STDOUT.write(json.dumps(fields, ensure_ascii=False) + "\n")
    _STDOUT.flush()


def progress(stage: str, value: float, message: str) -> None:
    emit(stage=stage, progress=round(value, 2), message=message)


# --- prompts ------------------------------------------------------------------------
def build_prompts(name: str, prompt: str, key_color_name: str | None, expressions: list[str]) -> dict:
    description = prompt.strip().rstrip(".")
    image = f"{description}. {POSE} {BACKDROP} {STYLE}"
    prompts = {"image": image}
    for expression in expressions:
        words = EXPRESSION_WORDS.get(expression, f"clearly {expression}")
        prompts[f"expression:{expression}"] = f"{image} The person is {words}."
    if key_color_name:
        prompts["motion"] = motion_prompt(description, key_color_name)
    return prompts


def motion_prompt(description: str, key_color_name: str) -> str:
    return (f"{description}. The person dances on the spot in the middle of the frame and finishes the dance back "
            f"in exactly the pose they started in. The whole body stays in view from head to feet the entire time. "
            f"Static locked-off camera with no zoom, no pan and no cuts. The background is a plain flat "
            f"{key_color_name} studio backdrop that stays perfectly even and still. Realistic early-1990s "
            f"public-access TV video look. Smooth, rhythmic, slightly goofy dancing. No talking, no text.")


# --- bookkeeping -----------------------------------------------------------------------
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
    if isinstance(error, Failure) or type(error).__name__ in {"SeedanceError", "HttpError"}:
        return str(error)
    if "token" in lowered and ("modal" in lowered or "auth" in lowered):
        return "Could not sign in to the cloud computer service (Modal). Run 'modal setup' once."
    if "not found" in lowered and "volume" in lowered:
        return "The cloud storage with the models is missing. Run generate.py --prepare first."
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
    """Run one paid step, or reuse its saved result from --work when the request is identical."""
    import hashlib
    import pickle
    if work is None:
        return run()
    payload = request if isinstance(request, bytes) else json.dumps(
        request, sort_keys=True, default=lambda b: hashlib.sha256(b).hexdigest()).encode()
    path = work / f"{label}-{hashlib.sha256(payload).hexdigest()[:16]}.pickle"
    if path.exists():
        with path.open("rb") as stream:
            return pickle.load(stream)
    result = run()
    work.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as stream:
        pickle.dump(result, stream)
    return result


@contextlib.contextmanager
def cloud():
    """An ephemeral Modal app: it exists only inside this block, so nothing is left running."""
    with contextlib.redirect_stdout(sys.stderr):
        import media_cloud as C
        with C.app.run():
            yield C


# --- pictures -------------------------------------------------------------------------
def load_rgb_alpha(picture_png: bytes, alpha_png: bytes):
    import numpy as np
    from PIL import Image
    with Image.open(io.BytesIO(picture_png)) as image:
        rgb = np.asarray(image.convert("RGB"))
    with Image.open(io.BytesIO(alpha_png)) as image:
        alpha = np.asarray(image.convert("L"), np.float32) / 255.0
    return rgb, alpha


def layout(picture_png: bytes, alpha_png: bytes):
    """Cut-out laid out on the keyframe canvas exactly like the dance's first frame."""
    import media_finish as F
    rgb, alpha = load_rgb_alpha(picture_png, alpha_png)
    rgba = F.cutout(rgb, alpha)
    placed, _ = F.place_figure(rgba, (S.KEYFRAME_WIDTH, S.KEYFRAME_HEIGHT), S.FIGURE_HEIGHT_SHARE,
                               S.FIGURE_MAX_WIDTH_SHARE, S.FEET_LINE)
    return placed


def png_bytes(rgb) -> bytes:
    from PIL import Image
    buffer = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buffer, format="PNG")
    return buffer.getvalue()


def keyframe_on_backdrop(keyframe, size: tuple[int, int]):
    """Keyframe composited onto the backdrop colour that is furthest from the figure's colours."""
    import media_finish as F
    figure = F.to_uint8(keyframe[..., :3])
    key_name, key_color = F.choose_key_color(figure, keyframe[..., 3])
    resized = keyframe if (keyframe.shape[1], keyframe.shape[0]) == size else F.resize_rgba(keyframe, size)
    return key_name, key_color, png_bytes(F.over_color(resized, key_color))


def save_stills(out: Path, drawn: dict, expressions: list[str]):
    """Write keyframe.png (full size), still.png and one PNG per expression (clip size)."""
    import media_finish as F
    keyframe = layout(drawn["picture"], drawn["alpha"])
    F.save_png(keyframe, out / "keyframe.png")
    F.save_png(F.resize_rgba(keyframe, (S.OUTPUT_WIDTH, S.OUTPUT_HEIGHT)), out / "still.png")
    for expression in expressions:
        item = drawn["expressions"][expression]
        placed = layout(item["picture"], item["alpha"])
        F.save_png(F.resize_rgba(placed, (S.OUTPUT_WIDTH, S.OUTPUT_HEIGHT)), out / f"{expression}.png")
    return keyframe


def base_picture(folder: Path, tint: str | None = None) -> bytes:
    """Another sequence's character on the grey drawing backdrop, as the start for a re-dressed variant.

    A redraw keeps the old colours, so `tint` (for example "#e6c2a0") first repaints
    the figure in that colour, keeping its light and shade, so the new outfit can change colour.
    """
    import numpy as np
    import media_finish as F
    keyframe = load_keyframe(folder.resolve())
    placed = F.resize_rgba(keyframe, (S.PICTURE_WIDTH, S.PICTURE_HEIGHT))
    if tint:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", tint):
            raise Failure("The tint must look like #e6c2a0")
        color = np.array([int(tint[i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255
        light = placed[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32)
        shaded = np.clip(light[..., None] / max(float(color.mean()), 1e-3) * color, 0, 1)
        placed[..., :3] = 0.85 * shaded + 0.15 * placed[..., :3]
    return png_bytes(F.over_color(placed, (190, 190, 190)))


def load_keyframe(out: Path):
    import media_finish as F
    import numpy as np
    from PIL import Image
    path = out / "keyframe.png"
    if not path.exists():
        raise Failure("There is no keyframe.png in that folder yet; make the stills first (--stills-only)")
    with Image.open(path) as image:
        keyframe = F.to_float(np.asarray(image.convert("RGBA")))
    if (keyframe.shape[1], keyframe.shape[0]) != (S.KEYFRAME_WIDTH, S.KEYFRAME_HEIGHT):
        keyframe = F.resize_rgba(keyframe, (S.KEYFRAME_WIDTH, S.KEYFRAME_HEIGHT))
    return keyframe


# --- finishing ------------------------------------------------------------------------------
def finish(out: Path, video: bytes, alphas_npz: bytes, key_color, keyframe, expressions: list[str],
           models: list[dict], prompts: dict, cost: float, extra: dict) -> Path:
    import numpy as np
    import media_finish as F
    from media_contract import build_media, validate_folder, write_media

    progress("loop", 0.85, "Making the dance loop smoothly")
    with tempfile.TemporaryDirectory(prefix="beta-sequence-media-") as tmp:
        video_path = Path(tmp) / "motion.mp4"
        video_path.write_bytes(video)
        frames_rgb = F.decode_video_rgb(video_path)
        rate = F.probe(video_path)["streams"][0].get("avg_frame_rate", "24/1")
    numerator, _, denominator = rate.partition("/")
    fps = round(float(numerator) / float(denominator or 1)) if float(numerator or 0) else S.FPS
    alphas = np.load(io.BytesIO(alphas_npz))["alpha"].astype(np.float32) / 255.0
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
    seconds = len(looped) / fps
    if seconds > 6.0:
        looped = looped[:6 * fps]
        loop_report["trimmedTo"] = len(looped)

    progress("encode", 0.93, "Saving the see-through video")
    clip = F.encode_webm(looped, out / "loop.webm", fps=fps)
    still = F.resize_rgba(keyframe, (S.OUTPUT_WIDTH, S.OUTPUT_HEIGHT))
    if not (out / "still.png").exists():
        F.save_png(still, out / "still.png")
    media = build_media(
        width=S.OUTPUT_WIDTH, height=S.OUTPUT_HEIGHT, fps=fps, frames=len(looped), expressions=expressions,
        hat_line=F.hat_line(still[..., 3]), models=models, prompts=prompts, cost_usd=cost,
        extra={**extra, "loop": loop_report, "clipBytes": clip["bytes"], "machineGenerated": True},
    )
    media_path = write_media(out, media)
    problems = validate_folder(out)
    if problems:
        raise Failure("The finished files did not pass the check: " + "; ".join(problems))
    return media_path


# --- the command ------------------------------------------------------------------------------
def parse_expressions(values) -> list[str]:
    expressions = []
    for item in values or []:
        expressions += [part.strip().lower() for part in item.split(",") if part.strip()]
    for expression in expressions:
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", expression):
            raise Failure(f"'{expression}' is not a valid expression name")
    return expressions


def choose_engine(requested: str | None) -> str:
    import media_seedance as SD
    return requested or ("seedance" if SD.read_key() else "ltx")


def dry_run(args, engine: str, expressions: list[str], seed: int) -> dict:
    """Validate the dance request and price it. No Modal, no paid request, no key needed."""
    import media_seedance as SD
    out = Path(args.out).resolve() if args.out else None
    drawing_usd = 0.0 if args.from_still else 90 * S.ART_RATE
    cutout_usd = 90 * S.ART_RATE
    if engine == "ltx":
        return {"dryRun": True, "engine": "ltx", "keyPresent": bool(SD.read_key()),
                "costUsdEstimate": round(drawing_usd + 240 * S.MOTION_RATE + cutout_usd, 2),
                "note": "LTX runs on our own Modal graphics card; estimate from measured run times."}
    progress("check", 0.3, "Checking the dance service's public price list")
    http = SD.Http()
    model = SD.find_model(SD.catalogue(http))
    if out and (out / "keyframe.png").exists():
        keyframe = load_keyframe(out)
        key_name, _, picture = keyframe_on_backdrop(keyframe, tuple(int(v) for v in S.SEEDANCE_SIZES[args.resolution].split("x")))
    else:
        import numpy as np
        key_name, picture = "magenta", png_bytes(np.zeros((S.KEYFRAME_HEIGHT, S.KEYFRAME_WIDTH, 3), np.uint8))
    description = (args.prompt or "A person dancing").strip().rstrip(".")
    request = SD.build_request(motion_prompt(description, key_name), picture, args.resolution, seed)
    facts = SD.check_model(model, args.resolution)
    estimates = {resolution: float(SD.estimate_usd(model, resolution)) for resolution in S.SEEDANCE_SIZES}
    return {
        "dryRun": True, "engine": "seedance", "model": facts["canonical"], "resolution": args.resolution,
        "request": SD.describe_request(request), "usdPerVideoToken": facts["usdPerVideoToken"],
        "videoTokens": {r: float(SD.video_tokens(s)) for r, s in S.SEEDANCE_SIZES.items()},
        "seedanceUsdPerClip": estimates,
        "costUsdEstimate": round(estimates[args.resolution] + drawing_usd + cutout_usd, 2),
        "keyPresent": bool(SD.read_key()),
        "note": "Nothing was sent or paid. The real run needs OPENROUTER_API_KEY in the environment.",
    }


def generate(args: argparse.Namespace) -> dict:
    import media_finish as F
    import media_seedance as SD

    out = Path(args.out).resolve()
    expressions = parse_expressions(args.expressions)
    seed = args.seed if args.seed is not None else zlib.crc32(args.name.encode("utf-8")) % (2 ** 31)
    engine = choose_engine(args.engine)
    work = Path(args.work).resolve() if args.work else None
    ledger = {"usd": 0.0, "steps": []}
    started = time.monotonic()
    prompts = build_prompts(args.name, args.prompt, None, expressions)

    # Price check before anything is started.
    http = model = None
    dance_usd = 0.0
    if not args.stills_only:
        if engine == "seedance":
            key = SD.read_key()
            if not key:
                raise Failure("The Seedance dance step needs an OpenRouter key in OPENROUTER_API_KEY")
            http = SD.Http(key=key)
            progress("setup", 0.01, "Checking the dance service's price list")
            model = SD.find_model(SD.catalogue(SD.Http()))
            dance_usd = float(SD.estimate_usd(model, args.resolution))
        else:
            dance_usd = 420 * S.MOTION_RATE
    worst = (0 if args.from_still else 240 * S.ART_RATE) + dance_usd + (0 if args.stills_only else 240 * S.ART_RATE)
    if worst > args.max_cost:
        raise Failure(f"This dancer could cost up to ${worst:.2f}, above the allowed ${args.max_cost:.2f} (--max-cost)")
    out.mkdir(parents=True, exist_ok=True)

    # 1. Character picture (+ expressions), cut out and laid out.
    if args.from_still:
        keyframe = load_keyframe(out)
        progress("image", 0.2, "Using the existing character picture")
    else:
        progress("setup", 0.02, "Waking up the cloud computers")
        with cloud() as C:
            names = {entry.path.strip("/") for entry in C.art_weights.listdir("/")}
            if "ready.json" not in names:
                progress("setup", 0.04, "Downloading the drawing tools (first time only, takes a few minutes)")
                run_remote(C.prepare_art_weights, None, S.PREPARE_RATE, ledger, "download picture models")
            progress("image", 0.08, "Drawing the character")
            draw_request = {"prompt": prompts["image"], "seed": seed,
                            "expressions": {e: prompts[f"expression:{e}"] for e in expressions}}
            if args.like:
                draw_request["base"] = base_picture(Path(args.like), args.like_tint)
                draw_request["base_strength"] = args.like_strength
            drawn = remote_step(work, "draw", draw_request, lambda: run_remote(
                C.draw, draw_request, S.ART_RATE, ledger, "draw and cut out stills"))
        progress("image", 0.25, "Cutting the character out of the picture")
        keyframe = save_stills(out, drawn, expressions)

    if args.stills_only:
        cost = round(ledger["usd"], 2)
        append_ledger({"time": datetime.now(timezone.utc).isoformat(), "name": args.name, "out": str(out),
                       "seed": seed, "stillsOnly": True, "usd": round(ledger["usd"], 4), "steps": ledger["steps"]})
        return {"done": True, "stills": str(out / "still.png"), "costUsdEstimate": cost}

    # 2. Dance.
    if engine == "seedance":
        width, height = (int(v) for v in S.SEEDANCE_SIZES[args.resolution].split("x"))
    else:
        width, height = S.MOTION_WIDTH, S.MOTION_HEIGHT
    key_name, key_color, picture = keyframe_on_backdrop(keyframe, (width, height))
    prompts["motion"] = motion_prompt(args.prompt.strip().rstrip("."), key_name)
    if engine == "seedance":
        progress("motion", 0.3, "Sending the picture to the dance service (usually 1 to 4 minutes)")
        request = SD.build_request(prompts["motion"], picture, args.resolution, seed)

        def on_status(job):
            words = {"pending": "Waiting in the dance service's queue", "in_progress": "The dancer is being filmed",
                     "completed": "The dance is ready, downloading it"}
            progress("motion", 0.45 if job["status"] != "completed" else 0.6, words.get(job["status"], job["status"]))

        def dance():
            result = SD.make_clip(http, request, on_status=on_status)
            paid = result["costUsd"] if result["costUsd"] is not None else dance_usd
            ledger["steps"].append({"step": "dance (Seedance)", "seconds": result["seconds"], "usd": round(paid, 4),
                                    "job": result["job"], "reported": result["costUsd"] is not None})
            ledger["usd"] += paid
            return result
        moved = remote_step(work, "seedance", request, dance)
        models = S.model_records("seedance") + [S.seedance_record(model.get("canonical_slug", S.SEEDANCE_MODEL))]
        extra = {"engine": "seedance", "resolution": args.resolution, "job": moved["job"]}
    else:
        models = S.model_records("ltx")
        extra = {"engine": "ltx"}
        moved = None

    with cloud() as C:
        if moved is None:
            progress("motion", 0.3, "Teaching the character to dance (this is the slow part, about 3 to 5 minutes)")
            motion_request = {
                "keyframe": picture, "prompt": prompts["motion"], "negative_prompt": NEGATIVE,
                "seed": seed, "width": width, "height": height,
                "num_frames": S.MOTION_FRAMES, "settings": S.LTX_SETTINGS,
            }
            moved = remote_step(work, "dance", motion_request, lambda: run_remote(
                C.animate, motion_request, S.MOTION_RATE, ledger, "dance"))
            prompts["negative"] = NEGATIVE
        # 3. Cut the dancer out of every frame.
        progress("cutout", 0.7, "Removing the background from every frame")
        matted = remote_step(work, "cutout", moved["video"], lambda: run_remote(
            C.cut_out, moved["video"], S.ART_RATE, ledger, "cut out frames"))

    cost = round(ledger["usd"], 2)
    media_path = finish(out, moved["video"], matted["alpha"], key_color, keyframe, expressions, models, prompts,
                        cost, {**extra, "seed": seed, "backdropForCutout": key_name,
                               "seconds": round(time.monotonic() - started)})
    append_ledger({"time": datetime.now(timezone.utc).isoformat(), "name": args.name, "out": str(out),
                   "engine": engine, "seed": seed, "usd": round(ledger["usd"], 4), "steps": ledger["steps"]})
    return {"done": True, "media": str(media_path), "costUsdEstimate": cost}


def prepare() -> dict:
    ledger = {"usd": 0.0, "steps": []}
    progress("setup", 0.05, "Getting the cloud tools ready (first time can take 15 minutes)")
    with cloud() as C:
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
    parser.add_argument("--engine", choices=["seedance", "ltx"],
                        help="dance step; default seedance when OPENROUTER_API_KEY is set, otherwise ltx")
    parser.add_argument("--resolution", choices=sorted(S.SEEDANCE_SIZES), default="480p",
                        help="Seedance size (480p is already 720 pixels tall after shaping; 720p costs about 2.2x)")
    parser.add_argument("--dry-run", action="store_true", help="check the request and print the cost; spend nothing")
    parser.add_argument("--stills-only", action="store_true", help="make the pictures only, no dance")
    parser.add_argument("--from-still", action="store_true", help="dance the existing keyframe.png in --out")
    parser.add_argument("--like", help="re-dress the character from this other sequence folder (same person and pose)")
    parser.add_argument("--like-strength", type=float, default=0.7, help="how much --like may change (0.3 to 0.9)")
    parser.add_argument("--like-tint", help="repaint the --like picture in this colour first, e.g. #e6c2a0")
    parser.add_argument("--max-cost", type=float, default=1.5, help="refuse to start above this many US dollars")
    parser.add_argument("--prepare", action="store_true", help="download and check the tools only")
    parser.add_argument("--work", help="folder that keeps the raw paid results, so finishing can be redone for free")
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
        if args.stills_only and args.from_still:
            raise Failure("Choose either --stills-only or --from-still, not both.")
        expressions = parse_expressions(args.expressions)
        if args.dry_run:
            seed = args.seed if args.seed is not None else zlib.crc32((args.name or "").encode("utf-8")) % (2 ** 31)
            emit(**dry_run(args, choose_engine(args.engine), expressions, seed))
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
