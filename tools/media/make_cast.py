"""Make the dance loops for the whole demo cast from its existing still pictures.

    python tools/media/make_cast.py [--engine ltx|wan|openrouter] [--model <id>] [--resolution 480p] [--yes]
    python tools/media/make_cast.py --stills [--yes]        # (re)make the still pictures only

Without --yes it only prints what it would do and what it would cost, and spends nothing.
With --yes it runs tools/media/generate.py once per sequence and stops at the first failure.
The default engine runs on our own Modal account. OpenRouter needs the owner's key in OPENROUTER_API_KEY.
Prints one JSON object per line.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import media_settings as S  # noqa: E402

REPO_ROOT = HERE.parent.parent
CAST = HERE / "cast.json"


def emit(**fields) -> None:
    print(json.dumps(fields, ensure_ascii=False), flush=True)


def load_cast() -> tuple[Path, list[dict]]:
    data = json.loads(CAST.read_text(encoding="utf-8"))
    return REPO_ROOT / data["project"] / "sequences", data["sequences"]


def plan(engine: str, resolution: str, stills: bool, model_id: str = S.SEEDANCE_MODEL) -> list[dict]:
    root, cast = load_cast()
    if stills:
        each = 90 * S.ART_RATE
    elif engine in ("openrouter", "seedance"):
        import media_hosted as SD
        model = SD.find_model(SD.catalogue(SD.Http()), model_id)      # public price list, no key sent
        each = float(SD.plan_clip(model, resolution)["usd"]) + 90 * S.ART_RATE
    else:
        each = S.MODAL_DANCE_SECONDS[engine] * S.MOTION_RATE + 90 * S.ART_RATE
    steps = []
    for entry in cast:
        folder = root / Path(entry["id"])
        ready = (folder / "keyframe.png").exists()
        steps.append({"id": entry["id"], "name": entry["name"], "out": str(folder), "ready": ready or stills,
                      "costUsdEstimate": round(each, 3)})
    return steps


def command(entry: dict, folder: Path, engine: str, resolution: str, stills: bool, max_cost: float,
            model_id: str = S.SEEDANCE_MODEL) -> list[str]:
    args = [sys.executable, str(HERE / "generate.py"), "--name", entry["name"], "--prompt", entry["prompt"],
            "--out", str(folder), "--seed", str(entry["seed"]), "--max-cost", f"{max_cost:.2f}"]
    for expression in entry.get("expressions", []):
        args += ["--expressions", expression]
    if stills:
        if entry.get("like"):
            args += ["--like", str(load_cast()[0] / Path(entry["like"])),
                     "--like-strength", str(entry.get("likeStrength", 0.7))]
            if entry.get("likeTint"):
                args += ["--like-tint", entry["likeTint"]]
        return args + ["--stills-only"]
    args += ["--from-still", "--engine", engine]
    if engine in ("openrouter", "seedance"):
        args += ["--model", model_id, "--resolution", resolution]
    return args


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", choices=["wan", "ltx", "openrouter", "seedance"], default=S.DEFAULT_ENGINE)
    parser.add_argument("--model", default=S.SEEDANCE_MODEL, help="OpenRouter catalogue id for --engine openrouter")
    parser.add_argument("--resolution", default="480p", help="OpenRouter size name, checked against the catalogue")
    parser.add_argument("--only", help="comma-separated sequence ids to do, e.g. tayne/nude,oyster")
    parser.add_argument("--stills", action="store_true", help="make the still pictures instead of the dances")
    parser.add_argument("--yes", action="store_true", help="really do it (this spends money)")
    args = parser.parse_args(argv)
    try:
        steps = plan(args.engine, args.resolution, args.stills, args.model)
        if args.only:
            wanted = {item.strip() for item in args.only.split(",")}
            steps = [step for step in steps if step["id"] in wanted]
    except Exception as error:  # noqa: BLE001
        emit(error=f"Could not prepare the plan: {error}")
        return 1
    total = round(sum(step["costUsdEstimate"] for step in steps), 2)
    hosted = args.engine in ("openrouter", "seedance")
    what = "still pictures" if args.stills else f"{args.engine} dance loops" + (
        f" with {args.model} at {args.resolution}" if hosted else "")
    emit(plan=what, sequences=steps, totalUsdEstimate=total)
    missing = [step["id"] for step in steps if not step["ready"]]
    if missing:
        emit(error=f"These sequences have no keyframe.png yet; run with --stills first: {', '.join(missing)}")
        return 1
    if not args.yes:
        emit(dryRun=True, message=f"Nothing was done. Add --yes to make the {what} for about ${total:.2f}.")
        return 0
    if hosted and not args.stills:
        import media_hosted as SD
        if not SD.read_key():
            emit(error="Set the OPENROUTER_API_KEY environment variable first; nothing was spent.")
            return 1
    root, cast = load_cast()
    by_id = {entry["id"]: entry for entry in cast}
    for step in steps:
        entry = by_id[step["id"]]
        emit(sequence=entry["id"], message=f"Starting {entry['name']}")
        process = subprocess.Popen(command(entry, root / Path(entry["id"]), args.engine, args.resolution,
                                           args.stills, step["costUsdEstimate"] * 1.5 + 0.25, args.model),
                                   stdout=subprocess.PIPE, text=True, encoding="utf-8", cwd=REPO_ROOT)
        last = {}
        for line in process.stdout:
            try:
                last = json.loads(line)
            except ValueError:
                continue
            emit(sequence=entry["id"], **last)
        if process.wait() != 0 or "error" in last:
            emit(error=f"{entry['name']} failed; stopped here so nothing else is spent.")
            return 1
    emit(done=True, message=f"All {len(steps)} sequences finished.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
