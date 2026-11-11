// Draws sequences (dancers) into windows and applies the effects.
// One shared helper frame is drawn per view, then composed onto the window's canvas.
//
// A window shows a dancer in one of four "shots", as in the sketch:
//   full     the whole dancer
//   closeup  head and shoulders (the picture follows the head)
//   face     the face fills the window
//   title    the name in big chunky letters, with the dancer in front

import { drawPuppet, FRAME_W, FRAME_H } from './puppets.js';
import { fitBlockText } from './pixels.js';

// The helper frame comes in two sizes: the small one for whole dancers in small windows, and one
// as big as the generated clips for close-ups, so a face is not blown up from a handful of pixels.
const HI = 2.25;
function makeScratch(scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(FRAME_W * scale);
  canvas.height = Math.round(FRAME_H * scale);
  const ctx = canvas.getContext('2d');
  return { canvas, ctx, scale };
}
const scratchSmall = makeScratch(1);
const scratchBig = makeScratch(HI);
const small = document.createElement('canvas');
const smallCtx = small.getContext('2d');

const FALLBACK_PUPPET = { rig: 'humanoid', dance: 'shuffle', style: { suit: '#666', skin: '#e8b796', shoes: '#222' } };

// Generated clips are shared: a few videos per file, however many windows show it. The copies of
// one file run a part of the loop apart, so a screen full of windows is not all in step.
const CLIP_SLOTS = 3;
const clips = new Map();
function borrowClip(url, slot = 0) {
  const key = `${url}#${slot}`;
  let clip = clips.get(key);
  if (!clip) {
    const video = document.createElement('video');
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    if (slot) {
      video.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(video.duration)) video.currentTime = video.duration * slot / CLIP_SLOTS;
      }, { once: true });
    }
    video.play().catch(() => {});
    clip = {
      key, url, video, users: 0, headAt: -1, headFound: null,
      picture: null, pictureCtx: null, pictureTime: -1, // the latest frame, kept as a picture
      get ready() { return video.readyState >= 2 && video.videoWidth > 0; },
    };
    clips.set(key, clip);
  }
  clip.users++;
  return clip;
}
function returnClip(clip) {
  if (!clip || --clip.users > 0) return;
  clip.video.pause();
  clip.video.removeAttribute('src');
  clip.video.load();
  clips.delete(clip.key);
}

/** For checks: which generated clips are loaded and whether they are playing. */
export function clipStatus() {
  return [...clips.values()].map(clip => ({
    url: clip.url, ready: clip.ready, users: clip.users, width: clip.video.videoWidth, height: clip.video.videoHeight,
    time: clip.video.currentTime, error: clip.video.error?.message ?? null,
  }));
}

const stillImages = new Map();
export function loadImage(url) {
  if (!stillImages.has(url)) {
    stillImages.set(url, new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('picture missing'));
      image.src = url;
    }));
  }
  return stillImages.get(url);
}

/**
 * The latest frame of a clip as a picture in the helper-frame shape, shared by every window that
 * shows the clip. It is copied from the video once per new frame. While the video is busy for a
 * moment (it jumps back to the start at the end of every loop) the last picture simply stays, so
 * the dancer never blinks away. Null until the clip has shown its first frame.
 */
function clipPicture(clip) {
  if (!clip) return null;
  if (clip.ready && clip.pictureTime !== clip.video.currentTime) {
    if (!clip.picture) {
      clip.picture = document.createElement('canvas');
      clip.picture.width = scratchBig.canvas.width;
      clip.picture.height = scratchBig.canvas.height;
      clip.pictureCtx = clip.picture.getContext('2d');
    }
    const { picture, pictureCtx: ctx, video } = clip;
    const k = Math.min(picture.width / video.videoWidth, picture.height / video.videoHeight);
    ctx.clearRect(0, 0, picture.width, picture.height);
    ctx.drawImage(video, (picture.width - video.videoWidth * k) / 2, picture.height - video.videoHeight * k, video.videoWidth * k, video.videoHeight * k);
    clip.pictureTime = video.currentTime;
  }
  return clip.picture;
}

/** One frame of a sequence as a picture in the helper-frame shape: the clip, or else the drawn puppet. */
function sourceFrame(sequence, clip, t, expression, scratch = scratchSmall) {
  const picture = clipPicture(clip);
  if (picture) return picture;
  const { canvas, ctx, scale } = scratch;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawPuppet(ctx, sequence.puppet ?? FALLBACK_PUPPET, t, { expression });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

// ---------- where the head is ----------

const PROBE_W = 48;
const PROBE_H = 64;
const probe = document.createElement('canvas');
probe.width = PROBE_W;
probe.height = PROBE_H;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });

/**
 * Finds the top of the figure and the middle of its top part in a picture with a see-through
 * background. `paint` draws that picture, in helper-frame units, into the tiny canvas it is given
 * (tiny and kept in ordinary memory, so looking at it costs next to nothing).
 * Answers in helper-frame units (FRAME_W by FRAME_H), or null for an empty picture.
 */
function findHead(paint) {
  probeCtx.setTransform(1, 0, 0, 1, 0, 0);
  probeCtx.clearRect(0, 0, PROBE_W, PROBE_H);
  probeCtx.setTransform(PROBE_W / FRAME_W, 0, 0, PROBE_H / FRAME_H, 0, 0);
  paint(probeCtx);
  const data = probeCtx.getImageData(0, 0, PROBE_W, PROBE_H).data;
  const solid = (x, y) => data[(y * PROBE_W + x) * 4 + 3] > 96;
  let top = -1;
  let bodySum = 0;
  let bodyCount = 0;
  for (let y = 0; y < PROBE_H; y++) {
    let inRow = 0;
    for (let x = 0; x < PROBE_W; x++) if (solid(x, y)) { inRow++; bodySum += x; }
    bodyCount += inRow;
    if (top < 0 && inRow >= 2) top = y;
  }
  if (top < 0 || !bodyCount) return null;
  let sum = 0;
  let count = 0;
  for (let y = top; y < Math.min(PROBE_H, top + 8); y++) for (let x = 0; x < PROBE_W; x++) if (solid(x, y)) { sum += x; count++; }
  const body = bodySum / bodyCount;
  // An arm thrown above the head must not pull the picture sideways: stay near the body's middle.
  const x = Math.max(body - 7, Math.min(body + 7, count ? sum / count : body));
  return { x: (x + 0.5) / PROBE_W * FRAME_W, y: top / PROBE_H * FRAME_H };
}

/** A still picture of a sequence for printouts, as a canvas of the helper-frame size times `scale`. */
export async function renderStill(sequence, expression, scale = 2) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(FRAME_W * scale);
  canvas.height = Math.round(FRAME_H * scale);
  const ctx = canvas.getContext('2d');
  const url = sequence.stills?.[expression] ?? sequence.stills?.default;
  if (url) {
    try {
      const image = await loadImage(url);
      const k = Math.min(canvas.width / image.width, canvas.height / image.height);
      ctx.drawImage(image, (canvas.width - image.width * k) / 2, canvas.height - image.height * k, image.width * k, image.height * k);
      return canvas;
    } catch { /* fall through to a drawn frame */ }
  }
  ctx.scale(scale, scale);
  const clip = sequence.clip ? clips.get(`${sequence.clip}#0`) : null;
  const picture = clipPicture(clip);
  if (picture) ctx.drawImage(picture, 0, 0, FRAME_W, FRAME_H);
  else drawPuppet(ctx, sequence.puppet ?? FALLBACK_PUPPET, 0.42, { expression });
  return canvas;
}

/**
 * A head-and-shoulders picture of a sequence (see-through background), `width` by `height`.
 * `crop` is how much of the dancer's height it shows, counted down from the top of the head.
 */
export async function renderPortrait(sequence, expression, width, height, { crop = 0.42 } = {}) {
  const still = await renderStill(sequence, expression, HI);
  const head = findHead(ctx => ctx.drawImage(still, 0, 0, FRAME_W, FRAME_H)) ?? { x: FRAME_W / 2, y: FRAME_H * 0.08 };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const perUnit = still.width / FRAME_W;
  const cropH = FRAME_H * crop;
  const cropW = cropH * width / height;
  canvas.getContext('2d').drawImage(
    still,
    (head.x - cropW / 2) * perUnit, (head.y - cropH * 0.08) * perUnit, cropW * perUnit, cropH * perUnit,
    0, 0, width, height,
  );
  return canvas;
}

export class SequenceView {
  constructor(canvas, sequence, { effects = [], phase = 0, shot = 'full' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.phase = phase;
    this.shot = shot;
    this.slot = Math.min(CLIP_SLOTS - 1, Math.floor(phase * CLIP_SLOTS));
    this.fx = {};
    this.clipUrl = null;
    this.clip = null;
    this.hidden = false;
    this.head = null; // where the close-up is looking, moving smoothly
    this.headAt = -1;
    this.headFound = null;
    this.letters = null;
    this.setSequence(sequence);
    this.setEffects(effects);
  }

  setSequence(sequence) {
    this.sequence = sequence;
    this.letters = null;
    if (this.clipUrl !== sequence.clip) {
      returnClip(this.clip);
      this.clipUrl = sequence.clip ?? null;
      this.clip = this.clipUrl ? borrowClip(this.clipUrl, this.slot) : null;
    }
  }

  setEffects(effects) {
    this.fx = {};
    for (const { effect, amount } of effects ?? []) this.fx[effect] = amount ?? 1;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose() {
    returnClip(this.clip);
    this.clipUrl = null;
    this.clip = null;
  }

  /** The point a close-up looks at, following the head a few times a second and gliding in between. */
  lookAt(tt, time) {
    const clip = this.clip?.picture ? this.clip : null;
    const holder = clip ?? this; // windows showing the same clip share one look
    if (holder.headAt < 0 || time - holder.headAt > 0.09) {
      holder.headAt = time;
      const { video } = clip ?? {};
      const found = clip
        ? (clip.ready ? findHead(ctx => {
          const k = Math.min(FRAME_W / video.videoWidth, FRAME_H / video.videoHeight);
          ctx.drawImage(video, (FRAME_W - video.videoWidth * k) / 2, FRAME_H - video.videoHeight * k, video.videoWidth * k, video.videoHeight * k);
        }) : null)
        : findHead(ctx => drawPuppet(ctx, this.sequence.puppet ?? FALLBACK_PUPPET, tt, {}));
      holder.headFound = found ?? holder.headFound ?? null;
    }
    const found = holder.headFound ?? { x: FRAME_W / 2, y: FRAME_H * 0.1 };
    if (!this.head) this.head = { ...found };
    this.head.x += (found.x - this.head.x) * 0.12;
    this.head.y += (found.y - this.head.y) * 0.08;
    return this.head;
  }

  /** The name in big chunky letters, kept ready as its own picture. */
  titleLetters() {
    const { canvas } = this;
    if (this.letters?.width === canvas.width && this.letters?.height === canvas.height) return this.letters;
    const letters = document.createElement('canvas');
    letters.width = canvas.width;
    letters.height = canvas.height;
    const box = { x: canvas.width * 0.04, y: canvas.height * 0.2, width: canvas.width * 0.92, height: canvas.height * 0.6 };
    fitBlockText(letters.getContext('2d'), this.sequence.name, box, { color: '#0a0a0a', maxLines: 2, tall: 1.7 });
    this.letters = letters;
    return letters;
  }

  drawFrame(ctx, source, tt, offsetX) {
    const fx = this.fx;
    if (!fx.hatWobble) {
      ctx.drawImage(source, -FRAME_W / 2 + offsetX, -FRAME_H / 2, FRAME_W, FRAME_H);
      return;
    }
    // Everything above the hat line swings and shimmies; the rest stays put.
    const per = source.width / FRAME_W; // picture dots per helper-frame unit
    const hatY = Math.round((this.sequence.hatLine ?? 0.25) * FRAME_H);
    ctx.drawImage(source, 0, hatY * per, source.width, source.height - hatY * per, -FRAME_W / 2 + offsetX, -FRAME_H / 2 + hatY, FRAME_W, FRAME_H - hatY);
    ctx.save();
    ctx.translate(offsetX + Math.sin(tt * 17) * 3 * fx.hatWobble, -FRAME_H / 2 + hatY);
    ctx.rotate(Math.sin(tt * 11) * 0.2 * Math.min(2, fx.hatWobble));
    ctx.drawImage(source, 0, 0, source.width, hatY * per, -FRAME_W / 2, -hatY, FRAME_W, hatY);
    ctx.restore();
  }

  draw(time) {
    if (this.hidden) return;
    const { canvas, ctx, fx, shot } = this;
    const W = canvas.width;
    const H = canvas.height;
    const speed = (fx.fast ? 1 + 0.9 * fx.fast : 1) / (fx.slow ? 1 + 1.3 * fx.slow : 1);
    const tt = (time + this.phase * 5) * speed;
    const near = shot === 'closeup' || shot === 'face';
    const source = sourceFrame(this.sequence, this.clip, tt, null, near || H > FRAME_H * 1.3 ? scratchBig : scratchSmall);

    if (fx.trails) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0.04, 0.16 / fx.trails)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.clearRect(0, 0, W, H);
    }
    if (shot === 'title') ctx.drawImage(this.titleLetters(), 0, 0);

    const cells = fx.tile ? Math.min(4, 1 + Math.round(fx.tile * 1.4)) : 1;
    const cellW = W / cells;
    const cellH = H / cells;
    // How much of the dancer's height the window shows, and which point sits in its middle.
    const portion = shot === 'face' ? 0.27 : shot === 'closeup' ? 0.4 : 1;
    let fit = Math.min(cellW / FRAME_W, cellH / FRAME_H);
    let aimX = FRAME_W / 2;
    let aimY = FRAME_H / 2;
    if (near) {
      const head = this.lookAt(tt, time);
      fit = cellH / (FRAME_H * portion);
      aimX = head.x;
      aimY = head.y + FRAME_H * portion * (shot === 'face' ? 0.45 : 0.43);
    } else if (shot === 'title') {
      fit *= 0.94;
    }
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        ctx.save();
        ctx.translate(i * cellW + cellW / 2, j * cellH + cellH / 2);
        if (fx.jitter) ctx.translate((Math.random() - 0.5) * 7 * fx.jitter, (Math.random() - 0.5) * 7 * fx.jitter);
        if (fx.spin) ctx.rotate(tt * 1.5 * fx.spin);
        if (fx.wobble) ctx.rotate(Math.sin(tt * 7) * 0.16 * fx.wobble);
        let sx = fit;
        let sy = fit;
        if (fx.squash) { const q = Math.sin(tt * 6) * 0.18 * Math.min(2, fx.squash); sx *= 1 + q; sy *= 1 - q; }
        if (fx.pulse) { const q = 1 + Math.abs(Math.sin(tt * 3.8)) * 0.2 * Math.min(2, fx.pulse); sx *= q; sy *= q; }
        if (fx.mirror ? (i + j) % 2 === 0 : (i + j) % 2 === 1 && cells > 1) sx = -sx;
        ctx.scale(sx, sy);
        ctx.translate(FRAME_W / 2 - aimX, FRAME_H / 2 - aimY);
        if (fx.ghost) {
          ctx.globalAlpha = 0.25;
          for (const step of [-2, -1, 1, 2]) this.drawFrame(ctx, source, tt, step * 18 * fx.ghost * (0.6 + 0.4 * Math.sin(tt * 2)));
          ctx.globalAlpha = 1;
        }
        this.drawFrame(ctx, source, tt, 0);
        ctx.restore();
      }
    }

    if (fx.pixel) {
      const factor = 1 / (3 + 3 * fx.pixel);
      small.width = Math.max(8, Math.round(W * factor));
      small.height = Math.max(8, Math.round(H * factor));
      smallCtx.clearRect(0, 0, small.width, small.height);
      smallCtx.drawImage(canvas, 0, 0, small.width, small.height);
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, W, H);
      ctx.imageSmoothingEnabled = true;
    }

    const filters = [];
    if (fx.rainbow) filters.push(`hue-rotate(${Math.round((tt * 140 * fx.rainbow + this.phase * 360) % 360)}deg) saturate(1.5)`);
    if (fx.invert) filters.push('invert(1)');
    const filter = filters.join(' ');
    if (canvas.style.filter !== filter) canvas.style.filter = filter;
    const transform = fx.tumble
      ? `perspective(520px) rotateY(${(Math.sin(tt * 1.3) * 52 * Math.min(1.4, fx.tumble)).toFixed(1)}deg) rotateX(${(Math.cos(tt * 0.9) * 16 * Math.min(1.4, fx.tumble)).toFixed(1)}deg)`
      : '';
    if (canvas.style.transform !== transform) canvas.style.transform = transform;
  }
}

/** Keeps every visible view moving. With very many windows, each one is drawn every other frame. */
export class Stage {
  constructor() {
    this.views = new Set();
    this.frame = 0;
    this.running = false;
  }

  add(view) { this.views.add(view); this.start(); }
  remove(view) { this.views.delete(view); view.dispose(); }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = now => {
      if (!this.views.size) { this.running = false; return; }
      const time = now / 1000;
      const halve = this.views.size > 36;
      let index = 0;
      for (const view of this.views) {
        if (!halve || (index + this.frame) % 2 === 0) view.draw(time);
        index++;
      }
      this.frame++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
