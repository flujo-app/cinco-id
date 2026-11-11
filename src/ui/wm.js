// A small window manager in the look of the computer in the sketch: open, close, drag, minimise,
// maximise, plus the window-level effects (drift, conga, giant, tiny, free).
//
// Two kinds of window frame, both from the sketch:
//   plain  a white title bar with the title, a "Close" button and the two small arrow buttons
//   blue   a blue bar instead of the title, the title on its own line underneath, and a thin
//          strip at the bottom (the close-up windows and the incoming call)

const SIZES = {
  // by shot, then by size: [width, height] of the picture
  sequence: {
    full: { small: [128, 170], medium: [186, 248], large: [276, 368], wide: [400, 300] },
    closeup: { small: [160, 120], medium: [216, 162], large: [288, 216], wide: [288, 216] },
    face: { small: [128, 170], medium: [186, 248], large: [246, 328], wide: [246, 328] },
    title: { small: [208, 146], medium: [272, 190], large: [330, 232], wide: [330, 232] },
  },
  console: [440, 172],
  dialog: [340, null],
  call: [236, null],
  printout: [320, 426],
  note: [350, null],
  progress: [400, null],
  setup: [580, 420],
  splash: [470, null],
  chooser: [470, null],
};
const WINDOW_EFFECTS = new Set(['drift', 'conga', 'giant', 'tiny', 'free']);

function seeded(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class WindowManager {
  constructor({ desktop, tasks, builders, onClosed, onChanged }) {
    this.desktop = desktop;
    this.tasks = tasks;
    this.builders = builders;
    this.onClosed = onClosed;
    this.onChanged = onChanged; // a window was opened or closed
    this.stacks = new Map(); // where each cascade of windows starts
    this.windows = new Map();
    this.z = 10;
    this.cascade = 0;
    this.openQueue = [];
    this.opening = false;
    this.moving = false;
    this.congaIndex = 0;
  }

  bounds() {
    return { width: this.desktop.clientWidth, height: this.desktop.clientHeight };
  }

  /** Windows that arrive in a burst open one after another, a few per frame, like the real thing. */
  open(desc, { instant = false } = {}) {
    if (instant) return this.create(desc);
    this.openQueue.push(desc);
    if (this.opening) return;
    this.opening = true;
    const step = () => {
      const batch = this.openQueue.length > 30 ? 3 : this.openQueue.length > 8 ? 2 : 1;
      for (let i = 0; i < batch && this.openQueue.length; i++) this.create(this.openQueue.shift());
      if (this.openQueue.length) setTimeout(step, 38);
      else this.opening = false;
    };
    step();
  }

  place(desc, width, height) {
    const { width: W, height: H } = this.bounds();
    const random = seeded(desc.id);
    const clampX = x => Math.max(0, Math.min(W - width, x));
    const clampY = y => Math.max(0, Math.min(H - height, y));
    if (desc.kind === 'sequence') {
      if (desc.stack) {
        // A neat pile: every window a step further along than the one before.
        const [dx, dy] = desc.stack.step ?? [26, 24];
        const count = Math.max(1, desc.stack.count ?? 1);
        if (!this.stacks.has(desc.stack.id)) {
          const base = seeded(desc.stack.id);
          const spanX = dx * (count - 1) + width;
          const spanY = dy * (count - 1) + height;
          this.stacks.set(desc.stack.id, [
            Math.max(0, W * 0.3 + base() * Math.max(0, W * 0.66 - spanX)),
            Math.max(0, H * 0.04 + base() * Math.max(0, H * 0.9 - spanY)),
          ]);
          if (this.stacks.size > 40) this.stacks.delete(this.stacks.keys().next().value);
        }
        const [x0, y0] = this.stacks.get(desc.stack.id);
        return [clampX(x0 + dx * desc.stack.index), clampY(y0 + dy * desc.stack.index)];
      }
      if (desc.spot === 'left') return [clampX(W * 0.2 - width / 2), clampY(H * 0.44 - height / 2)];
      if (desc.group) return [clampX(random() * (W - width)), clampY(random() * (H - height))];
      // As in the sketch: the whole dancer to the right, the close-up to the left of it.
      const others = [...this.windows.values()].filter(record => record.desc.kind === 'sequence' && !record.desc.group && record !== this.windows.get(desc.id)).length;
      const loose = others > 1 ? 1 : 0;
      if (desc.shot === 'closeup') return [clampX(W * 0.3 - width / 2 + (random() - 0.5) * W * 0.3 * loose), clampY(H * 0.36 - height / 2 + (random() - 0.5) * H * 0.4 * loose)];
      if (desc.shot === 'title') return [clampX(W * 0.34 - width / 2), clampY(H * 0.46 - height / 2)];
      return [clampX(W * 0.66 - width / 2 + (random() - 0.5) * W * 0.4 * loose), clampY(H * 0.45 - height / 2 + (random() - 0.5) * H * 0.3 * loose)];
    }
    if (desc.kind === 'console') return [16, clampY(H - height - 12)];
    if (desc.kind === 'dialog') return [clampX((W - width) / 2), clampY(H * 0.32)];
    if (desc.kind === 'setup' || desc.kind === 'chooser') return [clampX((W - width) / 2), clampY((H - height) / 2)];
    if (desc.kind === 'splash') return [clampX((W - width) / 2), clampY(H * 0.42 - height / 2)];
    if (desc.kind === 'call') {
      const slot = this.cascade++ % 4;
      return [clampX((W - width) / 2 + slot * 22), clampY(H * 0.4 - height / 2 + slot * 22)];
    }
    if (desc.kind === 'printout') return [clampX(W - width - 60), clampY(H * 0.2)];
    if (desc.kind === 'progress') return [clampX((W - width) / 2), clampY(H * 0.4 - height / 2)];
    const slot = this.cascade++ % 6;
    return [clampX(40 + slot * 22), clampY(40 + slot * 22)];
  }

  create(desc) {
    if (this.windows.has(desc.id)) return this.windows.get(desc.id);
    const shots = SIZES.sequence[desc.shot] ?? SIZES.sequence.full;
    const size = desc.kind === 'sequence' ? shots[desc.size] ?? shots.medium : SIZES[desc.kind] ?? SIZES.note;
    const [bodyW, bodyH] = size;
    const blue = desc.kind === 'call' || (desc.kind === 'sequence' && (desc.shot === 'closeup' || desc.shot === 'title'));
    const frame = el('div', `window kind-${desc.kind}${blue ? ' blue' : ''}`);
    const titleBar = el('div', 'title-bar');
    const menuBox = el('div', 'tb-menu'); // the little box on the left; a double click closes, as it used to
    const titleText = el('div', 'title-text', desc.title ?? '');
    const bar = blue ? el('div', 'title-fill') : titleText;
    const close = el('button', 'tb-button tb-close', 'Close');
    const minimise = el('button', 'tb-button tb-min');
    const maximise = el('button', 'tb-button tb-max');
    minimise.title = 'Minimise'; maximise.title = 'Maximise'; close.title = 'Close';
    titleBar.append(menuBox, bar, close, minimise, maximise);
    const body = el('div', 'window-body');
    frame.append(titleBar);
    if (blue) { titleText.className = 'name-row'; frame.append(titleText); }
    frame.append(body);
    if (blue) frame.append(el('div', 'foot-row'));
    frame.style.width = `${bodyW + 8}px`;
    if (bodyH) body.style.height = `${bodyH}px`;

    const record = { id: desc.id, desc, frame, body, titleText, bodyW, bodyH, x: 0, y: 0, scale: 1, effects: new Set(), view: null, cleanup: null, minimised: false, maximised: false, dragging: false };
    this.windows.set(desc.id, record);
    this.desktop.append(frame);
    this.builders[desc.kind]?.(record, desc, this);
    const height = frame.offsetHeight;
    [record.x, record.y] = this.place(desc, bodyW + 8, height);
    record.height = height;
    this.position(record);
    this.focus(record.id);
    this.applyWindowEffects(record, desc.effects ?? []);

    close.addEventListener('click', event => { event.stopPropagation(); this.close(desc.id, { byHand: true }); });
    menuBox.addEventListener('dblclick', event => { event.stopPropagation(); this.close(desc.id, { byHand: true }); });
    minimise.addEventListener('click', event => { event.stopPropagation(); this.minimise(record, true); });
    maximise.addEventListener('click', event => { event.stopPropagation(); this.toggleMaximise(record); });
    frame.addEventListener('pointerdown', () => this.focus(desc.id));
    this.makeDraggable(record, titleBar);
    frame.classList.add('opening');
    setTimeout(() => frame.classList.remove('opening'), 160);
    if (desc.autoClose) setTimeout(() => this.close(desc.id, { byHand: true }), desc.autoClose);
    this.refreshTasks();
    this.onChanged?.();
    return record;
  }

  position(record) {
    record.frame.style.left = `${Math.round(record.x)}px`;
    record.frame.style.top = `${Math.round(record.y)}px`;
  }

  focus(id) {
    const record = this.windows.get(id);
    if (!record) return;
    for (const other of this.windows.values()) other.frame.classList.toggle('active', other === record);
    // The console, questions and calls always stay above the dancers, however many there are.
    // A call even comes in front of the Setup window (so "Test call window" there is seen).
    const layer = { console: 1_000_000, dialog: 3_000_000, call: 2_700_000, setup: 2_500_000, splash: 1_500_000, chooser: 1_400_000, progress: 1_200_000 }[record.desc.kind] ?? 0;
    record.frame.style.zIndex = String(layer + ++this.z);
  }

  makeDraggable(record, handle) {
    handle.addEventListener('pointerdown', event => {
      if (event.target.closest('.tb-button, .tb-menu') || record.maximised) return;
      const startX = event.clientX - record.x;
      const startY = event.clientY - record.y;
      record.dragging = true;
      handle.setPointerCapture(event.pointerId);
      const move = moveEvent => {
        record.x = moveEvent.clientX - startX;
        record.y = Math.max(0, moveEvent.clientY - startY);
        this.position(record);
      };
      const up = () => {
        record.dragging = false;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  minimise(record, minimised) {
    record.minimised = minimised;
    record.frame.classList.toggle('minimised', minimised);
    if (record.view) record.view.hidden = minimised;
    if (!minimised) this.focus(record.id);
    this.refreshTasks();
  }

  toggleMaximise(record) {
    record.maximised = !record.maximised;
    record.frame.classList.toggle('maximised', record.maximised);
    record.onResize?.();
  }

  close(id, { byHand = false } = {}) {
    this.openQueue = this.openQueue.filter(desc => desc.id !== id);
    const record = this.windows.get(id);
    if (!record) return;
    this.windows.delete(id);
    record.cleanup?.();
    record.frame.remove();
    if (byHand) this.onClosed?.(id, record.desc);
    this.refreshTasks();
    this.onChanged?.();
  }

  closeAll(filter = () => true) {
    for (const record of [...this.windows.values()]) if (filter(record)) this.close(record.id);
  }

  setTitle(id, title) {
    const record = this.windows.get(id);
    if (!record) return;
    record.desc.title = title;
    record.titleText.textContent = title;
    this.refreshTasks();
  }

  // ---------- effects that move or change the window itself ----------

  applyWindowEffects(record, effects) {
    const wanted = new Map(effects.filter(effect => WINDOW_EFFECTS.has(effect.effect)).map(effect => [effect.effect, effect.amount ?? 1]));
    record.effects = wanted;
    record.frame.classList.toggle('free', wanted.has('free'));
    record.scale = wanted.has('giant') ? 1 + 0.45 * Math.min(2, wanted.get('giant')) : wanted.has('tiny') ? 1 / (1 + 0.6 * Math.min(2, wanted.get('tiny'))) : 1;
    record.frame.style.scale = record.scale === 1 ? '' : String(record.scale.toFixed(2));
    if (wanted.has('drift') && !record.velocity) {
      const random = seeded(`v${record.id}`);
      const angle = random() * Math.PI * 2;
      const speed = 40 + random() * 70;
      record.velocity = [Math.cos(angle) * speed, Math.sin(angle) * speed];
    }
    if (!wanted.has('drift')) record.velocity = null;
    if (wanted.has('conga') && record.congaSlot === undefined) record.congaSlot = this.congaIndex++;
    if (!wanted.has('conga')) record.congaSlot = undefined;
    if (wanted.has('drift') || wanted.has('conga')) this.startMoving();
  }

  startMoving() {
    if (this.moving) return;
    this.moving = true;
    let last = performance.now();
    const tick = now => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { width: W, height: H } = this.bounds();
      let any = false;
      for (const record of this.windows.values()) {
        if (record.dragging || record.minimised || record.maximised) continue;
        const w = record.frame.offsetWidth || record.bodyW + 8;
        const h = record.height ?? 200;
        if (record.congaSlot !== undefined) {
          any = true;
          const amount = record.effects.get('conga') ?? 1;
          const a = now / 1000 * 0.5 * amount - record.congaSlot * 0.33;
          record.x = W / 2 - w / 2 + Math.cos(a) * (W * 0.38);
          record.y = H / 2 - h / 2 + Math.sin(a * 2) * (H * 0.3);
          this.position(record);
        } else if (record.velocity) {
          any = true;
          const amount = record.effects.get('drift') ?? 1;
          record.x += record.velocity[0] * dt * amount;
          record.y += record.velocity[1] * dt * amount;
          if (record.x < 0) { record.x = 0; record.velocity[0] = Math.abs(record.velocity[0]); }
          if (record.x > W - w) { record.x = Math.max(0, W - w); record.velocity[0] = -Math.abs(record.velocity[0]); }
          if (record.y < 0) { record.y = 0; record.velocity[1] = Math.abs(record.velocity[1]); }
          if (record.y > H - h) { record.y = Math.max(0, H - h); record.velocity[1] = -Math.abs(record.velocity[1]); }
          this.position(record);
        }
      }
      if (any) requestAnimationFrame(tick);
      else this.moving = false;
    };
    requestAnimationFrame(tick);
  }

  // ---------- minimised windows: little icons along the bottom, as before there were taskbars ----------

  refreshTasks() {
    if (this.refreshing) return;
    this.refreshing = true;
    queueMicrotask(() => {
      this.refreshing = false;
      const groups = new Map();
      for (const record of this.windows.values()) {
        if (!record.minimised) continue;
        const title = record.desc.title ?? '';
        if (!groups.has(title)) groups.set(title, []);
        groups.get(title).push(record);
      }
      this.tasks.replaceChildren();
      let shown = 0;
      for (const [title, records] of groups) {
        if (shown++ >= 9) {
          this.tasks.append(el('div', 'task-more', `+${groups.size - 9} more`));
          break;
        }
        const button = el('button', 'task-button');
        button.append(el('i', 'task-art'), el('span', '', records.length > 1 ? `${title} (${records.length})` : title));
        button.title = 'Click to bring it back';
        button.addEventListener('click', () => { for (const record of records) this.minimise(record, false); });
        this.tasks.append(button);
      }
    });
  }
}
