// Drawn dancers. They need no files and no internet, so there is always something to load.
// Everything is drawn on a 240 x 320 frame with the feet near the bottom centre.

export const FRAME_W = 240;
export const FRAME_H = 320;
const TAU = Math.PI * 2;
const OUTLINE = '#15131a';

function limb(ctx, x1, y1, x2, y2, width, colour) {
  ctx.lineCap = 'round';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = width + 3;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

function blob(ctx, x, y, rx, ry, colour, rotation = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, TAU);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
}

function point(x, y, angle, length) {
  return [x + Math.sin(angle) * length, y + Math.cos(angle) * length];
}

/** Joint angles for each dance at time t (seconds). Angles are measured from "straight down". */
function pose(dance, t) {
  const beat = t * 1.9; // beats per second
  const s = Math.sin(beat * TAU / 2);
  const s2 = Math.sin(beat * TAU);
  const c = Math.cos(beat * TAU / 2);
  if (dance === 'strut') {
    const up = s > 0 ? 1 : 0; // which arm points at the ceiling
    return {
      sway: s * 16, bounce: Math.abs(s2) * 5, lean: s * 0.1, head: -s * 0.12,
      armL: up ? -2.6 + s2 * 0.15 : -0.9, foreL: up ? -2.9 + s2 * 0.2 : 0.9,
      armR: up ? 0.9 : 2.6 + s2 * 0.15, foreR: up ? -0.9 : 2.9 + s2 * 0.2,
      legL: -0.18 + Math.max(0, s) * 0.35, shinL: -0.05 - Math.max(0, s) * 0.5,
      legR: 0.18 - Math.max(0, -s) * 0.35, shinR: 0.05 + Math.max(0, -s) * 0.5,
      hip: s * 0.14,
    };
  }
  if (dance === 'twist') {
    return {
      sway: s * 8, bounce: Math.abs(s2) * 4, lean: s2 * 0.12, head: s * 0.1,
      armL: -1.9 + s2 * 0.5, foreL: -2.6 + s2 * 0.6, armR: 1.9 + s2 * 0.5, foreR: 2.6 + s2 * 0.6,
      legL: -0.25 + s2 * 0.22, shinL: 0.1 + s2 * 0.3, legR: 0.25 + s2 * 0.22, shinR: -0.1 + s2 * 0.3,
      hip: s2 * 0.2,
    };
  }
  // shuffle: the dependable office-party side to side
  return {
    sway: s * 20, bounce: Math.abs(s2) * 6, lean: -s * 0.08, head: s * 0.14,
    armL: -0.5 + c * 0.7, foreL: -1.5 + c * 0.5, armR: 0.5 + c * 0.7, foreR: 1.5 + c * 0.5,
    legL: -0.2 + Math.max(0, -c) * 0.45, shinL: -Math.max(0, -c) * 0.55,
    legR: 0.2 - Math.max(0, c) * 0.45, shinR: Math.max(0, c) * 0.55,
    hip: s * 0.1,
  };
}

function face(ctx, x, y, size, smiling, t) {
  const blink = Math.sin(t * 2.3) > 0.96;
  ctx.fillStyle = OUTLINE;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(x + side * size * 0.38, y - size * 0.12, size * 0.09, blink ? size * 0.02 : size * 0.12, 0, 0, TAU);
    ctx.fill();
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (smiling) {
    ctx.arc(x, y + size * 0.12, size * 0.42, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = 'rgba(230, 90, 110, 0.55)';
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(x + side * size * 0.6, y + size * 0.2, size * 0.13, 0, TAU); ctx.fill(); }
  } else {
    ctx.moveTo(x - size * 0.22, y + size * 0.36);
    ctx.lineTo(x + size * 0.22, y + size * 0.36);
    ctx.stroke();
  }
}

function celeryHead(ctx, x, y, smiling, t) {
  const stalks = [[-13, 6, '#8fc455'], [-4, -2, '#a6d468'], [5, 2, '#9bcc5e'], [13, 8, '#86bb4e']];
  for (const [dx, dy, colour] of stalks) {
    ctx.beginPath();
    ctx.roundRect(x + dx - 6, y - 44 + dy, 12, 60 - dy, 5);
    ctx.fillStyle = colour; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x + dx - 2, y - 38 + dy); ctx.lineTo(x + dx - 2, y + 8); ctx.stroke();
  }
  const leaves = [[-16, -46, 11], [-5, -56, 13], [8, -52, 12], [17, -42, 10], [0, -44, 10]];
  leaves.forEach(([dx, dy, r], i) => blob(ctx, x + dx + Math.sin(t * 3 + i) * 1.5, y + dy, r, r * 0.8, i % 2 ? '#4f9a3a' : '#5fae45'));
  if (smiling) face(ctx, x, y - 6, 16, true, t);
}

function wideHat(ctx, x, y, colour, t) {
  blob(ctx, x, y, 46, 9, colour);
  ctx.beginPath();
  ctx.roundRect(x - 19, y - 30, 38, 30, [12, 12, 2, 2]);
  ctx.fillStyle = colour; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.fillStyle = '#e6c53a';
  ctx.fillRect(x - 19, y - 9, 38, 5);
  ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.3 * Math.sin(t * 5)})`;
  ctx.fillRect(x - 12, y - 26, 4, 12);
}

function sparkles(ctx, points, t) {
  ctx.fillStyle = '#ffffff';
  points.forEach(([x, y], i) => {
    const twinkle = Math.sin(t * 7 + i * 1.7);
    if (twinkle < 0.35) return;
    const r = 1 + twinkle * 2.2;
    ctx.beginPath();
    ctx.moveTo(x, y - r * 1.6); ctx.lineTo(x + r * 0.4, y - r * 0.4); ctx.lineTo(x + r * 1.6, y);
    ctx.lineTo(x + r * 0.4, y + r * 0.4); ctx.lineTo(x, y + r * 1.6); ctx.lineTo(x - r * 0.4, y + r * 0.4);
    ctx.lineTo(x - r * 1.6, y); ctx.lineTo(x - r * 0.4, y - r * 0.4);
    ctx.closePath(); ctx.fill();
  });
}

function humanoid(ctx, style, dance, t, expression) {
  const p = pose(dance, t);
  const skin = style.skin ?? '#e8b796';
  const mannequin = style.mannequin === true;
  const mankini = style.mankini ?? null; // colour of the sling swimsuit, when worn
  const suit = mannequin || mankini ? skin : style.suit ?? '#777';
  const cx = FRAME_W / 2 + p.sway;
  const hipY = 196 - p.bounce;
  const shoulderY = hipY - 78;
  const shoulderX = cx + Math.sin(p.lean) * 78;
  const joint = (x, y) => { if (mannequin) blob(ctx, x, y, 5, 5, '#c99a78'); };

  // legs
  for (const [side, leg, shin] of [[-1, p.legL, p.shinL], [1, p.legR, p.shinR]]) {
    const hx = cx + side * 13 + p.hip * 20;
    const [kx, ky] = point(hx, hipY, leg, 50);
    const [fx, fy] = point(kx, ky, leg + shin, 50);
    limb(ctx, hx, hipY, kx, ky, 17, suit);
    limb(ctx, kx, ky, fx, fy, 15, suit);
    joint(kx, ky);
    blob(ctx, fx + side * 6, fy + 5, 15, 8, style.shoes ?? '#222');
  }

  // back arm first, then body, then front arm
  const arm = (side, upper, fore) => {
    const sx = shoulderX + side * 24;
    const [ex, ey] = point(sx, shoulderY + 6, upper, 38);
    const [hx, hy] = point(ex, ey, fore, 36);
    limb(ctx, sx, shoulderY + 6, ex, ey, 14, suit);
    limb(ctx, ex, ey, hx, hy, 12, suit);
    joint(ex, ey);
    blob(ctx, hx, hy, 8, 8, style.gloves ?? skin);
  };
  arm(-1, p.armL, p.foreL);

  // torso
  ctx.beginPath();
  ctx.moveTo(shoulderX - 28, shoulderY);
  ctx.lineTo(shoulderX + 28, shoulderY);
  ctx.lineTo(cx + 22 + p.hip * 20, hipY + 8);
  ctx.lineTo(cx - 22 + p.hip * 20, hipY + 8);
  ctx.closePath();
  ctx.fillStyle = suit; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = OUTLINE; ctx.lineJoin = 'round'; ctx.stroke();
  if (mannequin) {
    ctx.strokeStyle = 'rgba(120, 80, 50, 0.45)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(shoulderX, shoulderY + 4); ctx.lineTo(cx + p.hip * 20, hipY + 6); ctx.stroke();
    blob(ctx, cx + p.hip * 20, hipY + 4, 20, 7, '#d9a985');
  } else if (mankini) {
    // two straps from the shoulders down to a small pair of trunks
    const hipX = cx + p.hip * 20;
    ctx.beginPath();
    ctx.moveTo(hipX - 15, hipY - 6); ctx.lineTo(hipX + 15, hipY - 6); ctx.lineTo(hipX + 9, hipY + 12); ctx.lineTo(hipX - 9, hipY + 12);
    ctx.closePath();
    ctx.fillStyle = mankini; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = OUTLINE; ctx.stroke();
    for (const side of [-1, 1]) limb(ctx, shoulderX + side * 17, shoulderY + 2, hipX + side * 9, hipY - 5, 6, mankini);
  } else if (style.shirt) {
    ctx.beginPath();
    ctx.moveTo(shoulderX - 9, shoulderY); ctx.lineTo(shoulderX + 9, shoulderY); ctx.lineTo(shoulderX + (cx - shoulderX) * 0.5, shoulderY + 42);
    ctx.closePath(); ctx.fillStyle = style.shirt; ctx.fill();
    if (style.tie) {
      ctx.beginPath();
      ctx.moveTo(shoulderX - 3, shoulderY + 2); ctx.lineTo(shoulderX + 3, shoulderY + 2);
      ctx.lineTo(shoulderX + 5 + p.lean * 30, shoulderY + 34); ctx.lineTo(shoulderX + p.lean * 30, shoulderY + 42); ctx.lineTo(shoulderX - 5 + p.lean * 30, shoulderY + 34);
      ctx.closePath(); ctx.fillStyle = style.tie; ctx.fill();
    }
  }
  if (style.sparkle) {
    sparkles(ctx, [[shoulderX - 14, shoulderY + 18], [shoulderX + 12, shoulderY + 30], [cx - 8, hipY - 22], [cx + 14, hipY - 8], [cx - 16, hipY + 40], [cx + 18, hipY + 60], [shoulderX + 2, shoulderY + 52]], t);
  }
  arm(1, p.armR, p.foreR);

  // head
  const headX = shoulderX + Math.sin(p.head) * 26;
  const headY = shoulderY - 26;
  limb(ctx, shoulderX, shoulderY, headX, headY + 10, 10, style.head === 'celery' ? '#9fcf62' : skin);
  if (style.head === 'celery') {
    celeryHead(ctx, headX, headY + 6, expression === 'smiling', t);
  } else {
    blob(ctx, headX, headY, 21, 23, skin);
    if (!mannequin || expression === 'smiling') face(ctx, headX, headY + 2, 21, expression === 'smiling', t);
    if (style.hat === 'wide') wideHat(ctx, headX, headY - 17, style.hatColor ?? '#222', t);
  }
}

function shell(ctx, style, dance, t, expression) {
  const p = pose(dance, t);
  const cx = FRAME_W / 2 + p.sway;
  const bodyY = 168 - p.bounce;
  const open = 0.16 + Math.abs(Math.sin(t * 1.9 * Math.PI)) * 0.16;
  // legs
  for (const [side, leg, shin] of [[-1, p.legL, p.shinL], [1, p.legR, p.shinR]]) {
    const hx = cx + side * 20;
    const [kx, ky] = point(hx, bodyY + 48, leg, 38);
    const [fx, fy] = point(kx, ky, leg + shin, 38);
    limb(ctx, hx, bodyY + 48, kx, ky, 6, '#3b3440');
    limb(ctx, kx, ky, fx, fy, 6, '#3b3440');
    blob(ctx, fx + side * 7, fy + 4, 15, 8, style.shoes ?? '#3a2a55');
  }
  const arm = (side, upper, fore) => {
    const sx = cx + side * 58;
    const [ex, ey] = point(sx, bodyY + 4, upper, 30);
    const [hx, hy] = point(ex, ey, fore, 28);
    limb(ctx, sx, bodyY + 4, ex, ey, 6, '#3b3440');
    limb(ctx, ex, ey, hx, hy, 6, '#3b3440');
    blob(ctx, hx, hy, 10, 10, style.gloves ?? '#fff');
  };
  arm(-1, p.armL, p.foreL);
  arm(1, p.armR, p.foreR);

  ctx.save();
  ctx.translate(cx, bodyY);
  ctx.rotate(p.lean * 1.4);
  // lower shell with the face
  const half = (flip, colour, lift) => {
    ctx.save();
    ctx.rotate(flip * lift);
    ctx.beginPath();
    ctx.ellipse(0, flip * 4, 66, 58, 0, flip > 0 ? 0 : Math.PI, flip > 0 ? Math.PI : TAU);
    ctx.closePath();
    ctx.fillStyle = colour; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.strokeStyle = style.shellDark ?? '#8c8577'; ctx.lineWidth = 2;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath(); ctx.moveTo(i * 5, flip * 8); ctx.lineTo(i * 17, flip * (50 - Math.abs(i) * 5)); ctx.stroke();
    }
    ctx.restore();
  };
  // the soft inside and the pearl show through the gap
  blob(ctx, 0, 0, 60, 16 + open * 40, style.inside ?? '#f3e9dc');
  blob(ctx, 22, -2, 10, 10, style.pearl ?? '#fff');
  ctx.fillStyle = 'rgba(160,190,255,0.7)'; ctx.beginPath(); ctx.arc(19, -5, 3, 0, TAU); ctx.fill();
  half(-1, style.shell ?? '#b9b3a6', open);
  half(1, style.shell ?? '#b9b3a6', open * 0.25);
  face(ctx, -6, 32, 26, expression === 'smiling', t);
  ctx.restore();
}

/** Draws one frame of a puppet. `spec` comes from sequence.json. */
export function drawPuppet(ctx, spec, t, { expression = null } = {}) {
  const style = spec?.style ?? {};
  ctx.save();
  // a soft shadow on the floor
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(FRAME_W / 2, 304, 62, 9, 0, 0, TAU); ctx.fill();
  if (spec?.rig === 'shell') shell(ctx, style, spec.dance ?? 'twist', t, expression);
  else humanoid(ctx, style, spec?.dance ?? 'shuffle', t, expression);
  ctx.restore();
}
