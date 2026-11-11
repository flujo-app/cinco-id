// A small Win95-style window manager: open, close, drag, minimise, maximise, taskbar,
// plus the window-level effects (drift, conga, giant, tiny, free).

const SIZES = {
  sequence: { small: [128, 170], medium: [186, 248], large: [276, 368] },
  console: [400, 290],
  dialog: [340, null],
  call: [310, null],
  printout: [300, 400],
  note: [350, null],
  progress: [330, null],
  setup: [560, 384],
};
const TITLE_H = 22;
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
  constructor({ desktop, tasks, builders, onClosed }) {
    this.desktop = desktop;
    this.tasks = tasks;
    this.builders = builders;
    this.onClosed = onClosed;
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
      if (desc.group) return [clampX(random() * (W - width)), clampY(random() * (H - height))];
      const others = [...this.windows.values()].filter(record => record.desc.kind === 'sequence').length;
      if (!others) return [clampX(W * 0.5 - width / 2), clampY(H * 0.46 - height / 2)];
      return [clampX(W * 0.5 - width / 2 + (random() - 0.5) * W * 0.55), clampY(H * 0.46 - height / 2 + (random() - 0.5) * H * 0.3)];
    }
    if (desc.kind === 'console') return [16, clampY(H - height - 16)];
    if (desc.kind === 'dialog') return [clampX((W - width) / 2), clampY(H * 0.32)];
    if (desc.kind === 'setup') return [clampX((W - width) / 2), clampY((H - height) / 2)];
    if (desc.kind === 'call') return [clampX(W - width - 24 - (this.cascade % 4) * 18), 24 + (this.cascade++ % 4) * 18];
    if (desc.kind === 'printout') return [clampX(W - width - 60), clampY(H * 0.2)];
    if (desc.kind === 'progress') return [clampX(W - width - 24), clampY(H - 150)];
    const slot = this.cascade++ % 6;
    return [clampX(40 + slot * 22), clampY(40 + slot * 22)];
  }

  create(desc) {
    if (this.windows.has(desc.id)) return this.windows.get(desc.id);
    const size = desc.kind === 'sequence' ? SIZES.sequence[desc.size] ?? SIZES.sequence.medium : SIZES[desc.kind] ?? SIZES.note;
    const [bodyW, bodyH] = size;
    const frame = el('div', `window kind-${desc.kind}`);
    const titleBar = el('div', 'title-bar');
    const titleText = el('div', 'title-text', desc.title ?? '');
    const controls = el('div', 'title-controls');
    const minimise = el('button', 'tb-button tb-min');
    const maximise = el('button', 'tb-button tb-max');
    const close = el('button', 'tb-button tb-close');
    minimise.title = 'Minimise'; maximise.title = 'Maximise'; close.title = 'Close';
    controls.append(minimise, maximise, close);
    titleBar.append(titleText, controls);
    const body = el('div', 'window-body');
    frame.append(titleBar, body);
    frame.style.width = `${bodyW + 8}px`;
    if (bodyH) body.style.height = `${bodyH}px`;

    const record = { id: desc.id, desc, frame, body, titleText, bodyW, bodyH, x: 0, y: 0, scale: 1, effects: new Set(), view: null, cleanup: null, minimised: false, maximised: false, dragging: false };
    this.windows.set(desc.id, record);
    this.desktop.append(frame);
    this.builders[desc.kind]?.(record, desc, this);
    const height = bodyH ? bodyH + TITLE_H + 8 : frame.offsetHeight;
    [record.x, record.y] = this.place(desc, bodyW + 8, height);
    record.height = height;
    this.position(record);
    this.focus(record.id);
    this.applyWindowEffects(record, desc.effects ?? []);

    close.addEventListener('click', event => { event.stopPropagation(); this.close(desc.id, { byHand: true }); });
    minimise.addEventListener('click', event => { event.stopPropagation(); this.minimise(record, true); });
    maximise.addEventListener('click', event => { event.stopPropagation(); this.toggleMaximise(record); });
    frame.addEventListener('pointerdown', () => this.focus(desc.id));
    this.makeDraggable(record, titleBar);
    frame.classList.add('opening');
    setTimeout(() => frame.classList.remove('opening'), 160);
    if (desc.autoClose) setTimeout(() => this.close(desc.id, { byHand: true }), desc.autoClose);
    this.refreshTasks();
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
    const layer = { console: 1_000_000, dialog: 3_000_000, call: 2_000_000, setup: 2_500_000 }[record.desc.kind] ?? 0;
    record.frame.style.zIndex = String(layer + ++this.z);
  }

  makeDraggable(record, handle) {
    handle.addEventListener('pointerdown', event => {
      if (event.target.closest('.tb-button') || record.maximised) return;
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
        const w = record.bodyW + 8;
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

  // ---------- taskbar ----------

  refreshTasks() {
    if (this.refreshing) return;
    this.refreshing = true;
    queueMicrotask(() => {
      this.refreshing = false;
      const groups = new Map();
      for (const record of this.windows.values()) {
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
        const button = el('button', 'task-button', records.length > 1 ? `${title} (${records.length})` : title);
        button.addEventListener('click', () => {
          const allMinimised = records.every(record => record.minimised);
          for (const record of records) this.minimise(record, false);
          if (!allMinimised) for (const record of records) this.focus(record.id);
        });
        this.tasks.append(button);
      }
    });
  }
}
