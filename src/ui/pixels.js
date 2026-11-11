// Things drawn from little squares and strokes, so no font or picture file is needed:
// the chunky letters (the TAYNE title card, the caller's name), the red number display of the
// call window, and the Cinco banner with the grid head.

const GLYPHS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  "'": ['..#..', '..#..', '.....', '.....', '.....', '.....', '.....'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};
const GLYPH_W = 5;
const GLYPH_H = 7;

/** Letters this font can draw; anything else (accents and so on) is simplified first. */
function plain(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9\-+.!?'&() ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** How many squares wide a line of chunky letters is. */
export function blockTextCells(text) {
  const line = plain(text);
  return line.length ? line.length * (GLYPH_W + 1) - 1 : 0;
}

/** Draws one line of chunky letters with its top-left corner at x, y. */
export function drawBlockText(ctx, text, x, y, cellW, cellH = cellW, color = '#000') {
  const line = plain(text);
  ctx.fillStyle = color;
  let at = x;
  for (const ch of line) {
    const rows = GLYPHS[ch] ?? GLYPHS[' '];
    for (let r = 0; r < GLYPH_H; r++) {
      for (let c = 0; c < GLYPH_W; c++) {
        // Squares overlap by a hair so no thin gaps show between them.
        if (rows[r][c] === '#') ctx.fillRect(Math.floor(at + c * cellW), Math.floor(y + r * cellH), Math.ceil(cellW + 0.5), Math.ceil(cellH + 0.5));
      }
    }
    at += (GLYPH_W + 1) * cellW;
  }
}

/**
 * Chunky text fitted into a box: as big as fits, on up to `maxLines` lines, centred.
 * Returns false when it cannot be made to fit readably (the caller then shows ordinary text).
 */
export function fitBlockText(ctx, text, box, { color = '#000', maxLines = 2, tall = 1.25, minCell = 2 } = {}) {
  const words = plain(text).split(' ').filter(Boolean);
  if (!words.length) return false;
  let best = null;
  for (let lines = 1; lines <= Math.min(maxLines, words.length); lines++) {
    // Split the words over `lines` lines as evenly as possible.
    const rows = [];
    const total = words.join(' ').length;
    let row = '';
    for (const word of words) {
      const next = row ? `${row} ${word}` : word;
      if (row && rows.length < lines - 1 && next.length > Math.ceil(total / lines)) { rows.push(row); row = word; } else row = next;
    }
    rows.push(row);
    const widest = Math.max(...rows.map(blockTextCells));
    const cellW = Math.min(box.width / widest, box.height / (rows.length * GLYPH_H * tall + (rows.length - 1) * tall * 1.5));
    if (!best || cellW > best.cellW) best = { rows, cellW };
  }
  const cellW = Math.floor(best.cellW * 2) / 2;
  if (cellW < minCell) return false;
  const cellH = cellW * tall;
  const lineH = GLYPH_H * cellH + cellH * 1.5;
  const height = best.rows.length * lineH - cellH * 1.5;
  let y = box.y + (box.height - height) / 2;
  for (const line of best.rows) {
    drawBlockText(ctx, line, box.x + (box.width - blockTextCells(line) * cellW) / 2, y, cellW, cellH, color);
    y += lineH;
  }
  return true;
}

// ---------- the red number display ----------

//          a
//        f   b
//          g
//        e   c
//          d
const SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '',
};

/** Draws a phone number as glowing red display digits, fitted into the canvas. */
export function drawLed(canvas, text) {
  const ctx = canvas.getContext('2d');
  const shown = String(text ?? '').replace(/[^0-9+\- ]/g, '').slice(0, 18) || '-------';
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#1c0303';
  ctx.fillRect(0, 0, W, H);
  const pad = 6;
  const slot = Math.min((W - pad * 2) / shown.length, (H - pad * 2) * 0.62);
  const w = slot * 0.72;
  const h = Math.min(H - pad * 2, slot * 1.55);
  const t = Math.max(1.5, w * 0.2); // how thick a segment is
  const left = (W - slot * shown.length) / 2;
  const top = (H - h) / 2;
  const bar = (x, y, bw, bh, lit) => {
    ctx.fillStyle = lit ? '#ff2b1c' : '#3a0806';
    ctx.shadowColor = lit ? '#ff1a0a' : 'transparent';
    ctx.shadowBlur = lit ? t * 1.4 : 0;
    ctx.fillRect(x, y, bw, bh);
  };
  ctx.save();
  ctx.transform(1, 0, -0.12, 1, h * 0.06, 0); // display digits lean a little
  [...shown].forEach((ch, i) => {
    const x = left + i * slot + (slot - w) / 2;
    const y = top;
    const on = ch === '+' ? 'g' : SEGMENTS[ch] ?? '';
    const half = (h - t) / 2;
    const parts = {
      a: [x + t, y, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t], g: [x + t, y + half, w - 2 * t, t],
      f: [x, y + t * 0.5, t, half - t * 0.2], b: [x + w - t, y + t * 0.5, t, half - t * 0.2],
      e: [x, y + half + t * 0.7, t, half - t * 0.2], c: [x + w - t, y + half + t * 0.7, t, half - t * 0.2],
    };
    if (ch !== '+' && ch !== '-' && ch !== ' ') for (const key of 'abcdefg') if (!on.includes(key)) bar(...parts[key], false);
    for (const key of on) bar(...parts[key], true);
    if (ch === '+') bar(x + w / 2 - t / 2, y + half - (w - 2 * t) / 2 + t / 2, t, w - 2 * t, true);
  });
  ctx.restore();
}

// ---------- the Cinco banner: an orange sky with a head made of grid lines ----------

function headPath(ctx, cx, top, size) {
  // A head, a neck and the start of the shoulders, as one outline. `size` is the head's height.
  const rx = size * 0.43;
  const ry = size * 0.5;
  const cy = top + ry;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.rect(cx - rx * 0.42, cy + ry * 0.7, rx * 0.84, ry * 0.7);
  ctx.moveTo(cx - rx * 1.5, top + size * 1.6);
  ctx.quadraticCurveTo(cx - rx * 1.4, top + size * 1.22, cx - rx * 0.42, top + size * 1.2);
  ctx.lineTo(cx + rx * 0.42, top + size * 1.2);
  ctx.quadraticCurveTo(cx + rx * 1.4, top + size * 1.22, cx + rx * 1.5, top + size * 1.6);
  ctx.closePath();
}

/** Paints the banner over the whole canvas. */
export function drawBanner(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const sky = ctx.createLinearGradient(0, 0, W, 0);
  sky.addColorStop(0, '#f39a0e');
  sky.addColorStop(0.2, '#fbd92c');
  sky.addColorStop(0.42, '#fde23c');
  sky.addColorStop(0.72, '#fba413');
  sky.addColorStop(1, '#f58a0c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.08, H * 0.1, 0, W * 0.08, H * 0.1, W * 0.3);
  glow.addColorStop(0, 'rgba(255,170,90,0.75)');
  glow.addColorStop(1, 'rgba(255,170,90,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const size = H * 0.64;
  const cx = W / 2;
  const top = H * 0.07;
  ctx.save();
  headPath(ctx, cx, top, size);
  ctx.clip();
  const skin = ctx.createLinearGradient(cx - size * 0.5, 0, cx + size * 0.5, 0);
  skin.addColorStop(0, '#1d5fd8');
  skin.addColorStop(0.28, '#0e2f8e');
  skin.addColorStop(1, '#040a2a');
  ctx.fillStyle = skin;
  ctx.fillRect(0, 0, W, H);
  const shine = ctx.createRadialGradient(cx - size * 0.24, top + size * 0.34, 0, cx - size * 0.24, top + size * 0.34, size * 0.3);
  shine.addColorStop(0, 'rgba(120,150,255,0.85)');
  shine.addColorStop(1, 'rgba(120,150,255,0)');
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, W, H);
  // The grid: lines bulge a little, as if drawn on a ball.
  ctx.strokeStyle = 'rgba(200,225,255,0.6)';
  ctx.lineWidth = Math.max(1, H / 160);
  const step = size / 9;
  for (let i = -6; i <= 6; i++) {
    ctx.beginPath();
    ctx.moveTo(cx + i * step, top - 4);
    ctx.quadraticCurveTo(cx + i * step * 1.12, top + size * 0.5, cx + i * step, top + size * 1.7);
    ctx.stroke();
  }
  for (let j = 0; j <= 16; j++) {
    const y = top + j * step;
    ctx.beginPath();
    ctx.moveTo(cx - size, y);
    ctx.quadraticCurveTo(cx, y + step * 0.18, cx + size, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** A small picture of the head alone, for desktop icons and buttons. */
export function drawHeadIcon(canvas, { back = '#f7b21a' } = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = back;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  headPath(ctx, W / 2, H * 0.1, H * 0.62);
  ctx.fillStyle = '#0b1f6b';
  ctx.fill();
  ctx.restore();
}

/** A ringing telephone handset, for the call window. */
export function drawPhone(canvas, color = '#fff') {
  const ctx = canvas.getContext('2d');
  const unit = Math.min(canvas.width, canvas.height) / 100;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2 + 4 * unit, canvas.height / 2 + 8 * unit);
  ctx.scale(unit, unit);
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.save();
  ctx.rotate(-Math.PI * 0.72); // the handset, tilted as if it had just been knocked off its cradle
  ctx.lineWidth = 13;
  ctx.beginPath();
  ctx.moveTo(-27, -2);
  ctx.quadraticCurveTo(0, -24, 27, -2);
  ctx.stroke();
  ctx.lineWidth = 20;
  ctx.beginPath(); ctx.moveTo(-29, 2); ctx.lineTo(-27, 9); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(29, 2); ctx.lineTo(27, 9); ctx.stroke();
  ctx.restore();
  // the little arcs that say it is ringing
  ctx.lineWidth = 5;
  for (const radius of [15, 27, 39]) {
    ctx.beginPath();
    ctx.arc(-14, -8, radius, -Math.PI * 0.98, -Math.PI * 0.52);
    ctx.stroke();
  }
  ctx.restore();
}
