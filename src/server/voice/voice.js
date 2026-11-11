import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import { bestMatch } from '../text.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineWorker } from './worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// How the robot voice should say names it would otherwise guess at (ARPABET sounds).
const BASE_LEXICON = {
  tayne: 'T EY1 N',
};

/** Whatever the microphone recorded becomes the plain format the recogniser wants. */
function toSpeechWav(ffmpeg, from, to) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-y', '-i', from, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', to], { windowsHide: true });
    let problem = '';
    child.stderr.on('data', chunk => { problem += chunk; });
    child.on('error', () => reject(new Error('ffmpeg is needed for speech recognition and was not found.')));
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`The recording could not be read. ${problem.trim().slice(0, 200)}`))));
  });
}

/** The one command that installs the robot voice as a normal Python package. */
export const VODER_INSTALL = 'pip install git+https://github.com/flujo-app/voder';

const voderChecks = new Map();
/**
 * Whether this Python can import the robot voice as an installed package (pip install
 * git+https://github.com/flujo-app/voder). Only looks it up, does not load it. Remembered per Python.
 */
export function voderPackage(python = 'python', { run = null } = {}) {
  if (!voderChecks.has(python)) {
    voderChecks.set(python, new Promise(resolve => {
      const check = run ?? ((command, args) => new Promise(done => {
        const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill(); done(1); }, 15_000);
        child.on('error', () => { clearTimeout(timer); done(1); });
        child.on('exit', code => { clearTimeout(timer); done(code); });
      }));
      Promise.resolve(check(python, ['-c', 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("voder.engine") else 3)']))
        .then(code => resolve(code === 0), () => resolve(false));
    }));
  }
  return voderChecks.get(python);
}

function windowsWorker() {
  return new LineWorker({
    name: 'The Windows voice',
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'tts_windows.ps1')],
    startTimeoutMs: 30_000,
  });
}

/**
 * The computer's voice. Sentences are kept on disk, so each one is only made once.
 * Engines: "voder" (the robot voice), "windows" (any voice installed in Windows, chosen by
 * name in `voice`), "browser" (the screen speaks with whatever the browser offers).
 */
export class Speaker {
  constructor(config, cacheDir) {
    this.config = config;
    this.cacheDir = cacheDir;
    this.engine = config.engine;
    this.voice = config.voice ?? null; // name of the Windows voice, when that engine is used
    this.worker = null;
    this.inFlight = new Map();
    this.voderInstalled = false;
  }

  get serverSide() { return this.engine === 'voder' || this.engine === 'windows'; }

  /** The robot voice: installed as a Python package, or the voder folder next to this app's folder. */
  get voderAvailable() { return this.voderInstalled === true || existsSync(path.join(this.config.voderPath ?? '', 'voder', 'engine.py')); }

  /** Looks once whether the configured Python has the robot voice installed as a package. */
  async detect({ run = null } = {}) {
    this.voderInstalled = await voderPackage(this.config.python ?? 'python', { run });
    return this.voderAvailable;
  }

  /** Every voice that can be used on this PC: the robot voice plus what Windows has installed. */
  async list() {
    const voices = [];
    if (this.voderAvailable) voices.push({ engine: 'voder', name: 'Robot', labels: ['robot', 'voder', 'robot voice', 'the robot', 'default'] });
    if (process.platform === 'win32') {
      const lister = this.engine === 'windows' && this.worker ? this.worker : windowsWorker();
      try {
        const reply = await lister.request({ list: true }, 20_000);
        for (const voice of reply.voices ?? []) {
          const short = voice.name.replace(/^Microsoft\s+/i, '').replace(/\s+Desktop$/i, '');
          voices.push({ engine: 'windows', name: voice.name, language: voice.language, labels: [voice.name, short, `${short} voice`] });
        }
      } catch { /* no Windows voices to offer */ } finally {
        if (lister !== this.worker) lister.stop();
      }
    }
    return voices;
  }

  /** Switches to a voice by what a person called it. Returns the chosen voice or null. */
  async use(wanted) {
    const choice = typeof wanted === 'string'
      ? bestMatch(wanted, (await this.list()).map(voice => ({ key: voice.name, voice, labels: voice.labels })), { maxRatio: 0.25 })?.voice
      : wanted;
    if (!choice) return null;
    if (choice.engine !== this.engine) { this.worker?.stop(); this.worker = null; }
    this.engine = choice.engine;
    this.voice = choice.engine === 'windows' ? choice.name : null;
    return { engine: this.engine, name: choice.name };
  }

  /** Starts the voice and prepares the everyday sentences, so the first answer is not late. */
  warm(sentences = []) {
    if (!this.serverSide) return;
    (async () => { for (const sentence of sentences) await this.speak(sentence).catch(() => {}); })();
  }

  async speak(text) {
    if (!this.serverSide) return null;
    const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!clean) return null;
    const windows = this.engine === 'windows';
    const settings = windows
      ? ['windows', this.voice, this.config.windowsRate ?? 0]
      : [this.config.pitch, this.config.rate, this.config.expression, this.config.mode];
    const name = createHash('sha256').update(JSON.stringify([clean, settings])).digest('hex').slice(0, 24);
    const file = path.join(this.cacheDir, `${name}.wav`);
    try { await fs.access(file); return file; } catch { /* not made yet */ }
    if (this.inFlight.has(file)) return this.inFlight.get(file);
    const job = (async () => {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const partial = `${file}.part`;
      if (windows) {
        this.worker ??= windowsWorker();
        await this.worker.request({ text: clean, out: partial, voice: this.voice, rate: this.config.windowsRate ?? 0 }, 30_000);
      } else {
        this.worker ??= new LineWorker({
          name: 'The voice',
          command: this.config.python,
          args: [path.join(here, 'tts_worker.py'), this.config.voderPath],
        });
        await this.worker.request({
          text: clean, out: partial, pitch: this.config.pitch, rate: this.config.rate,
          expression: this.config.expression, mode: this.config.mode,
          lexicon: { ...BASE_LEXICON, ...(this.config.lexicon ?? {}) },
        }, 30_000);
      }
      await fs.rename(partial, file);
      return file;
    })().finally(() => this.inFlight.delete(file));
    this.inFlight.set(file, job);
    return job;
  }

  stop() { this.worker?.stop(); this.worker = null; }
}

/** The computer's ears. */
export class Listener {
  constructor(config) {
    this.config = config;
    this.worker = null;
  }

  get available() { return this.config.engine === 'whisper'; }

  /** Loads the recognition model ahead of time so the first sentence is not slow. */
  warm() {
    if (!this.available) return;
    this.ensure().start().catch(() => {});
  }

  ensure() {
    const env = {};
    if (this.config.hubCache) env.HF_HUB_CACHE = this.config.hubCache;
    if (this.config.offline) env.HF_HUB_OFFLINE = '1';
    this.worker ??= new LineWorker({
      name: 'Speech recognition',
      command: this.config.python,
      args: [path.join(here, 'stt_worker.py'), this.config.model, this.config.device, this.config.computeType],
      env,
      startTimeoutMs: 180_000,
    });
    return this.worker;
  }

  async transcribe(buffer, { extension = 'webm', vocabulary = [] } = {}) {
    if (!this.available) throw new Error('Speech recognition is not set up.');
    const stem = path.join(os.tmpdir(), `cinco-id-${process.pid}-${Date.now()}`);
    const heard = `${stem}.${extension}`;
    const wav = `${stem}-16k.wav`;
    await fs.writeFile(heard, buffer);
    try {
      await toSpeechWav(this.config.ffmpeg ?? 'ffmpeg', heard, wav);
      const prompt = vocabulary.length ? `Computer, load up ${vocabulary.join(', ')}.` : null;
      const result = await this.ensure().request({ path: wav, language: this.config.language, prompt }, 60_000);
      return result.text ?? '';
    } finally {
      await fs.rm(heard, { force: true });
      await fs.rm(wav, { force: true });
    }
  }

  stop() { this.worker?.stop(); this.worker = null; }
}
