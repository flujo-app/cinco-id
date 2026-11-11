import { WindowManager } from './wm.js';
import { Stage, SequenceView, renderPortrait, clipStatus } from './stage.js';
import * as sound from './sound.js';
import { buildSetup } from './setup.js';
import { drawBanner, drawHeadIcon, drawLed, drawPhone, fitBlockText } from './pixels.js';

const shell = window.shell ?? null; // present when running inside the desktop shell
const query = new URLSearchParams(location.search);
const overlay = query.has('overlay');
document.body.classList.toggle('overlay', overlay);
if (query.has('silent')) sound.setMuted(true); // for tests: no voice, no music

const stage = new Stage();
// For the checks in test/ui and for recording demo videos (tools/demo).
window.betaSequence = { clipStatus, voiceLog: sound.voiceLog, musicStatus: sound.musicStatus, startRecording: sound.startRecording, stopRecording: sound.stopRecording };
let socket = null;
let operator = 'Operator';
let voice = { speak: 'server', listen: false };
let folders = {};
let greeted = false;
let musicChoice = 'auto'; // "auto": on while anything dances
let muted = query.has('silent');
const consoleUi = {};
const history = [];
let historyAt = 0;

const send = message => { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); };
const command = (text, source = 'typed') => send({ type: 'command', text, source });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- what goes inside each kind of window ----------

const builders = {
  sequence(record, desc) {
    const canvas = el('canvas');
    canvas.width = record.bodyW;
    canvas.height = record.bodyH;
    record.body.classList.add(`backdrop-${desc.backdrop ?? 'white'}`);
    record.body.append(canvas);
    const view = new SequenceView(canvas, desc.sequence, { effects: desc.effects, phase: desc.phase ?? 0, shot: desc.shot ?? 'full' });
    record.view = view;
    stage.add(view);
    record.cleanup = () => stage.remove(view);
    record.onResize = () => requestAnimationFrame(() => {
      canvas.width = record.maximised ? record.body.clientWidth - 4 : record.bodyW;
      canvas.height = record.maximised ? record.body.clientHeight - 4 : record.bodyH;
    });
  },

  dialog(record, desc) {
    const row = el('div', 'dialog-row');
    row.append(el('div', `icon icon-${desc.icon ?? 'warning'}`), el('div', 'dialog-text', desc.text));
    const buttons = el('div', 'button-row');
    for (const label of desc.buttons ?? ['OK']) {
      const button = el('button', 'w95', label);
      button.addEventListener('click', () => send({ type: 'dialog.answer', dialogId: desc.dialogId, button: label }));
      buttons.append(button);
    }
    record.body.append(row, buttons);
  },

  call(record, desc, wm) {
    const call = desc.call;
    const contact = call.contact ?? {};
    const number = contact.number ? `+${contact.number}` : 'Number withheld';
    // As in the sketch: the number on a red display, then a big panel with a ringing phone and
    // the caller's name in chunky letters.
    const led = el('div', 'call-led');
    const digits = el('canvas');
    digits.width = 440;
    digits.height = 68;
    drawLed(digits, contact.number ? number : '');
    led.append(digits, el('div', 'call-number sr-only', number));
    const panel = el('div', 'call-panel');
    const letters = el('canvas', 'call-letters');
    letters.width = 424;
    letters.height = 92;
    const fits = fitBlockText(letters.getContext('2d'), call.caller, { x: 4, y: 4, width: 416, height: 84 }, { color: '#fff', maxLines: 2, tall: 1.2, minCell: 3 });
    // A name too long for chunky letters is shown in ordinary ones.
    const phone = el('canvas', 'call-phone');
    phone.width = 168;
    phone.height = 168;
    drawPhone(phone);
    panel.append(phone, fits ? letters : el('div', 'call-plain', call.caller), el('div', 'call-name sr-only', call.caller));
    const kind = el('div', 'call-kind', [
      call.isVideo ? 'WhatsApp video call' : 'WhatsApp voice call',
      call.isGroup ? 'group call' : null,
      contact.isMyContact ? 'saved contact' : 'not in your contacts',
      contact.pushname && contact.pushname !== call.caller ? `shows as "${contact.pushname}"` : null,
    ].filter(Boolean).join(' · '));
    const buttons = el('div', 'button-row');
    const decline = el('button', 'w95', 'Decline');
    record.setCanDecline = can => {
      decline.disabled = !can;
      decline.title = can ? '' : 'Declining is not connected right now';
    };
    record.setCanDecline(desc.canDecline);
    decline.addEventListener('click', () => send({ type: 'call.decline', callId: call.callId }));
    const dismiss = el('button', 'w95', 'Dismiss');
    dismiss.addEventListener('click', () => wm.close(desc.id, { byHand: true }));
    const accept = el('button', 'w95', 'Accept');
    accept.addEventListener('click', () => send({ type: 'call.accept', callId: call.callId }));
    buttons.append(accept, decline, dismiss);
    record.body.append(led, panel, kind, buttons);
    record.cleanup = () => setTimeout(stopRingIfQuiet, 0);
  },

  note(record, desc) {
    record.body.append(el('pre', 'note-text sunken', desc.text ?? ''));
  },

  progress(record, desc) {
    // As in the sketch: a white bar filling with blue blocks, the words underneath.
    const label = el('div', 'pad', desc.text ?? '');
    const track = el('div', 'progress-track sunken busy');
    for (let i = 0; i < 8; i++) track.append(el('i'));
    record.body.append(track, label);
    const BLOCKS = 18;
    record.setProgress = (value, text) => {
      if (text) label.textContent = text;
      if (typeof value !== 'number') return;
      track.classList.remove('busy');
      const blocks = Math.round(Math.max(0, Math.min(1, value)) * BLOCKS);
      if (track.childElementCount !== blocks) track.replaceChildren(...Array.from({ length: blocks }, () => el('i')));
    };
    if (desc.fill) fillBar(record.setProgress, desc.fill);
  },

  /** The start window: the banner with the grid head and "please wait...". Closes by itself. */
  splash(record, desc, wm) {
    const banner = el('canvas', 'banner');
    banner.width = 470 * 2;
    banner.height = 176 * 2;
    drawBanner(banner);
    const track = el('div', 'progress-track sunken');
    record.body.append(banner, el('div', 'splash-title', 'Cinco Identity Generator 2.5'), track, el('div', 'wait-text', 'please wait...'));
    fillBar(value => {
      const blocks = Math.round(value * 20);
      if (track.childElementCount !== blocks) track.replaceChildren(...Array.from({ length: blocks }, () => el('i')));
    }, desc.fill ?? 2600);
    setTimeout(() => wm.close(desc.id), (desc.fill ?? 2600) + 500);
  },

  /** "Please choose a sequence": a picture of every dancer; a click loads it. */
  chooser(record, desc, wm) {
    const banner = el('canvas', 'banner');
    banner.width = 470 * 2;
    banner.height = 120 * 2;
    drawBanner(banner);
    record.body.append(banner, el('div', 'chooser-ask', 'Please choose a sequence:'));
    const many = desc.projects.length > 1;
    for (const project of desc.projects) {
      if (many) record.body.append(el('div', 'chooser-project', `${project.id} - ${project.name}`));
      const row = el('div', 'chooser-row');
      for (const entry of project.sequences) {
        const tile = el('button', 'chooser-tile');
        if (entry.hidden) {
          tile.append(el('span', 'chooser-face mystery', '?'), el('span', '', 'BETA'));
          tile.addEventListener('click', () => { sound.unlock(); wm.close(desc.id, { byHand: true }); command('do we have any new sequences?'); });
        } else {
          const face = el('canvas', 'chooser-face');
          face.width = 128;
          face.height = 128;
          renderPortrait(entry.sequence, null, 128, 128, { crop: 0.3 }).then(picture => face.getContext('2d').drawImage(picture, 0, 0)).catch(() => {});
          const name = el('span', '', entry.name);
          if (entry.beta) name.append(el('span', 'chooser-beta', '(BETA)'));
          tile.append(face, name);
          tile.addEventListener('click', () => { sound.unlock(); wm.close(desc.id, { byHand: true }); command(`load up ${entry.name}`); });
        }
        row.append(tile);
      }
      if (!project.sequences.length) row.append(el('div', 'chooser-project', 'no sequences yet'));
      record.body.append(row);
    }
    if (desc.footnote) record.body.append(el('div', 'chooser-foot', desc.footnote));
  },

  printout(record, desc) {
    const well = el('div', 'paper-well sunken');
    const paper = el('canvas', 'paper feeding');
    paper.width = 600;
    paper.height = 780;
    well.append(paper);
    const status = el('div', 'status-line', 'Printing page 1 of 1');
    record.body.append(well, status);
    printPage(paper, desc).then(async () => {
      await new Promise(resolve => setTimeout(resolve, 2800));
      const response = await fetch('/api/printouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caption: desc.caption, dataUrl: paper.toDataURL('image/png') }),
      });
      const result = await response.json();
      status.textContent = !result.ok ? `Could not save: ${result.error}`
        : result.printing ? `Sent to ${result.printing}` : `Saved: ${result.file.split(/[\\/]/).slice(-2).join('/')}`;
    }).catch(error => { status.textContent = `Could not print: ${error.message}`; });
  },

  setup(record, desc) {
    buildSetup(record, {
      shell,
      sound,
      firstRun: desc.firstRun,
      page: desc.page ?? null,
      close: () => wm.close('setup', { byHand: true }),
      onFinished: saved => setupClosed(desc.firstRun, saved),
    });
  },

  console(record) {
    const box = el('div', 'console');
    const log = el('div', 'console-log');
    const row = el('div', 'console-row');
    const input = el('input');
    input.placeholder = 'Type to the computer, or hold the space bar and talk';
    input.spellcheck = false;
    const talk = el('button', 'w95', 'Talk');
    const sendButton = el('button', 'w95', 'Send');
    row.append(input, talk, sendButton);
    const status = el('div', 'status-line', '');
    box.append(log, row, status);
    record.body.append(box);
    Object.assign(consoleUi, { log, input, talk, status });

    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      history.push(text);
      historyAt = history.length;
      input.value = '';
      sound.unlock();
      command(text);
    };
    sendButton.addEventListener('click', submit);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') submit();
      else if (event.key === 'ArrowUp' && historyAt > 0) { input.value = history[--historyAt]; event.preventDefault(); }
      else if (event.key === 'ArrowDown') { input.value = history[++historyAt] ?? ''; historyAt = Math.min(historyAt, history.length); }
    });
    talk.addEventListener('pointerdown', event => { event.preventDefault(); startListening(); });
    talk.addEventListener('pointerup', stopListening);
    talk.addEventListener('pointerleave', stopListening);
  },
};

// ---------- printouts ----------

/** The page as in the sketch: a head-and-shoulders photo on white paper, a small caption under it. */
async function printPage(paper, desc) {
  const ctx = paper.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, paper.width, paper.height);
  const photo = { x: 50, y: 120, width: 500, height: 375 };
  const wall = ctx.createLinearGradient(0, photo.y, 0, photo.y + photo.height);
  wall.addColorStop(0, '#f4f4f2');
  wall.addColorStop(1, '#e6e6e3');
  ctx.fillStyle = wall;
  ctx.fillRect(photo.x, photo.y, photo.width, photo.height);
  const picture = await renderPortrait(desc.sequence, desc.expression, photo.width * 2, photo.height * 2, { crop: 0.36 });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(picture, photo.x, photo.y, photo.width, photo.height);

  ctx.fillStyle = '#333';
  ctx.textAlign = 'center';
  ctx.font = '15px Arial, Helvetica, sans-serif';
  ctx.fillText(desc.caption.replace(/,/g, '').toLowerCase(), paper.width / 2, photo.y + photo.height + 34);
  ctx.textAlign = 'left';
}

/** Fills a "please wait" bar from empty to full over `ms`. */
function fillBar(set, ms) {
  const start = performance.now();
  const tick = now => {
    const value = Math.min(1, (now - start) / ms);
    set(value);
    if (value < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------- the desktop ----------

const wm = new WindowManager({
  desktop: document.getElementById('desktop'),
  tasks: document.getElementById('tasks'),
  builders,
  onClosed: (id, desc) => { if (!['console', 'setup', 'splash'].includes(desc.kind)) send({ type: 'window.closed', id }); updateMusic(); },
  // While a call rings the rest of the screen goes pale, as in the sketch.
  onChanged: () => document.body.classList.toggle('ringing', [...wm.windows.values()].some(record => record.desc.kind === 'call')),
});

// ---------- the Setup window ----------

let setupPending = false; // the first start: the greeting waits until Setup is closed

function showSetup({ firstRun = false, page = null } = {}) {
  const existing = wm.windows.get('setup');
  if (existing) {
    wm.minimise(existing, false);
    if (page) existing.goTo?.(page);
    return;
  }
  wm.open({ id: 'setup', kind: 'setup', title: 'CINCO ID Setup', firstRun, page }, { instant: true });
}

async function setupClosed(firstRun, saved) {
  if (!firstRun) return;
  // Closed on the first start without saving: remember that, so it does not ask on every start.
  if (!saved) {
    await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ announce: false }) }).catch(() => {});
  }
  setupPending = false;
  startUp();
}

const consoleTitle = () => `${operator}'s COMPUTER`;

function showConsole() {
  const existing = wm.windows.get('console');
  if (existing) { wm.minimise(existing, false); return; }
  wm.open({ id: 'console', kind: 'console', title: consoleTitle() }, { instant: true });
  for (const line of pendingLines.splice(0)) logLine(line.who, line.text);
  consoleUi.input?.focus();
}

const pendingLines = [];
let finishTyping = null; // lets the line being typed appear at once when the next one arrives

/**
 * Adds a line to the computer's window. With `typed` it appears letter by letter behind a block
 * cursor, as in the sketch. The whole text is in the page from the start (the part not typed yet
 * is just invisible), so nothing jumps and the line can be read back at any moment.
 * `breaks` are places in the text after which a new line starts (the big beta offer).
 */
function logLine(who, text, { typed = false, breaks = [] } = {}) {
  if (!consoleUi.log?.isConnected) { pendingLines.push({ who, text }); return; }
  finishTyping?.();
  const line = el('div', who);
  const done = el('span', 'typed');
  const cursor = el('i', 'cursor');
  const rest = el('span', 'untyped');
  line.append(done, cursor, rest);
  const put = (node, from, to) => {
    const parts = [];
    let at = from;
    for (const stop of breaks) {
      if (stop <= 0 || stop < from || stop >= to) continue;
      if (stop > at) parts.push(text.slice(at, stop));
      parts.push(document.createElement('br'));
      at = stop;
    }
    parts.push(text.slice(at, to));
    node.replaceChildren(...parts);
  };
  const show = count => { put(done, 0, count); put(rest, count, text.length); };
  consoleUi.log.append(line);
  while (consoleUi.log.childElementCount > 300) consoleUi.log.firstElementChild.remove();
  if (!typed) { show(text.length); consoleUi.log.scrollTop = consoleUi.log.scrollHeight; return; }
  const perSecond = who === 'operator' ? 120 : Math.max(34, text.length / 3.5); // long answers do not dawdle
  const start = performance.now();
  let stopped = false;
  finishTyping = () => { stopped = true; finishTyping = null; show(text.length); };
  const tick = now => {
    if (stopped) return;
    const count = Math.min(text.length, Math.floor((now - start) / 1000 * perSecond) + 1);
    show(count);
    consoleUi.log.scrollTop = consoleUi.log.scrollHeight;
    if (count < text.length) requestAnimationFrame(tick);
    else finishTyping = null;
  };
  show(0);
  consoleUi.log.scrollTop = consoleUi.log.scrollHeight;
  requestAnimationFrame(tick);
}

/** Where a spoken text is broken into lines for the big window: at sentence ends, and a long first sentence in the middle. */
function bigBreaks(text) {
  const breaks = [];
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) ?? [text];
  let at = 0;
  sentences.forEach((sentence, index) => {
    if (sentence.trim().length > 30) {
      const middle = at + sentence.trim().length / 2;
      let best = -1;
      for (let i = at + 1; i < at + sentence.length - 1; i++) {
        if (text[i] === ' ' && (best < 0 || Math.abs(i - middle) < Math.abs(best - middle))) best = i;
      }
      if (best > 0) breaks.push(best + 1);
    }
    at += sentence.length;
    if (index < sentences.length - 1) breaks.push(at);
  });
  return breaks;
}

/** The computer's window steps to the middle and speaks in big letters (the beta offer), then goes back. */
let consoleHome = null;
function consoleBig(on) {
  const record = wm.windows.get('console');
  if (!record || record.maximised || overlay || on === Boolean(consoleHome)) return;
  if (on) {
    consoleHome = [record.x, record.y];
    record.frame.classList.add('big');
    const { width, height } = wm.bounds();
    record.x = Math.max(0, (width - record.frame.offsetWidth) / 2);
    record.y = Math.max(0, height * 0.42 - record.frame.offsetHeight / 2);
  } else {
    record.frame.classList.remove('big');
    [record.x, record.y] = consoleHome;
    consoleHome = null;
  }
  wm.position(record);
  consoleUi.log.scrollTop = consoleUi.log.scrollHeight;
}

function status(text) {
  if (consoleUi.status) consoleUi.status.textContent = text;
}

function sequenceCount() {
  let count = 0;
  for (const record of wm.windows.values()) if (record.desc.kind === 'sequence') count++;
  return count + wm.openQueue.filter(desc => desc.kind === 'sequence').length;
}

function updateMusic() {
  const on = musicChoice === 'on' || (musicChoice === 'auto' && sequenceCount() > 0);
  sound.music(on && !muted);
}

function stopRingIfQuiet() {
  if (![...wm.windows.values()].some(record => record.desc.kind === 'call')) sound.play('ring-stop');
}

/** The very start, as in the sketch: the start window with "please wait...", and the greeting. */
function startUp() {
  if (greeted) return;
  greeted = true;
  if (overlay) { send({ type: 'hello' }); return; }
  wm.open({ id: 'splash', kind: 'splash', title: 'Cinco Identity Generator 2.5', fill: 2600 }, { instant: true });
  setTimeout(() => send({ type: 'hello' }), 1500);
}

function drawIcons(projects) {
  const icons = document.getElementById('icons');
  icons.replaceChildren();
  const add = (art, label, action) => {
    const button = el('button', 'desktop-icon');
    const picture = el('div', `icon-art ${art}`);
    if (art === 'head') {
      const canvas = el('canvas');
      canvas.width = 52;
      canvas.height = 56;
      drawHeadIcon(canvas);
      picture.append(canvas);
    }
    button.append(picture, el('span', '', label));
    button.addEventListener('dblclick', action);
    icons.append(button);
  };
  add('head', 'Cinco 2.5', () => { sound.unlock(); command('choose a sequence'); });
  add('machine', 'Computer', showConsole);
  for (const project of projects ?? []) add('folder', project.id, () => { sound.unlock(); command(`kick up the ${project.id}`); });
}

// ---------- what the computer tells the screen ----------

function handle(action) {
  switch (action.type) {
    case 'snapshot': {
      operator = action.operator;
      voice = action.voice ?? voice;
      folders = action.folders ?? folders;
      sound.setVoiceMode(voice.speak);
      wm.closeAll(record => record.desc.kind !== 'console' && record.desc.kind !== 'setup');
      for (const window of action.windows) wm.open(window, { instant: true });
      drawIcons(action.projects);
      showConsole();
      wm.setTitle('console', consoleTitle());
      if (consoleUi.log) {
        consoleUi.log.replaceChildren();
        for (const line of action.log ?? []) logLine(line.who, line.text);
      }
      for (const note of action.notes ?? []) logLine('system', note);
      consoleUi.talk.disabled = !voice.listen;
      consoleUi.talk.title = voice.listen ? 'Hold to talk' : 'Speech recognition is not set up';
      document.getElementById('tray-mic').classList.toggle('off', !voice.listen);
      updateMusic();
      if (action.setup?.firstRun && !greeted && !setupPending) {
        setupPending = true;
        showSetup({ firstRun: true });
      }
      if (!setupPending) startUp();
      break;
    }
    case 'setup.open':
      showSetup({ page: action.page ?? null });
      break;
    case 'whatsapp':
      wm.windows.get('setup')?.whatsappChanged?.(action);
      break;
    case 'call.decline-state':
      for (const { id, canDecline } of action.windows) {
        const queued = wm.openQueue.find(desc => desc.id === id);
        if (queued) queued.canDecline = canDecline;
        wm.windows.get(id)?.setCanDecline?.(canDecline);
      }
      break;
    case 'settings.changed':
      operator = action.operator ?? operator;
      voice = action.voice ?? voice;
      sound.setVoiceMode(voice.speak);
      wm.setTitle('console', consoleTitle());
      break;
    case 'say': {
      const big = action.key === 'betaOffer';
      consoleBig(big);
      logLine('computer', action.text, { typed: true, breaks: big ? bigBreaks(action.text) : [] });
      sound.say(action.speak ?? action.text);
      break;
    }
    case 'heard':
      consoleBig(false);
      logLine('operator', action.text, { typed: true });
      break;
    case 'window.open':
      wm.open(action.window);
      updateMusic();
      break;
    case 'window.close':
      for (const id of action.ids) wm.close(id);
      stopRingIfQuiet();
      updateMusic();
      break;
    case 'effects.set':
      for (const { id, effects } of action.windows) {
        const record = wm.windows.get(id);
        const queued = wm.openQueue.find(desc => desc.id === id);
        if (queued) queued.effects = effects;
        if (!record) continue;
        record.desc.effects = effects;
        record.view?.setEffects(effects);
        wm.applyWindowEffects(record, effects);
      }
      break;
    case 'sequence.swap':
      for (const { id, title, sequence } of action.windows) {
        const queued = wm.openQueue.find(desc => desc.id === id);
        if (queued) { queued.sequence = sequence; queued.title = title; }
        const record = wm.windows.get(id);
        if (!record) continue;
        if (action.flourish) {
          record.body.classList.add('regen');
          setTimeout(() => record.body.classList.remove('regen'), 1900);
        }
        setTimeout(() => {
          record.desc.sequence = sequence;
          record.view?.setSequence(sequence);
          wm.setTitle(id, title);
        }, action.flourish ? 900 : 0);
      }
      break;
    case 'progress':
      for (const record of wm.windows.values()) {
        if (record.desc.jobId === action.jobId) record.setProgress?.(action.value, action.text);
      }
      break;
    case 'sound': sound.play(action.name); break;
    case 'quiet': sound.quiet(); break;
    case 'music': musicChoice = action.on ? 'on' : 'off'; updateMusic(); if (action.on && action.more) sound.moreDisco(); break;
    case 'projects': drawIcons(action.projects); break;
    case 'note': logLine('system', action.text); break;
    case 'thinking': status(action.on ? 'Computing...' : ''); break;
    default: break;
  }
}

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener('message', event => handle(JSON.parse(event.data)));
  socket.addEventListener('close', () => {
    status('The computer is not answering. Trying again...');
    setTimeout(connect, 1500);
  });
  socket.addEventListener('open', () => status(''));
}

// ---------- talking ----------

let recorder = null;
let stream = null;
let wantStop = false;

async function startListening() {
  if (!voice.listen || recorder) return;
  sound.unlock();
  sound.quiet();
  wantStop = false;
  try {
    stream ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    logLine('system', 'The microphone is not available.');
    return;
  }
  const chunks = [];
  const active = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  recorder = active;
  active.ondataavailable = event => chunks.push(event.data);
  active.onstop = async () => {
    recorder = null;
    setListening(false);
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (blob.size < 3000) { status(''); return; }
    status('Understanding...');
    try {
      const response = await fetch('/api/stt', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: blob });
      const result = await response.json();
      status('');
      if (result.text?.trim()) command(result.text.trim(), 'voice');
      else if (result.error) logLine('system', result.error);
    } catch (error) {
      status('');
      logLine('system', `Could not understand: ${error.message}`);
    }
  };
  active.start();
  setListening(true);
  status('Listening...');
  if (wantStop) stopListening();
}

function stopListening() {
  wantStop = true;
  if (recorder?.state === 'recording') recorder.stop();
}

function setListening(on) {
  consoleUi.talk?.classList.toggle('listening', on);
  document.getElementById('tray-mic').classList.toggle('listening', on);
}

addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || event.target.closest('input, textarea, button, select, .kind-setup')) return;
  event.preventDefault();
  startListening();
});
addEventListener('keyup', event => { if (event.code === 'Space') stopListening(); });
shell?.onToggleListen?.(() => (recorder ? stopListening() : startListening()));

// ---------- taskbar, start menu, tray ----------

const startButton = document.getElementById('start');
const startMenu = document.getElementById('start-menu');
startButton.addEventListener('click', event => {
  event.stopPropagation();
  startMenu.hidden = !startMenu.hidden;
  startButton.classList.toggle('open', !startMenu.hidden);
});
addEventListener('click', () => { startMenu.hidden = true; startButton.classList.remove('open'); });
startMenu.addEventListener('click', event => {
  const action = event.target.closest('button')?.dataset.action;
  sound.unlock();
  if (action === 'console') showConsole();
  else if (action === 'index') command('choose a sequence');
  else if (action === 'music') { musicChoice = sound.isMusicOn() ? 'off' : 'on'; updateMusic(); }
  else if (action === 'test-call') command('test call');
  else if (action === 'clear') command('clear the desktop');
  else if (action?.startsWith('folder-')) openFolder(action.slice(7));
  else if (action === 'setup') showSetup();
});
shell?.onOpenSetup?.(() => showSetup());

/** Opens the projects or printouts folder in Windows. In a plain browser it shows where it is. */
async function openFolder(which) {
  const where = folders[which];
  if (shell?.openFolder) {
    const problem = await shell.openFolder(which).catch(error => error.message);
    if (problem) logLine('system', `Could not open the folder: ${problem}`);
    return;
  }
  wm.open({ id: `folder-${which}-${Date.now()}`, kind: 'note', title: `${which[0].toUpperCase()}${which.slice(1)} folder`, text: where ?? 'Unknown.' }, { instant: true });
}

const micTray = document.getElementById('tray-mic');
micTray.addEventListener('pointerdown', event => { event.preventDefault(); startListening(); });
micTray.addEventListener('pointerup', stopListening);
micTray.addEventListener('pointerleave', stopListening);
const muteTray = document.getElementById('tray-mute');
muteTray.addEventListener('click', () => {
  muted = !muted;
  muteTray.classList.toggle('off', muted);
  sound.setMuted(muted);
  updateMusic();
});

addEventListener('pointerdown', () => sound.unlock(), { once: true });

// In overlay mode the empty parts of the screen let clicks through to whatever is behind.
if (overlay && shell?.setIgnoreMouse) {
  let ignoring = null;
  addEventListener('mousemove', event => {
    const overSomething = Boolean(event.target.closest?.('.window'));
    const dragging = [...wm.windows.values()].some(record => record.dragging);
    const want = !overSomething && !dragging;
    if (want !== ignoring) { ignoring = want; shell.setIgnoreMouse(want); }
  }, true);
}

connect();
