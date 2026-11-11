// Draws sequences (dancers) into windows and applies the effects.
// One shared helper frame is drawn per view, then composed onto the window's canvas.

import { drawPuppet, FRAME_W, FRAME_H } from './puppets.js';

const scratch = document.createElement('canvas');
scratch.width = FRAME_W;
scratch.height = FRAME_H;
const sctx = scratch.getContext('2d');
const small = document.createElement('canvas');
const smallCtx = small.getContext('2d');

const FALLBACK_PUPPET = { rig: 'humanoid', dance: 'shuffle', style: { suit: '#666', skin: '#e8b796', shoes: '#222' } };

// Generated clips are shared: one video per file, however many windows show it.
const clips = new Map();
function borrowClip(url) {
  let clip = clips.get(url);
  if (!clip) {
    const video = document.createElement('video');
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.play().catch(() => {});
    clip = { video, users: 0, get ready() { return video.readyState >= 2 && video.videoWidth > 0; } };
    clips.set(url, clip);
  }
  clip.users++;
  return clip;
}
function returnClip(url) {
  const clip = clips.get(url);
  if (!clip || --clip.users > 0) return;
  clip.video.pause();
  clip.video.removeAttribute('src');
  clip.video.load();
  clips.delete(url);
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

/** Puts one frame of a sequence into the shared helper frame and returns it. */
function sourceFrame(sequence, clip, t, expression) {
  sctx.clearRect(0, 0, FRAME_W, FRAME_H);
  if (clip?.ready) {
    const { videoWidth: w, videoHeight: h } = clip.video;
    const k = Math.min(FRAME_W / w, FRAME_H / h);
    sctx.drawImage(clip.video, (FRAME_W - w * k) / 2, FRAME_H - h * k, w * k, h * k);
  } else {
    drawPuppet(sctx, sequence.puppet ?? FALLBACK_PUPPET, t, { expression });
  }
  return scratch;
}

/** A still picture of a sequence for printouts, as a canvas of the helper-frame size times `scale`. */
export async function renderStill(sequence, expression, scale = 2) {
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W * scale;
  canvas.height = FRAME_H * scale;
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
  const clip = sequence.clip ? clips.get(sequence.clip) : null;
  if (clip?.ready) ctx.drawImage(sourceFrame(sequence, clip, 0, expression), 0, 0);
  else drawPuppet(ctx, sequence.puppet ?? FALLBACK_PUPPET, 0.42, { expression });
  return canvas;
}

export class SequenceView {
  constructor(canvas, sequence, { effects = [], phase = 0 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.phase = phase;
    this.fx = {};
    this.clipUrl = null;
    this.clip = null;
    this.hidden = false;
    this.setSequence(sequence);
    this.setEffects(effects);
  }

  setSequence(sequence) {
    this.sequence = sequence;
    if (this.clipUrl !== sequence.clip) {
      if (this.clipUrl) returnClip(this.clipUrl);
      this.clipUrl = sequence.clip ?? null;
      this.clip = this.clipUrl ? borrowClip(this.clipUrl) : null;
    }
  }

  setEffects(effects) {
    this.fx = {};
    for (const { effect, amount } of effects ?? []) this.fx[effect] = amount ?? 1;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose() {
    if (this.clipUrl) returnClip(this.clipUrl);
    this.clipUrl = null;
    this.clip = null;
  }

  drawFrame(ctx, source, tt, offsetX) {
    const fx = this.fx;
    if (!fx.hatWobble) {
      ctx.drawImage(source, -FRAME_W / 2 + offsetX, -FRAME_H / 2);
      return;
    }
    // Everything above the hat line swings and shimmies; the rest stays put.
    const hatY = Math.round((this.sequence.hatLine ?? 0.25) * FRAME_H);
    ctx.drawImage(source, 0, hatY, FRAME_W, FRAME_H - hatY, -FRAME_W / 2 + offsetX, -FRAME_H / 2 + hatY, FRAME_W, FRAME_H - hatY);
    ctx.save();
    ctx.translate(offsetX + Math.sin(tt * 17) * 3 * fx.hatWobble, -FRAME_H / 2 + hatY);
    ctx.rotate(Math.sin(tt * 11) * 0.2 * Math.min(2, fx.hatWobble));
    ctx.drawImage(source, 0, 0, FRAME_W, hatY, -FRAME_W / 2, -hatY, FRAME_W, hatY);
    ctx.restore();
  }

  draw(time) {
    if (this.hidden) return;
    const { canvas, ctx, fx } = this;
    const W = canvas.width;
    const H = canvas.height;
    const speed = (fx.fast ? 1 + 0.9 * fx.fast : 1) / (fx.slow ? 1 + 1.3 * fx.slow : 1);
    const tt = (time + this.phase * 5) * speed;
    const source = sourceFrame(this.sequence, this.clip, tt, null);

    if (fx.trails) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0.04, 0.16 / fx.trails)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.clearRect(0, 0, W, H);
    }

    const cells = fx.tile ? Math.min(4, 1 + Math.round(fx.tile * 1.4)) : 1;
    const cellW = W / cells;
    const cellH = H / cells;
    const fit = Math.min(cellW / FRAME_W, cellH / FRAME_H);
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
