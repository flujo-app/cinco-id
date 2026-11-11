"""Local finishing steps: cut-out clean-up, layout, seamless loop, VP9-with-alpha encode.

Needs only NumPy, Pillow and the ffmpeg/ffprobe programs. No GPU, no network.
All frames are NumPy arrays: RGB uint8 (H, W, 3), alpha float32 (H, W) in 0..1,
RGBA float32 (H, W, 4) in 0..1 with straight (not premultiplied) colour.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# Flat backdrop colours offered to the motion model; the one furthest from the
# character's own colours is used so the cut-out never eats into the figure.
KEY_COLORS = {
    "magenta": (255, 0, 255),
    "green": (0, 200, 0),
    "blue": (0, 60, 255),
    "orange": (255, 140, 0),
    "white": (245, 245, 245),
}


# --- small helpers -------------------------------------------------------------
def ffmpeg_path() -> str:
    found = shutil.which("ffmpeg")
    if not found:
        raise RuntimeError("ffmpeg is not installed or not on PATH")
    return found


def ffprobe_path() -> str:
    found = shutil.which("ffprobe")
    if not found:
        raise RuntimeError("ffprobe is not installed or not on PATH")
    return found


def to_float(rgb: np.ndarray) -> np.ndarray:
    return rgb.astype(np.float32) / 255.0


def to_uint8(value: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(value * 255.0), 0, 255).astype(np.uint8)


def border_color(rgb: np.ndarray, width: int = 6) -> np.ndarray:
    """Median colour of the picture's outer border (the backdrop), as floats 0..1."""
    rgb = to_float(rgb) if rgb.dtype == np.uint8 else rgb
    border = np.concatenate([rgb[:width].reshape(-1, 3), rgb[-width:].reshape(-1, 3),
                             rgb[:, :width].reshape(-1, 3), rgb[:, -width:].reshape(-1, 3)])
    return np.median(border, axis=0).astype(np.float32)


def choose_key_color(rgb: np.ndarray, alpha: np.ndarray) -> tuple[str, tuple[int, int, int]]:
    """Pick the backdrop colour least similar to any colour on the figure."""
    pixels = to_float(rgb)[alpha > 0.5]
    if len(pixels) > 20000:
        pixels = pixels[np.linspace(0, len(pixels) - 1, 20000).astype(int)]
    best, best_score = None, -1.0
    for name, color in KEY_COLORS.items():
        distance = np.linalg.norm(pixels - np.array(color, np.float32) / 255.0, axis=1)
        # Share of figure pixels that are clearly different from this colour.
        score = float(np.mean(distance > 0.35)) + 0.001 * float(np.percentile(distance, 2))
        if score > best_score:
            best, best_score = name, score
    return best, KEY_COLORS[best]


# --- cut-out clean-up ----------------------------------------------------------
def clean_alpha(rgb: np.ndarray, alpha: np.ndarray, background: np.ndarray,
                floor: float = 0.04, tolerance: float = 0.07) -> np.ndarray:
    """Remove faint haze and anything that is plainly backdrop-coloured."""
    rgbf = to_float(rgb) if rgb.dtype == np.uint8 else rgb
    alpha = alpha.astype(np.float32).copy()
    alpha[alpha < floor] = 0.0
    alpha[alpha > 1.0 - floor] = 1.0
    near_backdrop = np.linalg.norm(rgbf - background[None, None, :], axis=2) < tolerance
    alpha[near_backdrop & (alpha < 0.9)] = 0.0
    return alpha


def keep_main_figure(alpha: np.ndarray, threshold: float = 0.5, min_share: float = 0.02) -> np.ndarray:
    """Drop small detached specks: keep connected parts holding at least min_share of the figure."""
    solid = alpha > threshold
    if not solid.any():
        return alpha
    small = np.asarray(Image.fromarray(solid.astype(np.uint8) * 255).resize(
        (max(1, alpha.shape[1] // 4), max(1, alpha.shape[0] // 4)), Image.Resampling.BOX)) > 0
    labels = _label(small)
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    keep_ids = np.flatnonzero(counts >= max(1, counts.sum() * min_share))
    keep_small = np.isin(labels, keep_ids)
    # Grow the kept region a little so soft edges next to it survive.
    keep = Image.fromarray(keep_small.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))
    keep = np.asarray(keep.resize((alpha.shape[1], alpha.shape[0]), Image.Resampling.NEAREST)) > 0
    return np.where(keep, alpha, 0.0).astype(np.float32)


def _label(mask: np.ndarray) -> np.ndarray:
    """4-connected component labels with a simple union-find (no SciPy needed)."""
    height, width = mask.shape
    labels = np.zeros(mask.shape, np.int32)
    parent = [0]

    def find(value: int) -> int:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    next_label = 1
    for y in range(height):
        row = mask[y]
        for x in range(width):
            if not row[x]:
                continue
            up = labels[y - 1, x] if y else 0
            left = labels[y, x - 1] if x else 0
            if up and left:
                a, b = find(up), find(left)
                labels[y, x] = min(a, b)
                parent[max(a, b)] = min(a, b)
            elif up or left:
                labels[y, x] = up or left
            else:
                parent.append(next_label)
                labels[y, x] = next_label
                next_label += 1
    roots = np.array([find(index) for index in range(len(parent))], np.int32)
    return roots[labels]


def decontaminate(rgb: np.ndarray, alpha: np.ndarray, background: np.ndarray) -> np.ndarray:
    """Undo backdrop colour mixed into soft edges: fg = (C - (1 - a) * B) / a."""
    rgbf = to_float(rgb) if rgb.dtype == np.uint8 else rgb.astype(np.float32)
    a = alpha[..., None]
    soft = (a > 0.02) & (a < 0.98)
    unmixed = (rgbf - (1.0 - a) * background[None, None, :]) / np.maximum(a, 0.02)
    return np.where(soft, np.clip(unmixed, 0.0, 1.0), rgbf).astype(np.float32)


def blur(array: np.ndarray, radius: int, passes: int = 3) -> np.ndarray:
    """Approximate Gaussian blur of an (H, W, C) float array: repeated box blurs."""
    out = array.astype(np.float32)
    size = 2 * radius + 1
    for _ in range(passes):
        for axis in (0, 1):
            pad = [(0, 0)] * out.ndim
            pad[axis] = (radius + 1, radius)
            padded = np.pad(out, pad, mode="edge")
            summed = np.cumsum(padded, axis=axis, dtype=np.float64)
            upper = np.take(summed, np.arange(size, size + out.shape[axis]), axis=axis)
            lower = np.take(summed, np.arange(0, out.shape[axis]), axis=axis)
            out = ((upper - lower) / size).astype(np.float32)
    return out


def bleed_colors(rgb: np.ndarray, alpha: np.ndarray, radius: float = 6.0) -> np.ndarray:
    """Give see-through pixels the colour of the nearby figure.

    The video format stores colour at half resolution, so colour hidden under
    transparent pixels leaks into the visible edge. Filling it with the figure's
    own colours avoids dark or coloured fringes.
    """
    a = alpha[..., None].astype(np.float32)
    stacked = blur(np.concatenate([rgb * a, a], axis=-1), int(radius))
    blurred_alpha = stacked[..., 3]
    fill = stacked[..., :3] / np.maximum(blurred_alpha[..., None], 1e-4)
    fill = np.where(blurred_alpha[..., None] > 1e-3, np.clip(fill, 0, 1), 0.0)
    return np.where(a > 0.0, rgb, fill).astype(np.float32)


def cutout(rgb: np.ndarray, alpha: np.ndarray, background: np.ndarray | None = None,
           tidy: bool = True) -> np.ndarray:
    """RGB picture + rough alpha -> clean straight RGBA float image."""
    background = border_color(rgb) if background is None else background
    alpha = clean_alpha(rgb, alpha, background)
    if tidy:
        alpha = keep_main_figure(alpha)
    color = decontaminate(rgb, alpha, background)
    color = bleed_colors(color, alpha)
    return np.dstack([color, alpha]).astype(np.float32)


# --- layout -------------------------------------------------------------------
def figure_box(alpha: np.ndarray, threshold: float = 0.1) -> tuple[int, int, int, int]:
    """Bounding box (left, top, right, bottom) of the visible figure; right/bottom exclusive."""
    rows = np.flatnonzero((alpha > threshold).any(axis=1))
    cols = np.flatnonzero((alpha > threshold).any(axis=0))
    if not len(rows) or not len(cols):
        raise ValueError("The picture has no visible figure")
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def resize_rgba(rgba: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Resize straight RGBA with premultiplied filtering (no dark halos)."""
    image = Image.fromarray(to_uint8(rgba), "RGBA").convert("RGBa")
    image = image.resize(size, Image.Resampling.LANCZOS).convert("RGBA")
    return to_float(np.asarray(image))


def place_figure(rgba: np.ndarray, canvas: tuple[int, int], height_share: float,
                 max_width_share: float, feet_line: float) -> tuple[np.ndarray, dict]:
    """Scale and move the figure onto a transparent canvas (width, height)."""
    width, height = canvas
    left, top, right, bottom = figure_box(rgba[..., 3])
    figure = rgba[top:bottom, left:right]
    scale = min(height_share * height / figure.shape[0], max_width_share * width / figure.shape[1])
    new_w, new_h = max(1, round(figure.shape[1] * scale)), max(1, round(figure.shape[0] * scale))
    figure = resize_rgba(figure, (new_w, new_h))
    x = (width - new_w) // 2
    y = round(feet_line * height) - new_h
    y = max(0, min(y, height - new_h))
    out = np.zeros((height, width, 4), np.float32)
    out[y:y + new_h, x:x + new_w] = figure
    out[..., :3] = bleed_colors(out[..., :3], out[..., 3])
    return out, {"scale": scale, "x": x, "y": y, "width": new_w, "height": new_h}


def over_color(rgba: np.ndarray, color: tuple[int, int, int]) -> np.ndarray:
    """Composite onto a flat colour; returns RGB uint8."""
    backdrop = np.array(color, np.float32) / 255.0
    a = rgba[..., 3:4]
    return to_uint8(rgba[..., :3] * a + backdrop[None, None, :] * (1 - a))


def hat_line(alpha: np.ndarray) -> float:
    """Estimate where the hat/head ends, as a share of the picture height.

    Looks for the widest row in the top part of the figure (a hat brim or a
    leafy head) and returns the first row below it where the figure becomes
    clearly narrower again.
    """
    left, top, right, bottom = figure_box(alpha, 0.5)
    solid = alpha > 0.5
    widths = solid.sum(axis=1).astype(np.float32)
    figure_h = bottom - top
    search_end = top + max(2, int(figure_h * 0.35))
    peak = top + int(np.argmax(widths[top:search_end]))
    limit = top + max(3, int(figure_h * 0.5))
    for row in range(peak, limit):
        if widths[row] < 0.6 * widths[peak]:
            return round(row / alpha.shape[0], 3)
    return round((top + 0.2 * figure_h) / alpha.shape[0], 3)


# --- loop ---------------------------------------------------------------------
def premultiplied(frame: np.ndarray) -> np.ndarray:
    return np.concatenate([frame[..., :3] * frame[..., 3:4], frame[..., 3:4]], axis=-1)


def frame_difference(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(premultiplied(a) - premultiplied(b))))


def make_loop(frames: list[np.ndarray], drop_last: bool = True, crossfade: int = 6,
              tolerance: float = 2.0) -> tuple[list[np.ndarray], dict]:
    """Turn a clip into a seamless loop.

    The motion model is asked to end on the same pose it starts with, so the
    final frame normally repeats the first and is dropped. If the remaining jump
    from last to first frame is still bigger than `tolerance` times an ordinary
    frame-to-frame step, the tail is cross-faded into the opening frames.
    """
    if len(frames) < 3 * crossfade + 2:
        raise ValueError("The clip is too short to loop")
    clip = list(frames[:-1] if drop_last else frames)
    steps = [frame_difference(clip[i], clip[i + 1]) for i in range(len(clip) - 1)]
    typical = float(np.median(steps)) or 1e-6
    seam_before = frame_difference(clip[-1], clip[0])
    report = {"typicalStep": round(typical, 5), "seamBefore": round(seam_before, 5), "crossfadeFrames": 0}
    if seam_before > tolerance * typical and crossfade > 0:
        n = len(clip)
        tail = []
        for i in range(crossfade):
            weight = (i + 1) / (crossfade + 1)
            a, b = premultiplied(clip[n - crossfade + i]), premultiplied(clip[i])
            mixed = a * (1 - weight) + b * weight
            alpha = mixed[..., 3:4]
            color = np.where(alpha > 1e-4, mixed[..., :3] / np.maximum(alpha, 1e-4), 0.0)
            tail.append(np.concatenate([color, alpha], axis=-1).astype(np.float32))
        clip = clip[crossfade:n - crossfade] + tail
        report["crossfadeFrames"] = crossfade
    report["seamAfter"] = round(frame_difference(clip[-1], clip[0]), 5)
    report["frames"] = len(clip)
    return clip, report


# --- encode and inspect -----------------------------------------------------------
def encode_webm(frames: list[np.ndarray], path: Path, fps: int = 24, crf: int = 30,
                max_bytes: int = 4 * 1024 * 1024) -> dict:
    """Encode RGBA frames as VP9 with a see-through background (yuva420p)."""
    height, width = frames[0].shape[:2]
    path = Path(path)
    for attempt_crf in (crf, crf + 6, crf + 12, crf + 18):
        tmp = path.with_suffix(".part.webm")
        command = [
            ffmpeg_path(), "-nostdin", "-v", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
            "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", str(attempt_crf),
            "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-auto-alt-ref", "0",
            "-metadata:s:v:0", "alpha_mode=1", str(tmp),
        ]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        for frame in frames:
            process.stdin.write(to_uint8(frame).tobytes())
        process.stdin.close()
        error = process.stderr.read().decode(errors="replace")
        process.stderr.close()
        if process.wait() != 0:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"Video encoding failed: {error.strip()[:300]}")
        if tmp.stat().st_size <= max_bytes:
            tmp.replace(path)
            return {"crf": attempt_crf, "bytes": path.stat().st_size}
        tmp.unlink()
    raise RuntimeError("The clip stays larger than the size limit even at low quality")


def probe(path: Path) -> dict:
    output = subprocess.check_output([ffprobe_path(), "-v", "error", "-count_frames", "-show_streams",
                                      "-show_format", "-of", "json", str(path)], timeout=120)
    return json.loads(output)


def decode_webm_rgba(path: Path) -> np.ndarray:
    """Decode a VP9 clip including its alpha channel (needs the libvpx decoder)."""
    info = probe(path)["streams"][0]
    width, height = int(info["width"]), int(info["height"])
    raw = subprocess.check_output([ffmpeg_path(), "-nostdin", "-v", "error", "-c:v", "libvpx-vp9", "-i", str(path),
                                   "-f", "rawvideo", "-pix_fmt", "rgba", "-"], timeout=300)
    return np.frombuffer(raw, np.uint8).reshape(-1, height, width, 4)


def decode_video_rgb(path: Path) -> np.ndarray:
    info = probe(path)["streams"][0]
    width, height = int(info["width"]), int(info["height"])
    raw = subprocess.check_output([ffmpeg_path(), "-nostdin", "-v", "error", "-i", str(path),
                                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], timeout=300)
    return np.frombuffer(raw, np.uint8).reshape(-1, height, width, 3)


def save_png(rgba: np.ndarray, path: Path) -> None:
    Image.fromarray(to_uint8(rgba), "RGBA").save(path, optimize=True)
