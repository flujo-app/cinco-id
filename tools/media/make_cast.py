"""Make the dance loops for the whole demo cast from its existing still pictures.

    python tools/media/make_cast.py --engine seedance [--resolution 480p|720p] [--yes]
    python tools/media/make_cast.py --stills [--yes]        # (re)make the still pictures only

Without --yes it only prints what it would do and what it would cost, and spends nothing.
With --yes it runs tools/media/generate.py once per sequence and stops at the first failure.
The Seedance engine needs the owner's key in the OPENROUTER_API_KEY environment variable.
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


def plan(engine: str, resolution: str, stills: bool) -> list[dict]:
    root, cast = load_cast()
    if stills:
        each = 90 * S.ART_RATE
    elif engine == "seedance":
        import media_seedance as SD
        model = SD.find_model(SD.catalogue(SD.Http()))      # public price list, no key sent
        each = float(SD.estimate_usd(model, resolution)) + 90 * S.ART_RATE
    else:
        each = 240 * S.MOTION_RATE + 90 * S.ART_RATE
    steps = []
    for entry in cast:
        folder = root / Path(entry["id"])
        ready = (folder / "keyframe.png").exists()
        steps.append({"id": entry["id"], "name": entry["name"], "out": str(folder), "ready": ready or stills,
                      "costUsdEstimate": round(each, 3)})
    return steps


def command(entry: dict, folder: Path, engine: str, resolution: str, stills: bool, max_cost: float) -> list[str]:
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
    return args + ["--from-still", "--engine", engine, "--resolution", resolution]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", choices=["seedance", "ltx"], default="seedance")
    parser.add_argument("--resolution", choices=sorted(S.SEEDANCE_SIZES), default="480p")
    parser.add_argument("--stills", action="store_true", help="make the still pictures instead of the dances")
    parser.add_argument("--yes", action="store_true", help="really do it (this spends money)")
    args = parser.parse_args(argv)
    try:
        steps = plan(args.engine, args.resolution, args.stills)
    except Exception as error:  # noqa: BLE001
        emit(error=f"Could not prepare the plan: {error}")
        return 1
    total = round(sum(step["costUsdEstimate"] for step in steps), 2)
    what = "still pictures" if args.stills else f"{args.engine} dance loops" + (
        f" at {args.resolution}" if args.engine == "seedance" else "")
    emit(plan=what, sequences=steps, totalUsdEstimate=total)
    missing = [step["id"] for step in steps if not step["ready"]]
    if missing:
        emit(error=f"These sequences have no keyframe.png yet; run with --stills first: {', '.join(missing)}")
        return 1
    if not args.yes:
        emit(dryRun=True, message=f"Nothing was done. Add --yes to make the {what} for about ${total:.2f}.")
        return 0
    if args.engine == "seedance" and not args.stills:
        import media_seedance as SD
        if not SD.read_key():
            emit(error="Set the OPENROUTER_API_KEY environment variable first; nothing was spent.")
            return 1
    root, cast = load_cast()
    for entry, step in zip(cast, steps):
        emit(sequence=entry["id"], message=f"Starting {entry['name']}")
        process = subprocess.Popen(command(entry, root / Path(entry["id"]), args.engine, args.resolution,
                                           args.stills, step["costUsdEstimate"] * 1.5 + 0.25),
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
    emit(done=True, message=f"All {len(cast)} sequences finished.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
