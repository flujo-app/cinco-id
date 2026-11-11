import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineWorker } from './worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// How the robot voice should say names it would otherwise guess at (ARPABET sounds).
const BASE_LEXICON = {
  tayne: 'T EY N',
  beta: 'B EY T AH',
  oyster: 'OY S T ER',
  celery: 'S EH L ER IY',
  moe: 'M OW',
  sequence: 'S IY K W AH N S',
  sequences: 'S IY K W AH N S IH Z',
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

/** The computer's voice. Sentences are kept on disk, so each one is only made once. */
export class Speaker {
  constructor(config, cacheDir) {
    this.config = config;
    this.cacheDir = cacheDir;
    this.engine = config.engine;
    this.worker = null;
    this.inFlight = new Map();
  }

  get serverSide() { return this.engine === 'voder'; }

  /** Starts the voice and prepares the everyday sentences, so the first answer is not late. */
  warm(sentences = []) {
    if (!this.serverSide) return;
    (async () => { for (const sentence of sentences) await this.speak(sentence).catch(() => {}); })();
  }

  async speak(text) {
    if (!this.serverSide) return null;
    const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!clean) return null;
    const settings = [this.config.pitch, this.config.rate, this.config.expression, this.config.mode];
    const name = createHash('sha256').update(JSON.stringify([clean, settings])).digest('hex').slice(0, 24);
    const file = path.join(this.cacheDir, `${name}.wav`);
    try { await fs.access(file); return file; } catch { /* not made yet */ }
    if (this.inFlight.has(file)) return this.inFlight.get(file);
    const job = (async () => {
      await fs.mkdir(this.cacheDir, { recursive: true });
      this.worker ??= new LineWorker({
        name: 'The voice',
        command: this.config.python,
        args: [path.join(here, 'tts_worker.py'), this.config.voderPath],
      });
      const partial = `${file}.part`;
      await this.worker.request({
        text: clean, out: partial, pitch: this.config.pitch, rate: this.config.rate,
        expression: this.config.expression, mode: this.config.mode,
        lexicon: { ...BASE_LEXICON, ...(this.config.lexicon ?? {}) },
      }, 30_000);
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
    const stem = path.join(os.tmpdir(), `beta-sequence-${process.pid}-${Date.now()}`);
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
