import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseCommand, isYes, isNo } from './commands.js';
import {
  EFFECTS, EFFECT_NAMES, expandEffect, findEffect, improviseEffect, isClearEffects, showVariation,
} from './effects.js';
import { hexFromSpeech, normalize, squash, titleCase } from './text.js';

export const DEFAULT_PHRASES = {
  greeting: 'Good {daypart}, {operator}. What will your first sequence of the day be?',
  yes: 'Yes, {operator}.',
  ok: 'Yes.',
  added: 'Sequence added.',
  engaged: '{thing} engaged.',
  printing: 'Printing.',
  betaOffer: 'I have a BETA sequence I have been working on. Would you like to see it?',
  noBeta: 'No new sequences, {operator}.',
  stillWorking: 'I am still working on one, {operator}.',
  notComputing: 'Not computing. Please repeat.',
  gateConfirm: 'This is not suitable for work. Are you sure?',
  generating: 'Generating.',
  cancelled: 'Cancelled.',
  closed: 'Closed.',
  cleared: 'Desktop cleared.',
  nothingLoaded: 'Nothing is loaded, {operator}.',
  unknownSequence: 'I have no sequence called {name}.',
  noProject: 'There is no project {thing}. Shall I start one?',
  projectCreated: 'Project {thing} created.',
  printWhat: 'A printout of what, {operator}?',
  calling: '{operator}, {caller} is calling.',
  videoCalling: '{operator}, {caller} is video calling.',
  missed: 'Missed call from {caller}.',
  declined: 'Call declined.',
  noCall: 'Nobody is calling, {operator}.',
  cannotAnswer: "I'm afraid I can't do that, {operator}.",
  working: 'Working on it.',
  newBeta: '{operator}, I have a new BETA sequence.',
  generatorMissing: 'The sequence generator is not connected.',
  generatorFailed: 'The new sequence did not work out, {operator}.',
  message: 'Message from {caller}.',
  noVoice: 'There is no voice called {name} on this computer.',
  noVoices: 'I have only this voice, {operator}.',
  voiceChanged: 'This is my voice now, {operator}.',
  setupOpen: 'Setup.',
  settingsSaved: 'Settings saved, {operator}.',
  quitWhileGenerating: 'A new sequence is still being generated. If you quit now it will be lost. Quit anyway?',
  restartWhileGenerating: 'A new sequence is still being generated. If you restart now it will be lost. Restart anyway?',
};

const PENDING_MS = 90_000;
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "4d3d3d3" -> "four dee three dee three dee three", so the voice reads ids aloud properly. */
export function spellHex(id) {
  const letters = { a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'eff' };
  return [...id].map(ch => (/\d/.test(ch) ? DIGIT_WORDS[Number(ch)] : letters[ch] ?? ch)).join(' ');
}

function daypart(date) {
  const hour = date.getHours();
  if (hour < 5) return 'evening';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/**
 * The computer: listens to what was said, keeps track of what is on screen and answers.
 * It never draws anything itself. It emits "action" events that the screen carries out.
 */
export class Computer extends EventEmitter {
  constructor({ library, config = {}, stateFile = null, brain = null, generator = null, connectors = null, voices = null, now = () => Date.now() }) {
    super();
    this.voices = voices; // lists and switches the computer's voice
    this.voiceChoice = null;
    this.library = library;
    this.config = config;
    this.stateFile = stateFile;
    this.brain = brain;
    this.generator = generator;
    this.connectors = connectors;
    this.now = now;
    this.operator = config.operator || 'Operator';
    this.phrases = { ...DEFAULT_PHRASES, ...(config.phrases ?? {}) };
    this.maxWindows = config.maxWindows ?? 96;
    this.windows = new Map();
    this.nextWindow = 1;
    this.focus = null; // key of the sequence the operator is talking about
    this.currentProject = null;
    this.levels = {}; // how often each project or sequence was kicked up
    this.pending = null; // a question the computer is waiting on
    this.calls = new Map();
    this.jobs = new Map();
    this.revealed = new Set();
    this.learned = {}; // made-up effect words and what they turned out to mean
    this.log = [];
    this.greeted = false;
    // How long the "Loading BETA, please wait..." bar stays up before the beta sequence appears.
    this.pace = { beta: 2200, ...(config.pace ?? {}) };
  }

  wait(ms) {
    return ms > 0 ? new Promise(resolve => { setTimeout(resolve, ms); }) : Promise.resolve();
  }

  // ---------- remembering between runs ----------

  async restore() {
    if (!this.stateFile) return;
    try {
      const saved = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      this.revealed = new Set(saved.revealed ?? []);
      this.learned = saved.learned ?? {};
      if (saved.voice && this.voices) this.voiceChoice = await this.voices.use(saved.voice.name).catch(() => null);
    } catch { /* first run */ }
  }

  async persist() {
    if (!this.stateFile) return;
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify({ revealed: [...this.revealed], learned: this.learned, voice: this.voiceChoice }, null, 2));
  }

  // ---------- talking to the screen ----------

  send(action) {
    this.emit('action', action);
    return action;
  }

  fill(template, values = {}) {
    return String(template).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? (key === 'operator' ? this.operator : `{${key}}`));
  }

  say(phrase, values = {}, spoken = null) {
    const text = this.fill(this.phrases[phrase] ?? phrase, values);
    const speak = spoken ? this.fill(this.phrases[phrase] ?? phrase, { ...values, ...spoken }) : text;
    this.log.push({ who: 'computer', text, at: this.now() });
    // `key` tells the screen which stock phrase this is (the beta offer gets the big window).
    return this.send({ type: 'say', text, speak, ...(this.phrases[phrase] ? { key: phrase } : {}) });
  }

  /** Something went wrong behind the scenes: show it in the console, plainly. */
  problem(text) {
    this.log.push({ who: 'system', text, at: this.now() });
    this.send({ type: 'note', level: 'error', text });
  }

  heard(text, source) {
    this.log.push({ who: 'operator', text, at: this.now() });
    this.send({ type: 'heard', text, source });
  }

  snapshot() {
    return {
      type: 'snapshot',
      operator: this.operator,
      windows: [...this.windows.values()],
      log: this.log.slice(-60),
      effects: EFFECT_NAMES,
      projects: [...this.library.projects.values()].map(project => ({ id: project.id, name: project.name })),
    };
  }

  // ---------- windows ----------

  openWindow(window) {
    const id = `w${this.nextWindow++}`;
    const full = { id, ...window };
    this.windows.set(id, full);
    this.send({ type: 'window.open', window: full });
    return full;
  }

  closeWindows(filter) {
    const ids = [...this.windows.values()].filter(filter).map(window => window.id);
    for (const id of ids) this.windows.delete(id);
    if (ids.length) this.send({ type: 'window.close', ids });
    return ids.length;
  }

  /** The screen tells us a window was closed by hand. */
  windowClosed(id) {
    const window = this.windows.get(id);
    this.windows.delete(id);
    if (window?.kind === 'dialog' && this.pending?.dialogId === window.dialogId) this.clearPending();
    if (window?.kind === 'call') this.calls.delete(window.call.callId);
  }

  sequenceWindows(key = null) {
    return [...this.windows.values()].filter(window => window.kind === 'sequence' && (!key || window.sequence.key === key));
  }

  /** What the screen needs to know to draw one sequence. */
  view(sequence, variantName = null) {
    const variant = variantName ? sequence.variants[variantName] : null;
    const media = variant ? variant.media : sequence.media;
    return {
      key: sequence.key,
      name: sequence.name,
      variant: variant ? variantName : null,
      hatLine: variant?.hatLine ?? sequence.hatLine,
      puppet: variant ? variant.puppet : sequence.puppet,
      clip: media?.clip.url ?? null,
      stills: Object.fromEntries(Object.entries(media?.stills ?? {}).map(([name, still]) => [name, still.url])),
    };
  }

  /**
   * Opens one window with a dancer. `shot` is how it is framed, as in the sketch: "full" (the whole
   * dancer), "closeup" (head and shoulders), "face" (the face fills the window) or "title" (the name
   * in big letters with the dancer in front). `stack` puts windows of one group in a neat cascade.
   */
  openSequence(sequence, { variant = null, size = 'large', effects = [], group = null, phase = 0, shot = 'full', backdrop = null, stack = null, spot = null } = {}) {
    if (this.windows.size >= this.maxWindows) return null;
    const label = variant ? `${sequence.name} (${variant})` : sequence.name;
    return this.openWindow({
      kind: 'sequence',
      title: label,
      sequence: this.view(sequence, variant),
      effects,
      size,
      group,
      phase,
      shot,
      backdrop: backdrop ?? (shot === 'closeup' || shot === 'title' ? 'pink' : 'white'),
      ...(stack ? { stack } : {}),
      ...(spot ? { spot } : {}),
    });
  }

  world() {
    const variantWords = {};
    for (const sequence of this.library.allSequences()) {
      for (const name of Object.keys(sequence.variants)) variantWords[name] = name;
    }
    if (variantWords.nude) variantWords.naked = 'nude';
    return {
      findSequence: text => this.library.findSequence(text),
      findProject: text => this.library.findProject(text),
      findEffect: text => findEffect(text, this.learned),
      isClearEffects,
      variantWords,
    };
  }

  // ---------- the main entry: something was said or typed ----------

  async hear(text, { source = 'typed' } = {}) {
    const said = String(text ?? '').trim();
    if (!said) return;
    this.heard(said, source);

    if (this.pending && this.now() > this.pending.expires) this.clearPending();
    if (this.pending && this.pending.kind !== 'gate-repeat') {
      if (isYes(said)) return this.answer(true);
      if (isNo(said)) return this.answer(false);
    }

    const command = parseCommand(said, this.world());
    switch (command.intent) {
      case 'empty': return;
      case 'load': return this.load(command, 'yes');
      case 'add': return this.load(command, 'added');
      case 'kick': return this.kick(command);
      case 'printout': return this.printout(command);
      case 'beta.offer': return this.offerBeta();
      case 'variant': return this.variant(command);
      case 'effect': return this.effect(command);
      case 'effects.clear': return this.clearEffects();
      case 'close': return this.close(command);
      case 'close.all': return this.closeAll();
      case 'focus': this.focus = command.sequence.key; return;
      case 'list': return this.list(command.what);
      case 'mute': return this.send({ type: 'quiet' });
      case 'setup': this.send({ type: 'setup.open', page: command.page ?? null }); return this.say('setupOpen');
      case 'music': this.send({ type: 'music', on: command.on, more: command.more === true }); return this.say('ok');
      case 'voice.list': return this.listVoices();
      case 'voice.use': return this.useVoice(command.name);
      case 'generate': return this.generate(command.prompt, command.name);
      case 'project.create': return this.createProject(command.name);
      case 'call.test': return this.incomingCall({
        callId: `test-${this.now()}`, isVideo: command.video, test: true,
        contact: { name: command.name ? titleCase(command.name) : 'Test Caller', pushname: '', number: '15550100', isMyContact: Boolean(command.name) },
      });
      case 'call.decline': return this.declineCall();
      case 'call.who': return this.whoIsCalling();
      case 'call.accept': return this.acceptCall();
      default: return this.think(said);
    }
  }

  /** Anything the fixed phrases do not cover goes to the brain, if there is one. */
  async think(said) {
    if (!this.brain) return this.say('notComputing');
    this.send({ type: 'thinking', on: true });
    try {
      const reply = await this.brain.ask(said, this);
      if (reply) this.say(reply);
    } catch (error) {
      this.problem(`Brain trouble: ${error.message}`);
      this.say('notComputing');
    } finally {
      this.send({ type: 'thinking', on: false });
    }
  }

  // ---------- questions the computer is waiting on ----------

  ask(kind, data = {}) {
    this.clearPending();
    this.pending = { kind, ...data, expires: this.now() + PENDING_MS };
  }

  clearPending() {
    const pending = this.pending;
    this.pending = null;
    if (pending?.dialogId) this.closeWindows(window => window.dialogId === pending.dialogId);
    pending?.resolve?.(false); // a question nobody answered counts as a no
  }

  /** A button in a dialog window was clicked. */
  async dialogAnswer(dialogId, button) {
    if (this.pending?.dialogId !== dialogId) return;
    this.heard(button, 'click');
    return this.answer(/^(yes|ok|quit|restart)$/i.test(button));
  }

  /**
   * Before the app quits or restarts: if a new dancer is still being made, asks first, because
   * it would be lost. Resolves to true (go ahead) or false (keep running). Silence counts as no.
   */
  askToQuit({ restart = false } = {}) {
    if (!this.jobs.size) return Promise.resolve(true);
    if (this.quitQuestion) return this.quitQuestion;
    const go = restart ? 'Restart' : 'Quit';
    this.quitQuestion = new Promise(resolve => {
      const dialogId = `d${this.nextWindow}`;
      this.openWindow({
        kind: 'dialog', dialogId, title: restart ? 'Restart CINCO ID?' : 'Quit CINCO ID?', icon: 'warning',
        text: this.fill(this.phrases[restart ? 'restartWhileGenerating' : 'quitWhileGenerating']), buttons: [go, 'Keep running'],
      });
      this.ask('quit', { dialogId, resolve });
      this.send({ type: 'sound', name: 'chord' });
      this.say(restart ? 'restartWhileGenerating' : 'quitWhileGenerating');
      const timer = setTimeout(() => { if (this.pending?.dialogId === dialogId) this.clearPending(); }, PENDING_MS);
      timer.unref?.();
    }).finally(() => { this.quitQuestion = null; });
    return this.quitQuestion;
  }

  /**
   * Asks the operator for a Yes before something with consequences happens (for example an
   * outside tool that sends a message). Resolves to true or false; silence counts as no.
   */
  confirm(text, title = 'Allow this?') {
    return new Promise(resolve => {
      const dialogId = `d${this.nextWindow}`;
      this.openWindow({ kind: 'dialog', dialogId, title, icon: 'question', text: String(text).slice(0, 1200), buttons: ['Yes', 'No'] });
      this.ask('confirm', { dialogId, resolve });
      this.send({ type: 'sound', name: 'chord' });
      this.say(`Shall I, ${this.operator}?`);
      const timer = setTimeout(() => { if (this.pending?.dialogId === dialogId) this.clearPending(); }, PENDING_MS);
      timer.unref?.();
    });
  }

  async answer(yes) {
    const pending = this.pending;
    if (!pending) return;
    const resolve = pending.resolve;
    pending.resolve = null;
    this.clearPending();
    if (resolve) return resolve(yes);
    if (!yes) return this.say('cancelled');
    if (pending.kind === 'beta') return this.revealBeta(pending.key);
    if (pending.kind === 'gate-confirm') return this.applyVariant(pending.key, pending.variant, true);
    if (pending.kind === 'create-project') return this.createProject(null, pending.id);
  }

  // ---------- loading ----------

  /**
   * Puts a sequence on screen the way the sketch does: the whole dancer in one window and a
   * close-up beside it. An added sequence gets the wide window with the pastel backdrop.
   */
  present(sequence, { added = false } = {}) {
    const first = this.sequenceWindows().length === 0;
    if (sequence.beta) this.reveal(sequence.key);
    if (added && !first) this.openSequence(sequence, { size: 'wide', backdrop: 'pastel' });
    else this.openSequence(sequence, { size: first ? 'large' : 'medium' });
    this.openSequence(sequence, { shot: 'closeup', size: 'medium' });
    this.focus = sequence.key;
    this.currentProject = sequence.projectId;
  }

  async load(command, phrase) {
    if (command.sequence) {
      this.present(command.sequence, { added: phrase === 'added' });
      return this.say(phrase);
    }
    if (command.project) return this.kick({ ...command, sequence: null });
    if (this.brain) return this.think(`${phrase === 'added' ? 'add' : 'load up'} ${command.name}`);
    return this.say('unknownSequence', { name: titleCase(command.name) });
  }

  reveal(key) {
    if (this.revealed.has(key)) return;
    this.revealed.add(key);
    this.persist().catch(() => {});
  }

  availableSequences(project) {
    return project.sequences.filter(sequence => !sequence.beta || this.revealed.has(sequence.key));
  }

  // ---------- kicking it up: far too many windows ----------

  async kick(command) {
    if (command.project) return this.show(command.project);
    if (command.sequence) return this.multiply(command.sequence);
    if (command.name) {
      const id = hexFromSpeech(command.name);
      if (id) {
        this.ask('create-project', { id });
        return this.say('noProject', { thing: id }, { thing: spellHex(id) });
      }
      // "Kick up the <made-up word>": treat the word as an effect on everything.
      if (!this.sequenceWindows().length) return this.say('nothingLoaded');
      await this.applyEffect(null, command.name, null);
      return this.say('engaged', { thing: titleCase(command.name) });
    }
    const project = this.currentProject ? this.library.projects.get(this.currentProject) : null;
    if (project) return this.show(project);
    const first = this.library.projects.get(this.config.defaultProject) ?? [...this.library.projects.values()][0];
    if (first) return this.show(first);
    return this.say('nothingLoaded');
  }

  show(project) {
    this.currentProject = project.id;
    const level = (this.levels[project.id] = (this.levels[project.id] ?? 0) + 1);
    const onScreen = new Set(this.sequenceWindows().map(window => window.sequence.key));
    let cast = this.availableSequences(project).filter(sequence => onScreen.has(sequence.key));
    if (!cast.length) cast = this.availableSequences(project);
    if (!cast.length) return this.say('nothingLoaded');
    const variants = {};
    for (const window of this.sequenceWindows()) variants[window.sequence.key] = window.sequence.variant;
    const room = this.maxWindows - this.windows.size;
    const count = Math.max(0, Math.min(room, project.show.windows));
    for (let i = 0; i < count; i++) {
      const sequence = cast[i % cast.length];
      const variation = showVariation(i, `${project.id}:${level}`, project.show.effects ?? []);
      if (project.show.drift) variation.effects.push({ effect: 'drift', amount: 1 });
      this.openSequence(sequence, {
        variant: variants[sequence.key] ?? null,
        size: variation.size,
        effects: variation.effects,
        group: `show:${project.id}`,
        phase: variation.phase,
        shot: variation.shot,
        backdrop: variation.backdrop,
      });
    }
    this.send({ type: 'sound', name: 'engage' });
    return this.say('engaged', { thing: project.id }, { thing: spellHex(project.id) });
  }

  multiply(sequence) {
    const level = (this.levels[sequence.key] = (this.levels[sequence.key] ?? 0) + 1);
    const current = this.sequenceWindows(sequence.key)[0]?.sequence.variant ?? null;
    this.cascade(sequence, { variant: current, count: 8, id: `more:${sequence.key}:${level}`, group: `more:${sequence.key}` });
    this.focus = sequence.key;
    return this.say('engaged', { thing: sequence.name });
  }

  /** A neat pile of windows of one dancer, each a step further down and to the right. */
  cascade(sequence, { variant = null, count = 6, id, group, shot = 'full', size = 'medium', effects = [], step = null }) {
    const room = Math.max(0, Math.min(count, this.maxWindows - this.windows.size));
    for (let i = 0; i < room; i++) {
      this.openSequence(sequence, {
        variant, size, shot, group,
        effects: effects.map(effect => ({ ...effect })),
        phase: Number(((i * 0.137) % 1).toFixed(3)),
        stack: { id, index: i, count: room, ...(step ? { step } : {}) },
      });
    }
    return room;
  }

  // ---------- effects ----------

  targets(sequence) {
    if (sequence) return this.sequenceWindows(sequence.key);
    const focused = this.focus ? this.sequenceWindows(this.focus) : [];
    return focused.length ? focused : this.sequenceWindows();
  }

  /** Applies a known or made-up effect. Returns false when nothing is on screen. */
  async applyEffect(known, label, sequence, amount = 1) {
    if (known && EFFECTS[known]?.stage) return this.stageEffect(known, sequence);
    const windows = this.targets(sequence);
    if (!windows.length) return false;
    let name = known;
    if (!name) {
      const custom = improviseEffect(label);
      name = custom.key;
      if (!this.learned[name]) {
        this.learned[name] = custom;
        this.persist().catch(() => {});
      }
    }
    const steps = expandEffect(name, this.learned, amount);
    for (const window of windows) {
      for (const step of steps) {
        const existing = window.effects.find(effect => effect.effect === step.effect);
        if (existing) existing.amount = Math.min(3, Number((existing.amount + step.amount * 0.5).toFixed(2)));
        else window.effects.push({ ...step });
      }
    }
    this.send({ type: 'effects.set', windows: windows.map(window => ({ id: window.id, effects: window.effects })) });
    if (name === 'hatWobble') this.hatWobbleShow(windows[0].sequence);
    return true;
  }

  /**
   * The hat wobble as in the sketch: a pile of windows of the dancer and a close-up of the hat.
   * Only the first time; asking again just wobbles harder.
   */
  hatWobbleShow(onScreen) {
    const sequence = this.library.sequence(onScreen.key);
    const group = `hat:${onScreen.key}`;
    if (!sequence || [...this.windows.values()].some(window => window.group === group)) return;
    const effects = [{ effect: 'hatWobble', amount: 1 }];
    const level = (this.levels[group] = (this.levels[group] ?? 0) + 1);
    this.cascade(sequence, { variant: onScreen.variant, count: 6, id: `${group}:${level}`, group, effects });
    this.openSequence(sequence, { variant: onScreen.variant, shot: 'closeup', size: 'medium', group, effects: effects.map(effect => ({ ...effect })) });
  }

  /**
   * Numbers the computer stages itself. "Flarhgunnstow": the dancer steps out of the window and
   * dances on the desktop, with three close-ups beside it. Returns false when nothing is on screen.
   */
  stageEffect(name, sequence) {
    const key = sequence?.key ?? (this.focus && this.sequenceWindows(this.focus).length ? this.focus : this.sequenceWindows()[0]?.sequence.key);
    const found = key ? this.library.sequence(key) : null;
    if (!found) return false;
    const variant = this.sequenceWindows(key)[0]?.sequence.variant ?? null;
    this.closeWindows(window => window.kind === 'sequence' && window.sequence.key === key);
    const level = (this.levels[`${name}:${key}`] = (this.levels[`${name}:${key}`] ?? 0) + 1);
    const group = `solo:${key}`;
    this.openSequence(found, { variant, size: 'large', group, spot: 'left', effects: [{ effect: 'free', amount: 1 }] });
    this.cascade(found, { variant, count: 3, id: `${group}:${level}`, group, shot: 'closeup', step: [26, 0] });
    this.focus = key;
    return true;
  }

  async effect(command) {
    const applied = await this.applyEffect(command.effect, command.label, command.sequence);
    if (!applied) return this.say('nothingLoaded');
    if (command.sequence) this.focus = command.sequence.key;
    return this.say('ok');
  }

  clearEffects() {
    const windows = this.targets(null);
    for (const window of windows) window.effects = [];
    this.send({ type: 'effects.set', windows: windows.map(window => ({ id: window.id, effects: [] })) });
    return this.say('ok');
  }

  // ---------- the beta sequence ----------

  offerBeta() {
    const pool = this.currentProject
      ? [...(this.library.projects.get(this.currentProject)?.sequences ?? []), ...this.library.allSequences()]
      : this.library.allSequences();
    const beta = pool.find(sequence => sequence.beta && !this.revealed.has(sequence.key));
    if (!beta) return this.say(this.jobs.size ? 'stillWorking' : 'noBeta');
    this.ask('beta', { key: beta.key });
    return this.say('betaOffer');
  }

  async revealBeta(key) {
    const sequence = this.library.sequence(key);
    if (!sequence) return this.say('notComputing');
    this.reveal(key);
    // As in the sketch: "Loading BETA, please wait...", then the face in one window and the
    // name in big letters in another.
    const loading = this.openWindow({ kind: 'progress', title: 'Cinco Identity Generator 2.5', text: 'Loading BETA, please wait...', fill: this.pace.beta });
    await this.wait(this.pace.beta);
    this.closeWindows(window => window.id === loading.id);
    this.openSequence(sequence, { shot: 'face', size: 'large' });
    this.openSequence(sequence, { shot: 'title', size: 'medium' });
    this.focus = key;
    this.currentProject = sequence.projectId;
    this.send({ type: 'sound', name: 'reveal' });
    return this.say(`${sequence.name}.`);
  }

  // ---------- variants and the "are you sure" gate ----------

  variant(command) {
    const sequence = command.sequence ?? (this.focus ? this.library.sequence(this.focus) : null);
    const variant = sequence?.variants[command.variant];
    if (!sequence || !variant) return this.say('notComputing');
    if (!variant.gated) return this.applyVariant(sequence.key, command.variant, false);

    const repeatFirst = this.config.gate?.repeatFirst !== false;
    const repeating = this.pending?.kind === 'gate-repeat' && this.pending.key === sequence.key && this.pending.variant === command.variant;
    if (repeatFirst && !repeating) {
      this.ask('gate-repeat', { key: sequence.key, variant: command.variant });
      return this.say('notComputing');
    }
    this.clearPending();
    const dialogId = `d${this.nextWindow}`;
    this.openWindow({
      kind: 'dialog', dialogId, title: 'Warning', icon: 'warning',
      text: this.fill(this.phrases.gateConfirm), buttons: ['Yes', 'No'],
    });
    this.ask('gate-confirm', { key: sequence.key, variant: command.variant, dialogId });
    this.send({ type: 'sound', name: 'chord' });
    return this.say('gateConfirm');
  }

  applyVariant(key, variantName, announce) {
    const sequence = this.library.sequence(key);
    if (!sequence?.variants[variantName]) return this.say('notComputing');
    const view = this.view(sequence, variantName);
    const windows = this.sequenceWindows(key);
    if (windows.length) {
      for (const window of windows) {
        window.sequence = view;
        window.title = `${sequence.name} (${variantName})`;
      }
      this.send({ type: 'sequence.swap', windows: windows.map(window => ({ id: window.id, title: window.title, sequence: view })), flourish: announce });
    } else {
      this.openSequence(sequence, { variant: variantName, size: 'large' });
    }
    this.focus = key;
    return this.say(announce ? 'generating' : 'ok');
  }

  // ---------- printouts ----------

  printout(command) {
    const sequence = command.sequence ?? (this.focus ? this.library.sequence(this.focus) : null);
    if (!sequence) return this.say(command.name && !this.focus ? 'unknownSequence' : 'printWhat', { name: titleCase(command.name ?? '') });
    const onScreen = this.sequenceWindows(sequence.key)[0];
    const view = this.view(sequence, onScreen?.sequence.variant ?? null);
    const expression = command.expression ? normalize(command.expression) : null;
    const caption = [sequence.name, expression].filter(Boolean).join(', ');
    this.openWindow({
      kind: 'printout', title: `Printing - ${caption}`, sequence: view, expression, caption,
      printId: `p${this.now()}`,
    });
    this.send({ type: 'sound', name: 'printer' });
    return this.say('printing');
  }

  // ---------- closing ----------

  close(command) {
    if (!command.sequence) return this.say('unknownSequence', { name: titleCase(command.name) });
    const closed = this.closeWindows(window => window.kind === 'sequence' && window.sequence.key === command.sequence.key);
    if (this.focus === command.sequence.key) this.focus = null;
    return this.say(closed ? 'closed' : 'nothingLoaded');
  }

  closeAll() {
    this.clearPending();
    this.closeWindows(window => window.kind !== 'call');
    this.levels = {};
    this.focus = null;
    return this.say('cleared');
  }

  // ---------- lists ----------

  list(what) {
    const learned = Object.values(this.learned).map(entry => entry.label);
    const effects = [`Effects: ${EFFECT_NAMES.map(name => EFFECTS[name].say[0]).join(', ')}`];
    if (learned.length) effects.push(`Learned words: ${learned.join(', ')}`);
    if (what === 'effects') {
      this.openWindow({ kind: 'note', title: 'Effects', text: effects.join('\n\n') });
    } else {
      // The "Please choose a sequence" window: every project with a picture of each dancer.
      this.closeWindows(window => window.kind === 'chooser');
      this.openWindow({
        kind: 'chooser',
        title: 'Cinco Identity Generator 2.5',
        projects: [...this.library.projects.values()].map(project => ({
          id: project.id,
          name: project.name,
          sequences: project.sequences.map(sequence => (sequence.beta && !this.revealed.has(sequence.key)
            ? { hidden: true, name: 'BETA' }
            : { name: sequence.name, beta: Boolean(sequence.beta), sequence: this.view(sequence) })),
        })),
        footnote: what === 'projects' || what === 'sequences' ? '' : effects.join('\n'),
      });
    }
    const projects = this.library.projects.size;
    const sequences = this.library.allSequences().length;
    return this.say(`${projects} ${projects === 1 ? 'project' : 'projects'}, ${sequences} ${sequences === 1 ? 'sequence' : 'sequences'}.`);
  }

  // ---------- the computer's own voice ----------

  async listVoices() {
    const voices = (await this.voices?.list()) ?? [];
    if (!voices.length) return this.say('noVoices');
    const current = this.voiceChoice?.name;
    const lines = voices.map(voice => `${voice.name === current ? '>' : ' '} ${voice.name}${voice.language ? `  (${voice.language})` : ''}`);
    lines.push('', 'Say "use the voice ..." to switch. Any voice installed in Windows shows up here.');
    this.openWindow({ kind: 'note', title: 'Voices', text: lines.join('\n') });
    return this.say(`${voices.length} ${voices.length === 1 ? 'voice' : 'voices'}.`);
  }

  async useVoice(name) {
    const chosen = await this.voices?.use(name);
    if (!chosen) return this.say('noVoice', { name: titleCase(name) });
    this.voiceChoice = chosen;
    this.persist().catch(() => {});
    this.send({ type: 'quiet' });
    return this.say('voiceChanged');
  }

  // ---------- new projects and new sequences ----------

  async createProject(name, id = null) {
    const project = await this.library.createProject(name, id);
    this.currentProject = project.id;
    this.send({ type: 'projects', projects: this.snapshot().projects });
    return this.say('projectCreated', { thing: project.id }, { thing: spellHex(project.id) });
  }

  async generate(prompt, givenName = null) {
    if (!this.generator) return this.say('generatorMissing');
    const projectId = this.currentProject ?? this.config.defaultProject ?? [...this.library.projects.keys()][0];
    if (!projectId) return this.say('nothingLoaded');
    const name = titleCase(givenName || prompt.split(' ').slice(0, 3).join(' '));
    const place = await this.library.prepareSequence(projectId, name, { description: prompt });
    const jobId = `job${this.now()}`;
    const window = this.openWindow({ kind: 'progress', title: 'Beta sequence', jobId, text: 'Starting', value: 0 });
    this.jobs.set(jobId, { key: place.key, windowId: window.id });
    this.say('working');
    this.generator.run({ name, prompt, out: place.dir }, update => {
      this.send({ type: 'progress', jobId, value: update.progress ?? null, text: update.message ?? update.stage ?? '' });
    }).then(async () => {
      await this.library.finishSequence(place.dir);
      await this.library.reload();
      this.say('newBeta');
    }).catch(async error => {
      await fs.rm(place.dir, { recursive: true, force: true }).catch(() => {});
      await this.library.reload();
      this.send({ type: 'note', level: 'error', text: `Generator: ${error.message}` });
      this.say('generatorFailed');
    }).finally(() => {
      this.jobs.delete(jobId);
      this.closeWindows(open => open.id === window.id);
    });
  }

  // ---------- calls and other things that happen on their own ----------

  callerName(contact = {}) {
    return contact.name || contact.pushname || (contact.number ? `+${contact.number}` : 'Unknown caller');
  }

  incomingCall(call) {
    if (this.calls.has(call.callId)) return;
    const caller = this.callerName(call.contact);
    const window = this.openWindow({
      kind: 'call',
      title: call.isVideo ? 'INCOMING VIDEO CALL' : 'INCOMING CALL',
      call: { ...call, caller },
      canDecline: Boolean(call.test || this.connectors?.canDeclineCalls?.(call.via)),
    });
    this.calls.set(call.callId, { ...call, caller, windowId: window.id });
    this.send({ type: 'sound', name: 'ring' });
    // Make sure the Decline button tells the truth: is the connector really there right now?
    if (!call.test && this.connectors?.checkDecline) {
      this.connectors.checkDecline(call.via).catch(() => false).then(() => this.declineAvailabilityChanged());
    }
    return this.say(call.isVideo ? 'videoCalling' : 'calling', { caller });
  }

  /** The connector that declines calls came or went: the call windows follow. */
  declineAvailabilityChanged() {
    const changed = [];
    for (const window of this.windows.values()) {
      if (window.kind !== 'call' || window.call.test) continue;
      const can = Boolean(this.connectors?.canDeclineCalls?.(window.call.via));
      if (window.canDecline === can) continue;
      window.canDecline = can;
      changed.push({ id: window.id, canDecline: can });
    }
    if (changed.length) this.send({ type: 'call.decline-state', windows: changed });
  }

  callEnded({ callId, reason = 'ended' }) {
    const call = this.calls.get(callId);
    if (!call) return;
    this.calls.delete(callId);
    this.closeWindows(window => window.id === call.windowId);
    this.send({ type: 'sound', name: 'ring-stop' });
    if (reason === 'missed') {
      this.openWindow({ kind: 'note', title: 'Missed call', text: `${call.caller}\n${call.contact?.number ? `+${call.contact.number}` : ''}`.trim(), autoClose: 15000 });
      return this.say('missed', { caller: call.caller });
    }
  }

  async declineCall(callId = null) {
    const call = callId ? this.calls.get(callId) : [...this.calls.values()].at(-1);
    if (!call) return this.say('noCall');
    if (!call.test) {
      try { await this.connectors?.declineCall?.(call.callId, call.via); } catch (error) {
        this.send({ type: 'note', level: 'error', text: `Could not decline: ${error.message}` });
        return;
      }
    }
    this.calls.delete(call.callId);
    this.closeWindows(window => window.id === call.windowId);
    this.send({ type: 'sound', name: 'ring-stop' });
    return this.say('declined');
  }

  /** The computer can show and decline calls, but it cannot pick up. The call keeps ringing. */
  acceptCall() {
    if (!this.calls.size) return this.say('noCall');
    return this.say('cannotAnswer');
  }

  whoIsCalling() {
    const call = [...this.calls.values()].at(-1);
    if (!call) return this.say('noCall');
    return this.say(call.isVideo ? 'videoCalling' : 'calling', { caller: call.caller });
  }

  /** A message or any other outside event that should simply pop up. */
  notify({ title, text, speak = null, autoClose = 20000 }) {
    this.openWindow({ kind: 'note', title, text, autoClose });
    this.send({ type: 'sound', name: 'ding' });
    if (speak) this.say(speak);
  }

  greet() {
    if (this.greeted) return;
    this.greeted = true;
    return this.say('greeting', { daypart: daypart(new Date(this.now())) });
  }

  /** Short description of the screen, for the brain. */
  describe() {
    const counts = {};
    for (const window of this.sequenceWindows()) {
      const label = window.sequence.variant ? `${window.sequence.name} (${window.sequence.variant})` : window.sequence.name;
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return {
      operator: this.operator,
      now: new Date(this.now()).toString().slice(0, 33),
      onScreen: counts,
      focus: this.focus ? this.library.sequence(this.focus)?.name ?? null : null,
      currentProject: this.currentProject,
      projects: [...this.library.projects.values()].map(project => ({
        id: project.id, name: project.name,
        sequences: this.availableSequences(project).map(sequence => sequence.name),
      })),
      ringing: [...this.calls.values()].map(call => call.caller),
      effects: EFFECT_NAMES,
      learnedWords: Object.keys(this.learned).map(key => this.learned[key].label ?? key).map(squash),
    };
  }
}
