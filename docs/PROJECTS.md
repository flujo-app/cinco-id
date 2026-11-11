# Projects and sequences

Everything the computer can load lives in a **project**. A project is a folder inside `projects/` whose name is a
hexadecimal number, for example `projects/4d3d3d3`. Saying "kick up the 4d3d3d3" starts that project.

A **sequence** is one thing that can appear in a window, usually a dancer. Each sequence is a folder inside the
project's `sequences/` folder.

```text
projects/
  4d3d3d3/
    project.json
    sequences/
      tayne/
        sequence.json      written by hand: name, spoken aliases, fallback puppet
        media.json         optional, written by the media generator
        loop.webm          optional, generated see-through dance loop
        still.png          optional, generated still picture
        smiling.png        optional, generated still for the "smiling" expression
        nude/              optional folder per variant, same generated files inside
          media.json
          loop.webm
          still.png
```

## project.json

```json
{
  "name": "Demo floor",
  "description": "Pre-made cast for trying things out.",
  "show": { "windows": 28, "effects": ["tumble"], "drift": true }
}
```

- `show.windows`: how many windows open when the project is kicked up (it grows each time you kick it up again).
- `show.effects`: effects applied to the copies.
- `show.drift`: whether the copies wander around the screen.

## sequence.json (hand-written)

```json
{
  "name": "Tayne",
  "aliases": ["tain", "tane", "taine"],
  "beta": true,
  "hatLine": 0.2,
  "expressions": ["smiling"],
  "puppet": { "rig": "humanoid", "dance": "strut", "style": { "suit": "#0aa", "hat": "wide" } },
  "variants": {
    "nude": { "gated": true, "puppet": { "style": { "suit": null, "skin": "#e8b796" } } }
  }
}
```

- `name` and `aliases`: what you can call it. Aliases help the speech recognizer with made-up names.
- `beta`: held back until you ask "do we have any new sequences?".
- `hatLine`: how far down from the top the hat ends (0 to 1). "Hat wobble" wobbles everything above this line.
- `puppet`: a simple drawn dancer used when no generated clip exists. It always works, even offline.
- `variants`: alternative looks. A variant marked `gated` asks "This is not suitable for work. Are you sure?" first.

## media.json (generated, optional)

Written by the media generator in `tools/media/`. When it exists, the generated clip is used instead of the puppet.
The same file layout applies inside a variant folder such as `nude/`.

```json
{
  "clip": "loop.webm",
  "width": 480,
  "height": 640,
  "fps": 24,
  "frames": 96,
  "stills": { "default": "still.png", "smiling": "smiling.png" },
  "hatLine": 0.22,
  "provenance": {
    "created": "2026-11-11T00:00:00Z",
    "models": [{ "repo": "publisher/model", "revision": "<pinned commit>" }],
    "prompts": { "image": "…", "motion": "…" },
    "costUsdEstimate": 0.4
  }
}
```

Rules for generated media:

- `loop.webm` is VP9 video **with a see-through background** (pixel format `yuva420p`), a seamless loop of
  3 to 6 seconds, portrait, between 480 and 720 pixels tall, with the whole figure inside the frame and a little
  empty space around it. Keep each file under about 4 MB.
- `still.png` and expression stills are see-through PNG pictures of the same character.
- `hatLine` in `media.json` overrides the one in `sequence.json`.
- Characters are invented. No real people's faces or likenesses, and nothing explicit.
