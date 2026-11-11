import { WindowManager } from './wm.js';
import { Stage, SequenceView, renderStill, clipStatus } from './stage.js';
import * as sound from './sound.js';
import { buildSetup } from './setup.js';

const shell = window.shell ?? null; // present when running inside the desktop shell
const query = new URLSearchParams(location.search);
const overlay = query.has('overlay');
document.body.classList.toggle('overlay', overlay);
if (query.has('silent')) sound.setMuted(true); // for tests: no voice, no music

const stage = new Stage();
window.betaSequence = { clipStatus, voiceLog: sound.voiceLog }; // for the checks in test/ui
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

function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

// ---------- what goes inside each kind of window ----------

const builders = {
  sequence(record, desc) {
    const canvas = el('canvas');
    canvas.width = record.bodyW;
    canvas.height = record.bodyH;
    record.body.classList.add(`seq-bg-${hash(desc.sequence.key) % 5}`);
    record.body.append(canvas);
    const view = new SequenceView(canvas, desc.sequence, { effects: desc.effects, phase: desc.phase ?? 0 });
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
    const row = el('div', 'call-row');
    const info = el('div');
    info.append(
      el('div', 'call-name', call.caller),
      el('div', 'call-number', contact.number ? `+${contact.number}` : 'Number withheld'),
      el('div', 'call-kind', [
        call.isVideo ? 'WhatsApp video call' : 'WhatsApp voice call',
        call.isGroup ? 'group call' : null,
        contact.isMyContact ? 'saved contact' : 'not in your contacts',
        contact.pushname && contact.pushname !== call.caller ? `shows as "${contact.pushname}"` : null,
      ].filter(Boolean).join(' · ')),
    );
    row.append(el('div', 'icon icon-phone'), info);
    const buttons = el('div', 'button-row');
    const decline = el('button', 'w95', 'Decline');
    decline.disabled = !desc.canDecline;
    decline.title = desc.canDecline ? '' : 'Declining is not connected yet';
    decline.addEventListener('click', () => send({ type: 'call.decline', callId: call.callId }));
    const dismiss = el('button', 'w95', 'Dismiss');
    dismiss.addEventListener('click', () => wm.close(desc.id, { byHand: true }));
    const accept = el('button', 'w95', 'Accept');
    accept.addEventListener('click', () => send({ type: 'call.accept', callId: call.callId }));
    buttons.append(accept, decline, dismiss);
    record.body.append(row, buttons);
    record.cleanup = () => setTimeout(stopRingIfQuiet, 0);
  },

  note(record, desc) {
    record.body.append(el('pre', 'note-text sunken', desc.text ?? ''));
  },

  progress(record, desc) {
    const label = el('div', 'pad', desc.text ?? '');
    const track = el('div', 'progress-track sunken busy');
    for (let i = 0; i < 8; i++) track.append(el('i'));
    record.body.append(label, track);
    record.setProgress = (value, text) => {
      if (text) label.textContent = text;
      if (typeof value !== 'number') return;
      track.classList.remove('busy');
      const blocks = Math.round(Math.max(0, Math.min(1, value)) * 24);
      track.replaceChildren(...Array.from({ length: blocks }, () => el('i')));
    };
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

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

async function printPage(paper, desc) {
  const ctx = paper.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, paper.width, paper.height);
  const still = await renderStill(desc.sequence, desc.expression, 2);
  const k = Math.min(520 / still.width, 560 / still.height);
  ctx.drawImage(still, (paper.width - still.width * k) / 2, 96, still.width * k, still.height * k);

  // The cheap colour-printer look: few ink levels, ordered dots.
  const image = ctx.getImageData(0, 0, paper.width, paper.height);
  const data = image.data;
  for (let y = 0; y < paper.height; y++) {
    for (let x = 0; x < paper.width; x++) {
      const i = (y * paper.width + x) * 4;
      const threshold = (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5;
      for (let c = 0; c < 3; c++) {
        const level = Math.round(data[i + c] / 255 * 5 + threshold * 0.7);
        data[i + c] = Math.max(0, Math.min(5, level)) * 51;
      }
    }
  }
  ctx.putImageData(image, 0, 0);

  ctx.fillStyle = '#000';
  ctx.font = 'bold 26px "Courier New", monospace';
  ctx.fillText('PRINTOUT', 40, 56);
  ctx.font = '15px "Courier New", monospace';
  ctx.fillText(new Date().toLocaleString('en-GB'), 40, 80);
  ctx.fillRect(40, 90, 520, 2);
  ctx.fillRect(40, 676, 520, 2);
  ctx.font = 'bold 22px "Courier New", monospace';
  ctx.fillText(desc.caption.toUpperCase(), 40, 708);
  ctx.font = '14px "Courier New", monospace';
  ctx.fillText(`SEQUENCE ${desc.sequence.key}${desc.sequence.variant ? ` / ${desc.sequence.variant}` : ''}`, 40, 732);
  ctx.fillText(`PRINTED FOR ${operator.toUpperCase()}`, 40, 752);
}

// ---------- the desktop ----------

const wm = new WindowManager({
  desktop: document.getElementById('desktop'),
  tasks: document.getElementById('tasks'),
  builders,
  onClosed: (id, desc) => { if (desc.kind !== 'console' && desc.kind !== 'setup') send({ type: 'window.closed', id }); updateMusic(); },
});

// ---------- the Setup window ----------

let setupPending = false; // the first start: the greeting waits until Setup is closed

function showSetup({ firstRun = false } = {}) {
  const existing = wm.windows.get('setup');
  if (existing) { wm.minimise(existing, false); return; }
  wm.open({ id: 'setup', kind: 'setup', title: 'CINCO ID Setup', firstRun }, { instant: true });
}

async function setupClosed(firstRun, saved) {
  if (!firstRun) return;
  // Closed on the first start without saving: remember that, so it does not ask on every start.
  if (!saved) {
    await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ announce: false }) }).catch(() => {});
  }
  setupPending = false;
  if (!greeted) { greeted = true; send({ type: 'hello' }); }
}

function showConsole() {
  const existing = wm.windows.get('console');
  if (existing) { wm.minimise(existing, false); return; }
  wm.open({ id: 'console', kind: 'console', title: 'Computer' }, { instant: true });
  for (const line of pendingLines.splice(0)) logLine(line.who, line.text);
  consoleUi.input?.focus();
}

const pendingLines = [];
function logLine(who, text) {
  if (!consoleUi.log?.isConnected) { pendingLines.push({ who, text }); return; }
  const line = el('div', who, text);
  consoleUi.log.append(line);
  while (consoleUi.log.childElementCount > 300) consoleUi.log.firstElementChild.remove();
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

function drawIcons(projects) {
  const icons = document.getElementById('icons');
  icons.replaceChildren();
  const add = (art, label, action) => {
    const button = el('button', 'desktop-icon');
    button.append(el('div', `icon-art ${art}`), el('span', '', label));
    button.addEventListener('dblclick', action);
    icons.append(button);
  };
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
      if (!greeted && !setupPending) { greeted = true; send({ type: 'hello' }); }
      break;
    }
    case 'setup.open':
      showSetup();
      break;
    case 'settings.changed':
      operator = action.operator ?? operator;
      voice = action.voice ?? voice;
      sound.setVoiceMode(voice.speak);
      break;
    case 'say':
      logLine('computer', action.text);
      sound.say(action.speak ?? action.text);
      break;
    case 'heard':
      logLine('operator', action.text);
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
    case 'music': musicChoice = action.on ? 'on' : 'off'; updateMusic(); break;
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
  else if (action === 'index') command('list everything');
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
  wm.open({ id: `folder-${which}-${Date.now()}`, kind: 'note', title: which === 'projects' ? 'Projects folder' : 'Printouts folder', text: where ?? 'Unknown.' }, { instant: true });
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

function tickClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
tickClock();
setInterval(tickClock, 10_000);

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
