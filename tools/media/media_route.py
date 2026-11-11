"""Which dance model can run on this Modal account, and why.

Looks only at small records in cloud storage (free, no machine is started) and at
Hugging Face's public page for LTX-2.5. The choice itself is plain Python so it can be
tested without any cloud:

  1. The owner's verified LTX-2.5 cache, if this account has it (used read-only, as before).
  2. Otherwise our own LTX-2.5 copy, made by `generate.py --prepare`.
  3. Otherwise Wan2.2, if it is prepared, with a plain note why.
  4. Otherwise nothing: say which command to run.
"""
from __future__ import annotations

import json
import os
import urllib.request

import media_settings as S

PREPARE_COMMAND = "python tools/media/generate.py --prepare"

# How generate.py tells the cloud module which LTX storage to use. The same values are
# handed to the cloud machines, so both sides describe exactly the same cloud objects.
CLOUD_LTX_VOLUME = "MEDIA_CLOUD_LTX_VOLUME"
CLOUD_LTX_READ_ONLY = "MEDIA_CLOUD_LTX_READ_ONLY"
CLOUD_HF_SECRET = "MEDIA_CLOUD_HF_SECRET"
NO_SECRET = "none"

NAMES = {"ltx": "LTX-2.5", "wan": "Wan2.2", "h3": "MiniMax H3", "openrouter": "a hosted OpenRouter model"}
H3_PREPARE_COMMAND = "python tools/media/generate.py --prepare --engine h3"
CLOUD_H3_VOLUME = "MEDIA_CLOUD_H3_VOLUME"
CLOUD_H3_READ_ONLY = "MEDIA_CLOUD_H3_READ_ONLY"
CLOUD_H3_ROOT = "MEDIA_CLOUD_H3_ROOT"
H3_SPEC_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "h3_files.json")


# --- records -----------------------------------------------------------------------------
def ltx_record_ok(record: dict | None) -> bool:
    """True if a ready.json describes exactly the pinned LTX-2.5 files."""
    if not isinstance(record, dict):
        return False
    if (record.get("repo_id"), record.get("revision"), record.get("status")) != (S.LTX_REPO, S.LTX_REVISION, "ready"):
        return False
    files = record.get("files") or {}
    for role, (filename, size, sha) in S.LTX_FILES.items():
        entry = files.get(role) or {}
        if (entry.get("filename"), entry.get("size"), entry.get("sha256")) != (filename, size, sha):
            return False
    return True


def wan_record_ok(record: dict | None) -> bool:
    return isinstance(record, dict) and (record.get("repo"), record.get("revision")) == (S.WAN_REPO, S.WAN_REVISION)


def art_record_ok(record: dict | None) -> bool:
    return isinstance(record, dict) and record.get("zimage") == [S.ZIMAGE_REPO, S.ZIMAGE_REVISION] \
        and record.get("birefnet") == [S.BIREFNET_REPO, S.BIREFNET_REVISION]


# --- looking at the account ----------------------------------------------------------------
class ModalAccount:
    """Free look-ups in the signed-in Modal account. Never creates or changes anything."""

    def read_json(self, volume: str, path: str) -> dict | None:
        import modal
        from modal.exception import NotFoundError
        try:
            data = b"".join(modal.Volume.from_name(volume).read_file(path))
        except (NotFoundError, FileNotFoundError):
            return None
        try:
            return json.loads(data.decode("utf-8-sig"))
        except ValueError:
            return None

    def file_sizes(self, volume: str, folder: str) -> dict | None:
        """Every file below `folder` with its size, or None if the volume or folder is not there."""
        import modal
        from modal.exception import NotFoundError
        try:
            entries = modal.Volume.from_name(volume).listdir(folder, recursive=True)
        except (NotFoundError, FileNotFoundError):
            return None
        prefix = folder.strip("/") + "/"
        return {entry.path[len(prefix):] if entry.path.startswith(prefix) else entry.path: entry.size
                for entry in entries if getattr(entry.type, "name", str(entry.type)) == "FILE"}

    def secret_exists(self, name: str) -> bool:
        import modal
        from modal.exception import NotFoundError
        try:
            modal.Secret.from_name(name).hydrate()   # only checks that it exists; the value is never fetched
        except NotFoundError:
            return False
        return True


def ltx_gated(timeout: float = 10.0) -> bool:
    """Does Hugging Face ask for a sign-in before LTX-2.5 can be downloaded? (public page, no key)"""
    url = f"https://huggingface.co/api/models/{S.LTX_REPO}/revision/{S.LTX_REVISION}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "media-tool"}),
                                    timeout=timeout) as response:
            return bool(json.loads(response.read()).get("gated"))
    except Exception:  # noqa: BLE001 - offline or changed page: fall back to what was checked by hand
        return S.LTX_GATED


def hf_secret_name(environ=os.environ) -> str:
    return (environ.get(S.ENV_HF_SECRET) or "").strip() or S.HF_SECRET_NAME


def own_ltx_volume(environ=os.environ) -> str:
    return (environ.get(S.ENV_LTX_VOLUME) or "").strip() or S.LTX_WEIGHTS_VOLUME


def inspect_account(account=None, gated=None, environ=os.environ) -> dict:
    """What this Modal account already has. Free: reads three small records and checks one name."""
    account = account or ModalAccount()
    ignore_cache = (environ.get(S.ENV_IGNORE_LTX_CACHE) or "").strip() == "1"
    own_volume = own_ltx_volume(environ)
    secret = hf_secret_name(environ)
    owner_cache = False if ignore_cache else ltx_record_ok(account.read_json(S.LTX_CACHE_VOLUME, "ready.json"))
    own_ltx = ltx_record_ok(account.read_json(own_volume, "ready.json"))
    state = {
        "ownerCache": owner_cache,
        "ignoreOwnerCache": ignore_cache,
        "ownLtx": own_ltx,
        "ownLtxVolume": own_volume,
        "wan": wan_record_ok(account.read_json(S.WAN_WEIGHTS_VOLUME, "ready.json")),
        "art": art_record_ok(account.read_json(S.ART_WEIGHTS_VOLUME, "ready.json")),
        "hfSecret": secret,
        "hfSecretPresent": account.secret_exists(secret),
        "ltxGated": False,
    }
    if not (owner_cache or own_ltx):   # only ask Hugging Face when it matters
        state["ltxGated"] = bool(gated() if callable(gated) else (ltx_gated() if gated is None else gated))
    return state


# --- the choice ---------------------------------------------------------------------------------
def ltx_where(state: dict) -> str | None:
    if state.get("ownerCache"):
        return "cache"
    if state.get("ownLtx"):
        return "own"
    return None


def cloud_settings(state: dict) -> dict:
    """Which storage the cloud module mounts for LTX-2.5, and which secret the download may use."""
    if ltx_where(state) == "cache":
        volume, read_only, secret = S.LTX_CACHE_VOLUME, "1", NO_SECRET
    else:
        volume, read_only = state.get("ownLtxVolume") or S.LTX_WEIGHTS_VOLUME, "0"
        secret = state["hfSecret"] if state.get("hfSecretPresent") else NO_SECRET
    return {CLOUD_LTX_VOLUME: volume, CLOUD_LTX_READ_ONLY: read_only, CLOUD_HF_SECRET: secret}


def sign_in_steps(secret: str, problem: str = "no-token") -> str:
    """Plain steps for giving the cloud a Hugging Face sign-in. Never contains a token."""
    first = {
        "no-token": "LTX-2.5 can only be downloaded with a free Hugging Face account that has accepted its licence.",
        "not-accepted": "The Hugging Face account in the Modal secret has not accepted the LTX-2.5 licence yet.",
        "bad-token": "Hugging Face did not accept the token in the Modal secret (it may be wrong or expired).",
    }.get(problem, "LTX-2.5 needs a Hugging Face sign-in.")
    return (f"{first} To fix it once: (1) sign in at huggingface.co (a free account is enough); "
            f"(2) open {S.LTX_PAGE} and accept the licence; "
            f"(3) make a token with read access at https://huggingface.co/settings/tokens; "
            f"(4) store it in Modal with: modal secret create {secret} HF_TOKEN=<your token> "
            f"(add --force to replace an old one); (5) run {PREPARE_COMMAND} again. "
            f"The token stays in your Modal account; this tool never reads or prints it.")


def ltx_missing_reason(state: dict) -> str:
    if state.get("ltxGated") and not state.get("hfSecretPresent"):
        return "it has not been downloaded, and downloading it needs a Hugging Face sign-in first. " + \
            sign_in_steps(state.get("hfSecret") or S.HF_SECRET_NAME)
    return f"it has not been downloaded yet. Run {PREPARE_COMMAND} once to get it."


def choose_route(requested: str | None, state: dict) -> dict:
    """Pick the dance model for one run. `requested` is None for the default route."""
    if requested == "h3":
        return choose_h3_route(state)
    where = ltx_where(state)
    ltx_from = {"cache": "the owner's existing copy (read-only)", "own": "this account's own copy"}.get(where)
    route = {"engine": None, "why": "", "whatToDo": None, "fallback": False, "ltxFrom": ltx_from}
    if requested == "openrouter":
        route.update(engine="openrouter", why="You asked for a hosted model through OpenRouter.")
    elif requested == "wan":
        extra = "" if state.get("wan") else " It is downloaded first (about 126 GB, about 13 minutes)."
        route.update(engine="wan", why="You asked for Wan2.2." + extra)
    elif where:
        what = "You asked for LTX-2.5" if requested == "ltx" else "LTX-2.5, the default, is ready"
        route.update(engine="ltx", why=f"{what}: it uses {ltx_from}.")
    elif requested == "ltx":
        route.update(why="LTX-2.5 is not ready on this Modal account: " + ltx_missing_reason(state),
                     whatToDo=PREPARE_COMMAND)
    elif state.get("wan"):
        route.update(engine="wan", fallback=True,
                     why="LTX-2.5 is not ready on this Modal account, so this dancer is made with Wan2.2 instead "
                         "(slower and about twice the price, but it works). LTX-2.5 is not ready because "
                         + ltx_missing_reason(state))
    else:
        plan = prepare_plan(state)
        route.update(why="No dance model is ready on this Modal account yet.",
                     whatToDo=f"Run {PREPARE_COMMAND} once first ({plan['summary']}).")
    return route


# --- what --prepare will do ---------------------------------------------------------------------------
def _step(key: str, label: str) -> dict:
    seconds = S.PREPARE_SECONDS[key]
    return {"model": label, "gb": S.PREPARE_GB[key], "minutes": round(seconds / 60),
            "usd": round(seconds * S.PREPARE_RATES[key], 3)}


def prepare_plan(state: dict) -> dict:
    """What --prepare downloads on this account, with size, time and cost, before anything starts."""
    steps, ready = [], []
    if state.get("art"):
        ready.append("picture and cut-out models")
    else:
        steps.append(_step("art", "picture and cut-out models"))
    where = ltx_where(state)
    ltx_note = None
    if where == "cache":
        ready.append("LTX-2.5 (the owner's existing copy, used read-only)")
    elif where == "own":
        ready.append("LTX-2.5")
    else:
        step = _step("ltx", "LTX-2.5 dance model (default)")
        if state.get("ltxGated") and not state.get("hfSecretPresent"):
            step["needsSignIn"] = True
            ltx_note = sign_in_steps(state.get("hfSecret") or S.HF_SECRET_NAME)
        steps.append(step)
    if state.get("wan"):
        ready.append("Wan2.2")
    else:
        steps.append(_step("wan", "Wan2.2 dance model (also the fallback)"))
    gb = round(sum(step["gb"] for step in steps), 1)
    minutes = sum(step["minutes"] for step in steps)
    usd = round(sum(step["usd"] for step in steps) + (S.SOFTWARE_BUILD_USD if steps else 0) + 0.02, 2)
    if steps:
        summary = (f"about {gb:.0f} GB to download into your own Modal storage, about {minutes} minutes, "
                   f"about ${usd:.2f} of cloud time")
    else:
        summary = "everything is already downloaded; it only checks the tools, under $0.05"
    return {"downloads": steps, "alreadyReady": ready, "downloadGb": gb, "minutes": minutes,
            "usdEstimate": usd, "summary": summary, "ltxSignIn": ltx_note}


# --- MiniMax H3 (optional, never the default) ------------------------------------------------------
def h3_spec() -> dict:
    with open(H3_SPEC_PATH, encoding="utf-8") as stream:
        return json.load(stream)


def h3_sizes_ok(sizes: dict | None) -> bool:
    """True if a folder listing holds every pinned FL2VA file at its pinned size."""
    if not sizes:
        return False
    return all(sizes.get(name) == size for name, (size, _digest) in h3_spec()["files"].items())


def h3_record_ok(record: dict | None) -> bool:
    return isinstance(record, dict) and record.get("status") == "ready" and \
        (record.get("repo"), record.get("revision"), record.get("folder")) == (S.H3_REPO, S.H3_REVISION, S.H3_FOLDER)


def inspect_h3(account=None) -> dict:
    """Is there a usable MiniMax H3 copy? Free look-ups only; asked only when H3 is wanted."""
    account = account or ModalAccount()
    owner = h3_sizes_ok(account.file_sizes(S.H3_CACHE_VOLUME, f"{S.H3_CACHE_ROOT}/{S.H3_FOLDER}"))
    own = h3_record_ok(account.read_json(S.H3_WEIGHTS_VOLUME, "ready.json"))
    return {"h3OwnerCopy": owner, "h3Own": own}


def h3_where(state: dict) -> str | None:
    if state.get("h3OwnerCopy"):
        return "cache"
    if state.get("h3Own"):
        return "own"
    return None


def h3_cloud_settings(state: dict) -> dict:
    if h3_where(state) == "cache":
        return {CLOUD_H3_VOLUME: S.H3_CACHE_VOLUME, CLOUD_H3_READ_ONLY: "1", CLOUD_H3_ROOT: S.H3_CACHE_ROOT}
    return {CLOUD_H3_VOLUME: S.H3_WEIGHTS_VOLUME, CLOUD_H3_READ_ONLY: "0", CLOUD_H3_ROOT: S.H3_REVISION}


def h3_prepare_plan(state: dict) -> dict:
    where = h3_where(state)
    if where == "cache":
        usd = round(300 * S.H3_CHECK_RATE + 0.01, 2)
        return {"download": False, "gb": 0, "minutes": 5, "usdEstimate": usd,
                "summary": f"nothing to download: the owner's existing copy is used read-only; every checksum "
                           f"is checked, about 5 minutes, about ${usd:.2f}"}
    if where == "own":
        return {"download": False, "gb": 0, "minutes": 0, "usdEstimate": 0.0, "summary": "MiniMax H3 is ready"}
    seconds = S.PREPARE_SECONDS["h3"]
    usd = round(seconds * S.PREPARE_RATES["h3"] + 0.05, 2)
    return {"download": True, "gb": S.PREPARE_GB["h3"], "minutes": round(seconds / 60), "usdEstimate": usd,
            "summary": f"about {S.PREPARE_GB['h3']:.0f} GB to download into your own Modal storage, about "
                       f"{round(seconds / 60)} minutes, about ${usd:.2f} of cloud time"}


def choose_h3_route(state: dict) -> dict:
    where = h3_where(state)
    route = {"engine": None, "why": "", "whatToDo": None, "fallback": False, "ltxFrom": None}
    if where:
        source = {"cache": "the owner's existing copy (read-only)", "own": "this account's own copy"}[where]
        route.update(engine="h3", why=f"You asked for MiniMax H3: it uses {source}.")
    else:
        plan = h3_prepare_plan(state)
        route.update(why="MiniMax H3 is not ready on this Modal account.",
                     whatToDo=f"Run {H3_PREPARE_COMMAND} once first ({plan['summary']}).")
    return route
