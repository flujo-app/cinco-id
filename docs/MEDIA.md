# Media generator

The media generator makes the see-through dancing clips and still pictures that the computer shows instead of
the simple drawn puppets. It writes exactly the files described in [PROJECTS.md](PROJECTS.md). The finished demo
cast is already in the repository, so nobody needs any account or key to enjoy the demo.

## Three ways to make the dance

| | Self-hosted on Modal (default) | MiniMax through OpenRouter | Seedance through OpenRouter |
|---|---|---|---|
| What it is | Open video model on our own rented cloud graphics card: **LTX-2.5** (default), **Wan2.2** or **MiniMax H3** | `minimax/hailuo-3-max`, a hosted model, paid per clip | `bytedance/seedance-2.5`, a hosted model, paid per clip |
| What you need | A Modal account (`modal setup`); for LTX-2.5 also a free Hugging Face sign-in (without it, Wan2.2 is used) | Modal account + an OpenRouter key | Modal account + an OpenRouter key |
| Cost per new dancer | **about $0.35** with LTX, about $0.80 with Wan, about $0.78 with MiniMax H3 (measured) | about **$0.31** at 480p, $0.46 at 768p (computed) | about **$0.59** at 480p, $1.23 at 720p (computed) |
| Time per new dancer | about 6 minutes with LTX, 10 with Wan, 12 with MiniMax H3 | not measured | not measured |
| Tried for real | Yes | No paid test: the request is checked against the live catalogue only | No paid test: the request is checked against the live catalogue only |

Pictures and background removal always run on Modal with pinned open models, whichever dance route you pick.
The "cost per new dancer" above includes those Modal steps (drawing about $0.03, cut-out about $0.03).

**Why OpenRouter is not the default:** ByteDance and MiniMax do not let anyone run these two hosted models
themselves, and the owner wants new dancers to be possible without an OpenRouter account. The OpenRouter key is
read **only** from the `OPENROUTER_API_KEY` environment variable, which the owner sets when he wants to use it.

## How a dancer is made

1. **Draw the character.** Z-Image-Turbo draws a realistic, invented person standing in a ready-to-dance pose
   on a plain grey backdrop, in an early-1990s public-access TV look. Expression pictures (`smiling`) are redrawn
   from that picture with a small change. A variant can be "re-dressed" from another sequence's picture
   (`--like`), which keeps the same face, build, pose and hat.
2. **Cut it out.** BiRefNet finds the figure. The cut-out is cleaned (haze, specks and backdrop-coloured edges
   removed) and placed on a 3:4 portrait canvas with empty space around it and the feet always at the same height.
   This becomes `keyframe.png` (full size, 834 by 1112) and `still.png` (540 by 720).
3. **Choose a backdrop colour.** The figure is put on a flat **grey** backdrop unless more than a quarter of it is
   close to grey; then blue, green, magenta, orange or white, whichever the figure does not contain. Grey comes
   first because video models paint a thin halo in the opposite colour next to a bright backdrop (yellow-green
   fingertips beside magenta) and mirror bright backdrops in shiny cloth (rainbow streaks on satin). The cut-out
   model works on shapes, not colour contrast, so grey works even behind a grey satin shirt. `--backdrop` forces
   a colour.
4. **Dance (the loop trick).** The video model gets that same picture as the **first and the last frame**, so the
   dance ends in the pose it started in. That is what makes the loop seamless. All three routes use this trick.
5. **Cut out every frame.** BiRefNet again, then: everything well inside the outline counts as solid (so shiny
   cloth that mirrors the backdrop is not stained), pixels clearly unlike the backdrop are kept solid, specks are
   dropped, the outline is pulled in by one pixel, and the soft outer edge takes its colour from the solid figure
   right next to it, so no backdrop colour or halo can show at the edge.
6. **Loop.** The repeated last frame is dropped. If the jump from last to first frame is still clearly bigger
   than an ordinary frame-to-frame step, the last six frames are blended into the first ones. `--crossfade N`
   forces such a blend. It was tried on Oyster (motion-blurred last frames, sharp first frame) and rejected: when
   the figure moves fast the blend shows double images, which looks worse than the small sharpness jump. None of
   the shipped clips needed a blend.
7. **Save.** `loop.webm` (VP9 with a see-through background, `yuva420p`), the stills and `media.json` (written
   last). `hatLine` is measured from the cut-out on the still and on every sixth frame of the clip, so the hat
   stays above it in nearly every frame. This works well for wide hats; for a bare head it tends to land at the
   shoulders, so check it by eye. The folder is then checked against the contract.

## Comparison on the same Tayne picture (2026-11-11)

Both clips came from the identical picture, prompt and seed. Frames were inspected full size.

| | LTX-2.5 (chosen) | Wan2.2 A14B, normal prompt | Wan2.2 A14B, "big energetic" prompt |
|---|---|---|---|
| Movement | A clear strut: hips, shoulders and steps | Barely moves, a small sway (about a quarter of LTX's movement) | Big moves, but falls apart |
| Face and hands | Natural; fingers a little soft | Crisper and the most natural | Face smears in fast moves |
| Hat | Stays on, wobbles with the head | Stays on | Slides off and drops, which ruins "hat wobble" |
| Fabric | Sequins a little glossy and smooth | Sharpest sequins | Smeared in crouches |
| Clean cut-out | Yes (after the edge clean-up above) | Yes | Mostly; motion blur at the edges |
| Smoothness | 24 frames per second | 16 frames per second | 16 frames per second |
| Graphics-card time | 174 s, **$0.28** | 460 s, $0.74 | 448 s, $0.72 |

**Verdict:** LTX-2.5 gives the best dancing for the joke at well under half the cost, so it is the default.
Wan2.2 stays available (`--engine wan`) because it looks a little more lifelike when the moves are small.
A Seedance or hosted MiniMax (OpenRouter) clip was not made, because no paid OpenRouter request was allowed in
this work (the self-hosted MiniMax H3 was tried later, see below); the owner
can make the same comparison with one command (see "Making the cast").

## MiniMax H3 (optional, `--engine h3`): test result (2026-11-11)

MiniMax published open weights, `MiniMaxAI/MiniMax-H3`. Its licence is the
[MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/0919fb684102ef115126612f3fbb84d1027e7317/LICENSE),
which has its own regional terms; the owner has read them and accepted the licence for this project. Only the
first-and-last-frame part (`FL2VA/`, 144 GB, 81 files) is needed: a 33-billion-parameter video model, a
Qwen3-VL-32B text reader, a video decoder and a sound decoder.

**How it runs.** With the official SGLang server (the image `lmsysorg/sglang`, pinned by its digest, SGLang
0.5.21), which MiniMax names as its recommended way to run the model. MiniMax's own example uses 4 graphics cards;
reading the SGLang code showed that one H200 is enough when the card has at least 120 GiB free: everything (about
110 GiB) stays on the card, peak 122.9 GB measured. The server starts inside the cloud machine, makes one clip
from the same picture as first and last frame, and is stopped again. The sound it also makes is dropped.

**One Tayne loop**, from Tayne's own picture, description and seed 9002, at 768 by 1024 pixels, 4 seconds asked,
50 steps, grey backdrop, then the normal cut-out, loop and see-through steps. The request uses the layout of
MiniMax's own prompt guide for first-and-last-frame clips. It worked the first time.

| | LTX-2.5 (the Tayne shipped then, in teal sequins) | MiniMax H3 (test) |
|---|---|---|
| Movement | A clear strut: hips, shoulders and steps | A bouncy dance on the spot: arm pumps and knee bends; about 70% of LTX's movement (measured from the outline) |
| Face and hands | Natural; fingers a little soft; a pink speck on a fingertip in some frames | Natural and steady; hands mostly loose fists, clean, no coloured specks |
| Hat | Stays on, wobbles with the head | Stays on, wobbles a little |
| Fabric | Sequins glossy and smooth | Crisper, more real sequin sparkle; boot laces visible |
| Cut-out and loop | Clean; no visible seam | Clean; no visible seam (the jump back is a quarter of a normal frame step) |
| Length | 4.0 s, 96 frames, 24 per second | 4.4 s, 106 frames, 24 per second |
| Graphics-card time | 174 s | 436 s: 238 s starting and loading, 180 s making the clip (3.5 s per step), the rest decoding |
| Cost of the dance | $0.28 | **$0.72** |
| Cost per new dancer | about $0.35 | **about $0.78** (picture $0.03, dance $0.72, cut-out $0.03) |

Things that make the comparison not perfectly even: the Tayne shipped then was made on a magenta backdrop (before the
grey-backdrop rule), which caused its fingertip speck; the H3 test used grey. SGLang hands the clip back as a
compressed H.264 file (about 0.8 Mbit/s) where LTX hands back every frame without loss; no blockiness was visible
at the final 540 by 720 size.

**Verdict:** MiniMax H3 looks a little more lifelike in the details (sequins, boots, clean hands), but it dances a
bit less, takes two and a half times the graphics-card time and costs over twice as much per dancer, and needs
144 GB of model files. LTX-2.5 stays the default. H3 can be chosen with `--engine h3` when the details matter more
than the price. The test files (the H3 loop, a still, a side-by-side video and H3's own clip with its sound) were
given to the owner outside the repository; the Tayne shipped then was not changed.

**Using it:**

```powershell
python tools/media/generate.py --prepare --engine h3        # once: checks or downloads the 144 GB
python tools/media/generate.py --name "Tayne" --prompt "..." --out <folder> --engine h3
```

- On the owner's account the files are already there: another of his projects has exactly this `FL2VA` folder in
  the volume `savia-spot-minimax-h3-42ed227e` (made at revision `42ed227e`, whose 81 `FL2VA` files are
  byte-for-byte the same as the pinned revision; MiniMax only changed the readme in between). It is mounted
  **read-only** and never written. `--prepare --engine h3` reads every byte and compares all 81 checksums with the
  pins (176 s, $0.03); every H3 run checks sizes and the copy's own download records again.
- On any other account `--prepare --engine h3` downloads the 81 files into `beta-sequence-h3-weights` and checks
  them: 144 GB, estimated 18 minutes and $0.20 (not measured, the owner did not need it). No sign-in is needed.
- One H3 machine is limited to 700 seconds, so a single dance can never cost more than $1.16. Like everything
  else it stops by itself, never retries and leaves nothing running.

## Models (pinned)

| Role | Model | Revision | Licence |
|---|---|---|---|
| Picture | [`Tongyi-MAI/Z-Image-Turbo`](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | `f332072aa78be7aecdf3ee76d5c247082da564a6` | Apache-2.0 |
| Cut-out | [`ZhengPeng7/BiRefNet-matting`](https://huggingface.co/ZhengPeng7/BiRefNet-matting) | `eccde0a8cbdce7ac5fecfeb06340fe7b949e85d9` | MIT |
| Dance (default) | [`Lightricks/LTX-2.5`](https://huggingface.co/Lightricks/LTX-2.5) with code [`Lightricks/LTX-2`](https://github.com/Lightricks/LTX-2) at `a95ab856bf29407b6b066ede0abe1846050db56c` | `5e6e71018ee1756ed329b697a7b4aedc934dfce9` | LTX-2.x Community License: free for people and companies under USD 10M yearly revenue and for hobby use; published outputs must be marked as machine-made |
| Dance (option) | [`Wan-AI/Wan2.2-I2V-A14B-Diffusers`](https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B-Diffusers) | `596658fd9ca6b7b71d5057529bbf319ecbc61d74` | Apache-2.0 |
| Dance (option) | [`MiniMaxAI/MiniMax-H3`](https://huggingface.co/MiniMaxAI/MiniMax-H3), folder `FL2VA`, run with the official SGLang image `lmsysorg/sglang@sha256:b1259f3ea3275f66237c498ea388919729018bc9f01c3d638391e06e2cf3f469` | `0919fb684102ef115126612f3fbb84d1027e7317` | [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/0919fb684102ef115126612f3fbb84d1027e7317/LICENSE) (accepted by the owner) |
| Music | [`ACE-Step/acestep-v15-xl-turbo-diffusers`](https://huggingface.co/ACE-Step/acestep-v15-xl-turbo-diffusers), run with `diffusers` 0.42.1 (see "Music" below) | `200ba991ae448051e14b0183157e35c2d27c9fb0` | MIT (its text encoder, Qwen3-Embedding-0.6B, Apache-2.0) |

All weights come from the publisher's or author's own account. Every large file is checked against its published
SHA-256 checksum when it is downloaded (Wan's 30 files are listed in `tools/media/wan_files.json`, LTX's six in
`LTX_FILES` in `tools/media/media_settings.py`, MiniMax H3's 81 in `tools/media/h3_files.json`). On the owner's Modal account, LTX's six files (74.5 GiB) are read
**read-only** from a verified cache volume of another of his projects (`morriton-ltx-2-5-model-cache`), so they are
not downloaded twice; the code checks the cache's checksum record against the pins. On any other Modal account,
`--prepare` downloads the same six files into this project's own volume `beta-sequence-ltx-weights` and checks
each checksum (see "First time on your own Modal account"). `media.json` records each model, revision and licence
in `provenance.models`, the hosted model (if one was used) by its dated catalogue name, and marks the media as
machine-made.

## Which dance model a run uses

The default route picks, in this order, and says which and why at the start of every run:

1. **LTX-2.5 from the owner's cache**, if this Modal account has it (only the owner's does). Used read-only.
2. **LTX-2.5 from this account's own copy** (`beta-sequence-ltx-weights`), once `--prepare` has downloaded it.
3. **Wan2.2**, if it is prepared but LTX-2.5 is not. The run says so in plain words, including what to do to get
   LTX-2.5 (usually: the Hugging Face sign-in below). Wan2.2 is slower and costs about $0.80 instead of $0.35.
4. **Nothing ready:** the run stops before spending anything and says to run `python tools/media/generate.py
   --prepare` first, with its size, time and cost.

`--engine ltx` or `--engine wan` asks for one model by name; `--engine ltx` then never switches to Wan. Asking for
Wan when it is not downloaded yet downloads it first, as before. `--engine h3` (MiniMax H3) is only ever used
when asked for; without its files the run stops and names `--prepare --engine h3`. `--dry-run` shows the choice for this account
without spending anything (it only reads a few small records in the Modal account).

For testing only: `MEDIA_IGNORE_LTX_CACHE=1` makes the tool act as if the owner's cache was not there, and
`MEDIA_LTX_VOLUME=<name>` uses another name for the project's own LTX volume. Together they let the owner try the
stranger's path on his own account without touching his cache.

## Cloud storage and what it costs

| Volume | What is in it | Size (measured) |
|---|---|---|
| `beta-sequence-art-weights` | picture and cut-out models | 31.4 GiB |
| `beta-sequence-wan-weights` | Wan2.2 | 117.5 GiB |
| `beta-sequence-ltx-weights` | LTX-2.5, only on accounts without the owner's cache | 74.5 GiB (the six pinned files) |
| `beta-sequence-h3-weights` | MiniMax H3, only if prepared on an account without the owner's copy | 134.2 GiB (the 81 pinned files) |
| `savia-spot-minimax-h3-42ed227e` | MiniMax H3 on the owner's account; belongs to another project, only read | 134.2 GiB (not ours, not counted below) |
| `beta-sequence-music-weights` | ACE-Step 1.5 XL Turbo and the singing check, for `make_music.py` | 10.4 GiB (11.1 GB model + 80 MB check) |

**Price** ([modal.com/pricing](https://modal.com/pricing), read 2026-11-11): stored files cost $0.09 per GiB per month,
and the **first 1 TiB per month is free** for the whole Modal workspace. So these volumes cost **nothing** while the
workspace stays under 1 TiB in total. Above that, the owner's two volumes would cost about **$13.40 a month**
together; with LTX-2.5 as well (about 223 GiB in all) about **$20.10 a month**; an own MiniMax H3 copy would add
about $12.10 a month.

**Between dancers nothing else costs money.** No machine keeps running: every cloud machine is started for one
step and stopped right after it. The only standing cost is the storage above.

**Deleting the stored files** (for example to stay under the free 1 TiB):

```powershell
modal volume delete beta-sequence-wan-weights      # Wan2.2
modal volume delete beta-sequence-art-weights      # picture and cut-out models
modal volume delete beta-sequence-ltx-weights      # LTX-2.5 (only if you prepared your own)
modal volume delete beta-sequence-h3-weights       # MiniMax H3 (only if you prepared your own)
modal volume delete beta-sequence-music-weights    # the music model (only needed to make new music)
```

Never delete `morriton-ltx-2-5-model-cache` or `savia-spot-minimax-h3-42ed227e`: they belong to other projects.
The drawback of deleting is the download next time:

- Picture models: the next new dancer downloads them again by itself, about 5 minutes (282 s measured) and
  about $0.01, before drawing.
- Wan2.2: downloaded again by `--prepare` or by a run with `--engine wan`, about 13 minutes (754 s measured) and
  about $0.07. On the owner's account the default route does not need it (it uses LTX-2.5 from the cache).
- LTX-2.5 (own copy): downloaded again by `--prepare`, about 80 GB, estimated 10 minutes and $0.05; it needs the
  Hugging Face sign-in. Until then the default route uses Wan2.2 if that is there.
- MiniMax H3 (own copy): downloaded again by `--prepare --engine h3`, 144 GB, estimated 18 minutes and $0.20.

**What a new dancer costs each time:** about $0.35 with LTX-2.5 (about 6 minutes), about $0.80 with Wan2.2
(about 10 minutes) or about $0.78 with MiniMax H3 (about 12 minutes), pictures and cut-out included; about $0.28 with LTX-2.5 when only the dance is made from an
existing picture (`--from-still`, measured). Run times and prices are in "Cost details" below.

## Setup (once)

Needs Python 3.12 or newer with `modal`, `numpy` and `Pillow`, `ffmpeg`/`ffprobe` on the PATH, and a signed-in
Modal profile. On Windows set `PYTHONUTF8=1`.

```powershell
pip install modal numpy Pillow
$env:PYTHONUTF8 = "1"
python tools/media/generate.py --prepare
```

`--prepare` builds the cloud software, downloads whatever this Modal account does not have yet (picture and
cut-out models, LTX-2.5, Wan2.2; checksums verified) and checks every toolset without using a graphics card. It
first prints how much it will download, how long that takes and what it costs. Finished steps are skipped when it
is run again. `python tools/media/generate.py --prepare --dry-run` prints that plan and spends nothing.

## First time on your own Modal account

Anyone can make new dancers with their own Modal account; nothing of the owner's is needed.

1. Install the tools above and sign in to Modal once: `modal setup`.
2. For LTX-2.5 (the better and cheaper dance model), give the cloud a Hugging Face sign-in once. LTX-2.5's
   publisher asks every downloader to accept its licence (free for people and companies under USD 10 million
   yearly revenue):
   - sign in at [huggingface.co](https://huggingface.co) (a free account is enough),
   - open [huggingface.co/Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) and accept the licence,
   - make a token with read access at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens),
   - store it in Modal (this is Modal's usual way of keeping such tokens):
     `modal secret create beta-sequence-huggingface HF_TOKEN=<your token>`.
     To use a secret you already have under another name, set `MEDIA_HF_SECRET=<that name>`.
   The token stays in your Modal account. The tool only checks that the secret exists; it never reads, prints or
   stores the token. You can skip this step: then Wan2.2 is used instead, and `--prepare` explains what to do.
3. Run `python tools/media/generate.py --prepare` once:

   | | Size | Time | Cloud cost |
   |---|---|---|---|
   | Picture and cut-out models | 34 GB | about 5 minutes (measured) | about $0.01 |
   | LTX-2.5 | 80 GB | about 10 minutes (estimate; the checksum part measured 4 minutes) | about $0.05 |
   | Wan2.2 | 126 GB | about 13 minutes (measured) | about $0.07 |
   | Building the cloud software, checks | | about 10 minutes | about $0.12 |
   | **Total** | **240 GB** | **about 40 minutes** | **about $0.25** |

   The files then sit in your own Modal storage, free under 1 TiB (see "Cloud storage and what it costs").
4. Make dancers as below. Each new dancer costs about $0.35 with LTX-2.5, about $0.80 with Wan2.2.

## Making a dancer

```powershell
python tools/media/generate.py --name "Tayne" `
  --prompt "Tayne: a slim man around forty ... wearing a black flat-brimmed hat ... Dance: a wide-legged squat groove ..." `
  --out projects/4d3d3d3/sequences/tayne --expressions smiling --seed 9002
```

- `--prompt` describes the person and the dance in plain words: what they look like, then "Dance: ...".
- `--expressions` can be repeated or comma-separated. Each one becomes `<name>.png`.
- `--seed` makes a result repeatable. Without it, the seed comes from the name.
- `--engine ltx` (default; see "Which dance model a run uses"), `wan`, `h3` (MiniMax H3, see its section) or
  `openrouter` (`seedance` also works). With `openrouter`, `--model` picks any
  model in OpenRouter's video catalogue that accepts a first and a last frame (default `bytedance/seedance-2.5`;
  `minimax/hailuo-3-max` is the other one checked) and `--resolution` picks its size (default `480p`, which is
  already 720 pixels tall after shaping).
- `--dry-run` checks the request (for OpenRouter against the live public catalogue), says which dance model this
  Modal account would use and why, and prints the expected cost. It spends nothing and needs no key.
- `--stills-only` makes only the pictures; `--from-still` dances the existing `keyframe.png` in `--out`.
- `--like <folder>` (with `--like-strength`, `--like-tint`) re-dresses another sequence's character.
- `--max-cost` (default $1.50) refuses to start if one dancer could cost more; `--hosted-cap` (default $5) refuses
  any OpenRouter clip that would take the total OpenRouter spending in the local ledger past that amount.
- `--work <folder>` keeps the raw paid results, so the finishing steps can be redone later for free.

While it works it prints one JSON line per step, for example
`{"stage": "motion", "progress": 0.3, "message": "Teaching the character to dance ..."}`, and finishes with
`{"done": true, "media": "C:\\...\\media.json", "costUsdEstimate": 0.35}`. If anything fails it prints
`{"error": "<plain reason>"}` and exits with a non-zero code. Nothing is left running in the cloud either way:
the cloud app only exists while the command runs, every function scales to zero, at most one machine runs, and
nothing is retried automatically. An OpenRouter clip is requested exactly once and never re-sent, even after an
unclear answer, so it can never be paid for twice by accident; the key is only ever sent to the OpenRouter API
address.

Every run is added to `.local/media-ledger.jsonl` (not committed) with its cost per step.

## Making the cast

The cast (names, descriptions, seeds) is in `tools/media/cast.json`. `make_cast.py` makes all of it in one go and
always prints the plan and total cost first. Without `--yes` it does nothing else.

```powershell
python tools/media/make_cast.py --stills --yes                     # the pictures
python tools/media/make_cast.py --engine ltx --yes                 # the dances, on Modal
python tools/media/make_cast.py --engine openrouter --model bytedance/seedance-2.5 --resolution 480p
python tools/media/make_cast.py --engine openrouter --model minimax/hailuo-3-max --resolution 480p
```

To compare a hosted model on Tayne alone once the owner has set the key (about $0.59 for Seedance, $0.31 for
MiniMax), without touching the shipped clip:

```powershell
$env:OPENROUTER_API_KEY = "<the owner's key>"
mkdir C:\temp\tayne-hosted; copy projects\4d3d3d3\sequences\tayne\keyframe.png C:\temp\tayne-hosted\
python tools/media/generate.py --name Tayne --prompt "<Tayne's prompt from cast.json>" --seed 9002 `
  --out C:\temp\tayne-hosted --from-still --engine openrouter --model minimax/hailuo-3-max
```

## Cost details

**Modal** (published prices, [modal.com/pricing](https://modal.com/pricing), checked 2026-11-10). Costs are the
seconds each cloud step takes, measured from this computer (start-up and model loading included), times the price
of the resources requested:

| Step | Machine | Price per second | Typical |
|---|---|---|---|
| Draw + cut out stills | L40S, 4 cores, 32 GiB | $0.000665 | 40 to 60 s, $0.03 to $0.04 |
| Dance, LTX-2.5 | H200, 4 cores, 128 GiB | $0.001598 | 166 to 174 s, $0.27 to $0.28 |
| Dance, Wan2.2 | H200, 4 cores, 128 GiB | $0.001598 | 448 to 460 s, $0.72 to $0.74 |
| Dance, MiniMax H3 | H200, 8 cores, 128 GiB | $0.001650 | 436 s, $0.72 (one run; limit 700 s, $1.16) |
| Cut out every frame | L40S, 4 cores, 32 GiB | $0.000665 | 46 to 60 s, $0.03 to $0.04 |
| Downloads and checks | 2 to 4 cores, no graphics card | $0.00004 to $0.00009 | see "First time on your own Modal account" |
| Stored model files | Modal volumes | $0.09 per GiB per month above the free 1 TiB | $0 for this project's 149 to 223 GiB |

**OpenRouter** (live public catalogue `GET https://openrouter.ai/api/v1/videos/models`, read 2026-11-11; the tool
reads it again before every clip):

- `bytedance/seedance-2.5`: $0.0000107 per "video token", silent. Video tokens = width × height × 24 frames per
  second × seconds ÷ 1024. This formula reproduces the model page's headline "from $0.1028/second" exactly
  (480 × 854 × 24 ÷ 1024 = 9,607.5 tokens a second). For our 3:4 portrait, 5 seconds:
  480p (560 × 752) = 49,350 tokens = **$0.528**; 720p (834 × 1112) = 108,681 tokens = **$1.163**.
- `minimax/hailuo-3-max`: $0.05 a second at 480p and $0.08 a second at 768p. 5 seconds: **$0.25** at 480p,
  **$0.40** at 768p.
- Whole cast of four loops (dance step only; add about $0.04 of Modal cut-out per loop):
  Seedance **$2.11** at 480p or **$4.65** at 720p; MiniMax **$1.00** at 480p or **$1.60** at 768p.

## The demo cast in this repository

| Sequence | Who | Dance route | Backdrop | `hatLine` | Clip cost |
|---|---|---|---|---|---|
| `celery-man` | Smug man around forty in an oversized shiny silver-grey 1980s suit, white shirt, thin dark-grey tie; fist pumps and knee bounces; has `smiling.png` | LTX-2.5 | blue | 0.28 (chin, set by eye) | $0.38 |
| `oyster` | Same kind of man in a red flame-pattern skull cap, open red track jacket, black T-shirt, studded choker; bent-over bouncing and head-banging; has `smiling.png` | LTX-2.5 | grey | 0.29 (chin, set by eye) | $0.38 |
| `tayne` | Same kind of man in a black flat-brimmed hat, black sunglasses, gold chain, orange-gold and black baroque silk shirt, black leather trousers and boots; arms flexed, squat groove and kicks; has `smiling.png` | LTX-2.5 | grey | 0.24 (sunglasses, just under the brim, set by eye) | $0.36 |
| `tayne/nude` | Same Tayne in a silly beach costume: lime-green sling swimsuit, two stacked swim rings (the top one with a rubber-duck head) from the belly button to the upper thighs, same hat, sunglasses, chain and boots | LTX-2.5 | grey | 0.23 (sunglasses, just under the brim, set by eye) | $0.30 |
| `celery-head` | Bonus: the earlier cartoon figure with a celery head | LTX-2.5 | magenta | 0.27 (measured) | $0.34 |

All clips are 4.0 s loops at 24 frames per second, 540 × 720 (celery-head 480 × 720), 0.5 to 1.3 MB, VP9 with a
see-through background. Every folder passes the contract check. Clip costs include the picture.

**Closer to the sketch (2026-11-11).** The first three were remade so they wear what the cast wears in the original
sketch and dance more like it. As in the sketch, one invented man plays all three, so the three descriptions give
the same age, hair and build and only the costume and dance change. Only the costume, hair colour, age bracket, pose
and dance were matched; no picture of a real person went into any model, and the prompts name nobody. The beach
costume was redrawn from the new Tayne picture (same face, hat, sunglasses, chain and boots). In all three drafts the
drawing put the swim ring at the waist, so the swimsuit bottom showed below it; a second copy of the ring was added
below the first one by hand (two stacked rings, no extra cost), and the dance was made from that picture.

Known weak spots, all from the video model itself: in the beach costume the rings ride up a little in the fastest
moves, so the plain green swimsuit bottom shows for a moment (nothing more); Oyster's face blurs while he bends
forward and head-bangs; Celery Man's trouser legs go soft in fast knee bounces; the automatic `hatLine` fell at the
shoulders or chest for all four, because raised fists and bending widen the outline, so all four were set by eye.
`smiling.png` for the cast are redrawn pictures, so the face differs a little from `still.png`.

## Ledgers for this work

**OpenRouter (Seedance, MiniMax): $0.00.** No paid request was made; only the free public catalogue was read.
The key was never looked up, read, used or written anywhere.

**Modal: about $5.31 of the $10 cap.** $5.02 is measured by the tool (seconds × published price, listed below,
times in UTC on 2026-11-11). Two amounts are estimates because the tool could not measure them: the stopped
stylised Oyster run (the cloud app lived 119 s; at most $0.19) and building the cloud software images (about
$0.10).

| What | Steps | Cost |
|---|---|---|
| One-time downloads and checks | picture and cut-out models (282 s), Wan2.2 (754 s), tool checks | $0.085 |
| Stylised cast, first plan | Celery-head cartoon (kept as bonus) | $0.344 |
| | Stylised Oyster, stopped during its dance when the plan changed | ≤ $0.19 (estimate) |
| Realistic pictures | 4 cast pictures | $0.127 |
| | 3 redraws of the costume variant (bodysuit, then baggy suit) | $0.094 |
| | 3 drafts of the beach costume (2 rejected, 1 kept) | $0.088 |
| Route comparison on Tayne | LTX-2.5 | $0.311 |
| | Wan2.2, normal prompt | $0.766 |
| | Wan2.2, energetic prompt | $0.751 |
| Cast loops | Beach-costume Tayne | $0.304 |
| | Celery Man, first take (magenta backdrop, pink hands; replaced) | $0.324 |
| | Oyster, first take (magenta backdrop, stained sleeves; replaced) | $0.369 |
| | Tayne, re-made because the saved raw results were wiped from the temporary folder | $0.309 |
| | Celery Man, final | $0.342 |
| | Oyster, second take (blue backdrop, rainbow satin; replaced) | $0.528 |
| | Oyster, final (grey backdrop) | $0.278 |
| Software images | first build, then the Wan layer | about $0.10 (estimate) |
| **Total** | | **about $5.31** |

The local record of every measured step is `.local/media-ledger.jsonl` while working; it is not committed.

### New dancers on any Modal account (2026-11-11, cap $2): about $0.35

The stranger's path was tried on the owner's account with the testing switches (`MEDIA_IGNORE_LTX_CACHE=1`,
`MEDIA_LTX_VOLUME=beta-sequence-ltx-weights-temp-test`). No Hugging Face token was available for this work and
none was looked for, so the real 80 GB download from Hugging Face was **not** tried. Instead the six files were
copied from the owner's cache into the temporary volume, and the project's own `--prepare` then checked every
checksum and made the volume ready, exactly as after a download. The temporary volume was deleted afterwards.

| What | Steps | Cost |
|---|---|---|
| `--prepare` as a stranger, no sign-in | real check against Hugging Face from the cloud said "sign-in needed" (3.8 s); tool checks | $0.003 |
| Copy of the six LTX files into the temporary volume | testing aid only, 301 s on 4 cores | $0.026 |
| `--prepare` again | checksums of all six files (218 s), tool checks | $0.023 |
| One default-route Tayne clip from the temporary volume | dance 157 s ($0.250), cut-out 47 s ($0.031) | $0.282 |
| `--prepare` as the owner | still uses his cache read-only, creates no new volume; tool checks only | $0.003 |
| Small software image for the copy step | | under $0.01 (estimate) |
| **Total** | | **about $0.35** |

The clip (Tayne's own picture, prompt and seed 9002, grey backdrop) was a clear strut with the hat staying on, a
natural face and clean see-through edges, like the shipped one. It was not kept in the repository.

### MiniMax H3 test loop (2026-11-11, cap $3): about $0.80

Nothing was downloaded: the owner's existing H3 copy was only read. Nothing failed, so nothing was paid twice.

| What | Steps | Cost |
|---|---|---|
| Looking inside the SGLang software (which code, which settings) | 3 small runs without a graphics card, 147 s in all | $0.005 |
| `--prepare --engine h3` on the owner's copy | all 81 checksums, every byte read (188 s, 8 cores) | $0.026 |
| One Tayne loop with `--engine h3` | dance on one H200 436 s ($0.719), cut-out 38 s ($0.025) | $0.744 |
| Fetching the SGLang software image into Modal | | under $0.05 (estimate) |
| **Total** | | **about $0.80** |

### Cast closer to the sketch (2026-11-11, cap $4): $2.33

All measured by the tool. No download, no software build (the cloud software was already there).

| What | Steps | Cost |
|---|---|---|
| Pictures | Celery Man, Oyster, Tayne: one draft each, all kept | $0.095 |
| | Beach costume: 3 drafts (the ring sat at the waist each time; the last one was kept and given a second ring by hand) | $0.087 |
| Dances | Celery Man, first take (good, but a little less bouncy; replaced) | $0.312 |
| | Celery Man, second take (kept) | $0.351 |
| | Oyster | $0.352 |
| | Tayne | $0.331 |
| | Beach costume, first take (kept) | $0.271 |
| | Beach costume, second take ("stay low" wording; it hardly moved, so it was dropped) | $0.526 |
| **Total** | | **$2.33** |

## Music

The disco music is three real-sounding loops, one per disco level, in `src/ui/music/`. "Disco" starts level 1
(a tight groove), "more disco" blends into level 2 (bigger: strings and brass) and then level 3 (full-on: everything,
busier, more percussion). The three loops have the same tempo and the same length, so the blend (about one second)
stays on the beat. If the loops are missing or cannot be played, the app plays its old groove made on the spot
instead, without an error. `src/ui/music/music.json` lists every loop with its tempo, length, loudness, prompt,
seed and the exact model it was made with.

### Which music model, and why

Compared on 2026-11-11, by licence first (the loops ship inside this MIT-licensed public repository and anyone
may use the app), then by reported quality for instrumental groove music, then by how easy it is to run on Modal.

| Model | Licence of the weights | Good for instrumental disco? | Running it | Verdict |
|---|---|---|---|---|
| **ACE-Step 1.5 XL Turbo** (`ACE-Step/acestep-v15-xl-turbo-diffusers`, April 2026) | **MIT**; the model card says the music may be used commercially | Its makers and independent reviews put ACE-Step 1.5 between Suno v4.5 and v5; the XL model has a larger music part for better sound. Takes a style text, a fixed tempo, key and time signature, and `[Instrumental]` for no singing | Official Diffusers release from the makers' own account; runs with the normal `diffusers` package; seconds per track on one card | **Chosen** |
| MiniMax Music 3 (`MiniMaxAI/MiniMax-Music3`, October 2026) | Own "community licence": products must show "MiniMax-Music3" on screen, and anyone who lets others make music with it must build and run misuse safeguards | Strong on full songs with singing; reviews call its instrumental texture thinner than the best hosted models | About 20 GB (an 8B language model plus a 10 GB sound decoder), its own software | Licence duties do not fit a free MIT app that anyone may change |
| Stable Audio Open 1.0 / Small (`stabilityai/...`) | Stability AI Community Licence: sign-in and accept first, free only below USD 1M yearly revenue | Trained on freely licensed sound libraries; good for sounds and short loops, weak on full band grooves; 47 s (Small: 11 s) at most | Easy | Licence is not open enough, quality lower for a band groove |
| YuE (`m-a-p/YuE-...`) | Apache-2.0 | Made for whole songs with singing from lyrics | Two large models, minutes per 30 seconds | Built for vocals, slow |
| DiffRhythm 1.2 / DiffRhythm 2 (`ASLP-lab/...`) | 1.2 has no licence on its model page; 2 is Apache-2.0 | Made for whole songs with singing; instrumental is a side use | Moderate | Weaker fit for an instrumental groove |
| Magenta RealTime (`google/magenta-realtime`) | CC-BY-4.0 (credit needed) | Live, steerable music in 2-second pieces; sound quality below the offline models | Made for Google's own chips (JAX) | Lower quality, harder to run |
| MusicGen (Meta) | CC-BY-NC 4.0 (non-commercial only) | | | Not allowed here |
| SongGeneration 2 (Tencent) | Weights found only on a personal account with an unclear licence | Songs with singing | | Not an official, pinned source |

### How the loops were made

`tools/media/make_music.py` does everything; `tools/media/music.json` is the recipe (prompts, fixed seeds, tempo
120, key A minor, 4/4, `[Instrumental]`, the pinned model and its file checksums).

1. Once per Modal account, the model (11.1 GB) is downloaded into our own storage `beta-sequence-music-weights`
   and every big file is checked against its checksum. A separation model (Demucs v4 "htdemucs", MIT, from its
   makers' own download server, checked by the hash in its file name) is stored next to it; it is only used to
   measure how much singing is in a candidate.
2. One cloud graphics card (L40S) makes four 100-second candidates per level from the style text and seeds, and
   measures each: tempo and how steady the beat is (beat tracking with librosa, then a straight line through the
   beats), how strongly the beat stands out, peaks and clipping, near-silences, how much of the sound is bass and
   how much is treble, and the share the separation model hears as singing.
3. On this computer, without the cloud: for every candidate the best place for the loop is searched, a whole
   number of bars (32, or 16 if no good 32-bar stretch exists) that starts on a bar line (where the chords change)
   and whose last bars sound most like its first bars. Candidates with a wrong tempo, an unsteady beat, silences,
   singing, thin bass or a dull top end are refused; of the rest the one with the best overall numbers is kept.
4. The loop is set to exactly 120 BPM (a tiny speed change, if any), and its end is blended into its start over
   0.12 seconds, finishing just before the first beat, so there is no click or jump. All three loops are set to the
   same loudness with headroom (-16, -15.5 and -15 LUFS, at least 1 dB below full scale) and saved as Ogg Opus,
   which Chromium decodes to exactly the right length (no gap at the loop point; MP3 adds silence at the ends).
5. The seam is checked on the saved file, decoded again: the jump from the last sample to the first is compared
   with every other step in the loop, and the change in sound across the seam with the change between any two
   moments of the loop.

```powershell
python tools/media/make_music.py                      # the plan and its cost; spends nothing
python tools/media/make_music.py --yes --sample sample.mp3
python tools/media/make_music.py --from-work <folder> # redo choosing and looping for free
```

The prompts describe a style only. No song, band or artist is named or imitated, and no recording is used as input.

### The loops in the app (made 2026-11-11)

All three: 120 BPM, A minor (asked for, and confirmed by a key estimate on the finished files), 32 bars = exactly
64.000 seconds, Ogg Opus at 109 kbit/s, 48 kHz stereo, no clipping. Four candidates were made per level; every
candidate came out within 1 BPM of 120 (ten of the twelve at 120.0 or 120.1) and the singing check heard no singing in any of them
(0.02 % at most).

| Level | Seed | Measured tempo | Beat steadiness | Loudness | Highest peak | File size | Cut from the candidate at |
|---|---|---|---|---|---|---|---|
| 1, groove | 1971 | 120.0 BPM | 3.9 ms | -16.0 LUFS | -5.4 dBTP | 945 KB | 24.4 s |
| 2, bigger | 4272 | 120.0 BPM | 4.1 ms | -15.5 LUFS | -4.4 dBTP | 956 KB | 10.6 s |
| 3, full-on | 4273 | 120.0 BPM | 3.8 ms | -15.0 LUFS | -2.6 dBTP | 962 KB | 14.4 s |

Refused or beaten candidates: level 1 seed 4271 (dull top end), seed 9171 (unsteady beat, 31 ms); level 2 seed
7772 (121 BPM and a dull top end); the rest had lower overall numbers. Every file decodes back to exactly 3,072,000
samples (no gap, no padding), in ffmpeg and in the app itself. The seam was measured on the saved files: the step
from the last sample back to the first is an ordinary step (larger than 68 %, 15 % and 58 % of all steps in the
loops), and the change in sound across the seam is like that at any other bar line of the same loop (it changes
more than at 77 %, 81 % and 39 % of the other 31 bar lines). Nothing above about 16 kHz is in the model's sound.

**Nobody has listened to these loops.** They were chosen only by the measurements above. If one sounds wrong,
pick another candidate by changing the seeds in `tools/media/music.json` and running the tool again.

### Music ledger (2026-11-11, cap $3): about $0.13

Taken from Modal's own billing report for the music app (the tool's own estimate from seconds × price was $0.16).

| What | Steps | Cost |
|---|---|---|
| First try | software build failed on a package version clash; fixed | $0.007 |
| Short test | software build, download and check of the model (11.1 GB, 144 s), one 20-second candidate | $0.047 |
| The music | 12 candidates of 100 seconds on one L40S (173 s in all), measuring included | $0.074 |
| **Total** | | **about $0.13** |

Choosing, looping, levelling and saving ran on this computer and cost nothing; it can be redone for free with
`--from-work`.

## Tests

```powershell
python -m unittest discover -s test/media -v
```

The tests need no cloud, no graphics card and no key. `test_music.py` checks the disco-loop maker on a made-up
groove: tempo line, bar-line start, whole bars at exactly 120 BPM, the 16-bar fallback, refusing bad candidates,
the cost shown before anything is spent, and an Opus round trip that decodes to exactly the loop's length.
`npm test` checks the loops in `src/ui/music` against their `music.json`, their size and how the app serves them;
`node test/ui/music-check.mjs` starts the app silently and checks it plays them (see the Music section). They check the `media.json` contract, the cut-out clean-up
(backdrop tint, green halos, blurred hands), the loop step, the hat line, a real ffmpeg round trip that proves the
see-through background survives VP9 encoding, the choice of dance model per account (owner's cache, own copy,
only Wan, nothing prepared, Hugging Face sign-in needed, the testing switch), the LTX download's checksum step on
tiny stand-in files, MiniMax H3 (its pinned file list, owner's copy read-only, own copy, nothing there, never the
default, the prompt layout, the checksum checks on stand-in files, the cost limit), and the OpenRouter route
against a fake local server: request shape
(same picture first and last, no audio), polling, download (the key is not sent to the storage server), refused
and failed jobs (never re-sent), the time limit, the spending cap, and prices per token, per second and in cents.

## Files

| File | What it does |
|---|---|
| `tools/media/generate.py` | The command the app calls. Runs the steps and prints progress. |
| `tools/media/make_cast.py` | Makes the whole demo cast from `cast.json`, cost first. |
| `tools/media/cast.json` | The demo cast: names, descriptions, seeds. |
| `tools/media/media_cloud.py` | The Modal app: software images, storage and the cloud steps. |
| `tools/media/media_route.py` | Looks at the Modal account and picks the dance model; the `--prepare` plan. |
| `tools/media/media_art.py` | Runs in the cloud: drawing (Z-Image-Turbo) and cut-out (BiRefNet). |
| `tools/media/media_ltx.py` | Runs in the cloud: the LTX-2.5 download and check, and the LTX-2.5 dance. |
| `tools/media/media_wan.py`, `wan_files.json` | Runs in the cloud: the Wan2.2 dance, and its pinned file list. |
| `tools/media/media_h3_cloud.py` | The separate Modal app for MiniMax H3 (only used with `--engine h3`). |
| `tools/media/media_h3.py`, `h3_files.json` | Runs in the cloud: the MiniMax H3 checks, download and dance, and its pinned file list. |
| `tools/media/media_hosted.py` | The OpenRouter route: catalogue check, price, one request, polling, download. |
| `tools/media/media_finish.py` | Runs locally: cut-out clean-up, layout, loop, VP9 encode, hat line. |
| `tools/media/media_contract.py` | Builds and checks `media.json` folders. |
| `tools/media/media_settings.py` | Model pins, canvas sizes, machine sizes and prices. |
| `tools/media/make_music.py` | Makes the three disco loops: cost first, then cloud candidates, then choosing and looping here. |
| `tools/media/media_music.py` | The Modal app for the music: storage, software, making and measuring candidates. |
| `tools/media/music.json` | The music recipe: pinned model and checksums, prompts, seeds, tempo and key. |
| `src/ui/music/` | The three loops and their `music.json` (tempo, length, loudness, prompt, seed, model). |
| `test/music.test.js`, `test/ui/music-check.mjs` | Checks the loops and their list, and (silently) that the app plays them. |
