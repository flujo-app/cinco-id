import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { checkPython } from './settings.js';
import { findSecret } from './secrets.js';

/**
 * What the Setup window needs to know about this PC, and the two fixed programs it may start
 * (signing in to Modal and preparing the dancer tools). Nothing here reads the contents of a
 * sign-in file, and the only programs ever started are a Python the person chose (checked to be
 * a real python.exe) with fixed arguments, and the Windows voice helper.
 */

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/** Looks for a command the way Windows does when you type its name, without running it. */
export async function findOnPath(name, { env = process.env, platform = process.platform, fileExists = exists } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const extensions = platform === 'win32' ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(ext => ext.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/** Where Modal keeps its sign-in. Only whether the file exists is ever looked at. */
export function modalSignInFile(env = process.env, home = os.homedir()) {
  return env.MODAL_CONFIG_PATH || path.join(home, '.modal.toml');
}

// Runs inside the chosen Python. The model name arrives as an argument, never as code. It only
// looks into the local model cache (local_files_only), so nothing is downloaded.
const EARS_CHECK = `
import json, sys
try:
    import faster_whisper
except Exception:
    print(json.dumps({"ok": False, "reason": "faster-whisper is not installed in this Python."}))
    sys.exit(0)
out = {"ok": True, "version": getattr(faster_whisper, "__version__", "?")}
try:
    from faster_whisper.utils import download_model
    download_model(sys.argv[1], local_files_only=True, cache_dir=(sys.argv[2] or None))
    out["model"] = True
except Exception:
    out["model"] = False
print(json.dumps(out))
`;

/** Runs a program with fixed arguments and returns what it printed (no shell involved). */
export function runProgram(command, args, { env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise(resolve => {
    execFile(command, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error && typeof error.code !== 'number' ? error.message : null });
    });
  });
}

/** Asks a Python whether it has faster-whisper and the speech model on disk. */
export async function checkEars(python, model, { hubCache = null, run = runProgram, exists: fileExists } = {}) {
  let checked;
  try {
    checked = await checkPython(python, { field: 'earsPython', ...(fileExists ? { exists: fileExists } : {}) });
  } catch (error) {
    return { ok: false, message: error.message };
  }
  const result = await run(checked, ['-c', EARS_CHECK, String(model || 'large-v3'), hubCache ?? ''], {
    env: { ...process.env, PYTHONUTF8: '1', HF_HUB_OFFLINE: '1' }, timeoutMs: 60_000,
  });
  let answer = null;
  try { answer = JSON.parse(result.stdout.trim().split('\n').at(-1)); } catch { /* not an answer */ }
  if (!answer) return { ok: false, message: `This Python did not answer properly. ${(result.error ?? result.stderr).trim().split('\n').at(-1)?.slice(0, 160) ?? ''}`.trim() };
  if (!answer.ok) return { ok: false, message: answer.reason };
  return {
    ok: true,
    version: answer.version,
    model: answer.model,
    message: answer.model
      ? `This Python has faster-whisper ${answer.version}, and the "${model}" speech model is on this PC.`
      : `This Python has faster-whisper ${answer.version}, but the "${model}" speech model is not on this PC yet. Download it once yourself; this app never downloads it.`,
  };
}

/** Reads what preparing the dancer tools costs and how long it takes, from docs/MEDIA.md. */
export async function prepareInfo(docsFile) {
  let text = '';
  try { text = await fs.readFile(docsFile, 'utf8'); } catch { return { found: false }; }
  const paragraph = /`--prepare`[^\n]*builds[\s\S]*?(?:\n\s*\n|$)/.exec(text)?.[0] ?? '';
  const flat = paragraph.replace(/\s+/g, ' ');
  const size = /about ([\d.,]+ ?[GMT]B)/.exec(flat)?.[1] ?? null;
  const time = /about ([\d]+(?: to \d+)? minutes)/.exec(flat)?.[1] ?? null;
  const cost = /about (\$[\d.]+)/.exec(flat)?.[1] ?? null;
  return { found: Boolean(time && cost), size, time, cost, source: 'docs/MEDIA.md' };
}

/**
 * What is available on this PC. `probe` lets tests stand in for the real PC:
 *   { env, home, fileExists, findCommand(name), listVoices(), voderAvailable, checkEars(python, model) }
 */
export async function setupStatus(config, { secrets, probe = {} } = {}) {
  const env = probe.env ?? process.env;
  const fileExists = probe.fileExists ?? exists;
  const findCommand = probe.findCommand ?? (name => findOnPath(name, { env, fileExists }));
  const listVoices = probe.listVoices ?? (async () => []);
  const ears = config.voice.stt.engine === 'whisper'
    ? (probe.checkEars ?? checkEars)(config.voice.stt.python, config.voice.stt.model, { hubCache: config.voice.stt.hubCache })
    : Promise.resolve(null);
  const signInFile = modalSignInFile(env, probe.home ?? os.homedir());
  const [voices, claude, modal, signedIn, earsResult] = await Promise.all([
    listVoices().catch(() => []),
    findCommand('claude'),
    findCommand('modal'),
    fileExists(signInFile),
    ears.catch(error => ({ ok: false, message: error.message })),
  ]);
  const openrouter = findSecret('openrouter', { secrets, env, config });
  return {
    voices: voices.map(voice => ({ engine: voice.engine, name: voice.name, language: voice.language ?? null })),
    voder: { available: voices.some(voice => voice.engine === 'voder') || Boolean(probe.voderAvailable) },
    ears: earsResult ? { configured: true, ...earsResult } : { configured: false },
    claude: { found: Boolean(claude) },
    modal: {
      command: Boolean(modal),
      signedIn: signedIn || Boolean(env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET),
    },
    openrouter: { set: Boolean(openrouter.value), source: openrouter.source },
    generator: { script: await fileExists(config.media.script) },
  };
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/**
 * The two longer jobs the Setup window can start, one at a time each:
 *   "modal-login": <python> -m modal setup         (Modal's own sign-in; it opens the browser)
 *   "prepare":     <python> tools/media/generate.py --prepare   (only with an explicit yes)
 */
export class SetupTasks {
  constructor({ getConfig, spawn = nodeSpawn, env = process.env, fileExists = exists }) {
    this.getConfig = getConfig;
    this.spawn = spawn;
    this.env = env;
    this.fileExists = fileExists;
    this.tasks = new Map();
  }

  status(name) {
    const task = this.tasks.get(name);
    if (!task) return { task: name, running: false, ok: null, message: '', lines: [] };
    const { child, timer, failed, ...visible } = task;
    return visible;
  }

  async start(name, { confirm = false } = {}) {
    if (!['modal-login', 'prepare'].includes(name)) throw Object.assign(new Error('There is no such task.'), { status: 400 });
    if (this.tasks.get(name)?.running) throw Object.assign(new Error('That is already running.'), { status: 409 });
    const config = this.getConfig();
    if (name === 'prepare' && confirm !== true) throw Object.assign(new Error('Preparing costs money, so it needs a clear yes first.'), { status: 400 });
    const python = await checkPython(config.media.python, { allowBare: true, field: 'mediaPython', exists: this.fileExists })
      .catch(error => { throw Object.assign(new Error(error.message), { status: 400 }); });
    let args;
    if (name === 'modal-login') {
      args = ['-m', 'modal', 'setup'];
    } else {
      if (!(await this.fileExists(config.media.script))) throw Object.assign(new Error('The dancer tools are missing from this copy.'), { status: 409 });
      args = [config.media.script, '--prepare'];
    }
    const task = { task: name, running: true, ok: null, message: name === 'prepare' ? 'Starting' : 'Opening the Modal sign-in in your browser', progress: null, lines: [], startedAt: Date.now() };
    this.tasks.set(name, task);
    let child;
    try {
      child = this.spawn(python, args, {
        cwd: path.dirname(config.media.script),
        env: { ...this.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      Object.assign(task, { running: false, ok: false, message: `Could not start Python: ${error.message}` });
      return this.status(name);
    }
    task.child = child;
    const note = line => {
      const clean = String(line).replace(ANSI, '').trim();
      if (!clean) return;
      let update = null;
      if (clean.startsWith('{')) { try { update = JSON.parse(clean); } catch { /* plain text */ } }
      if (update?.error) { task.message = String(update.error).slice(0, 300); task.failed = true; }
      else if (update?.done) task.message = 'Done.';
      else if (update) {
        if (typeof update.progress === 'number') task.progress = update.progress;
        if (update.message) task.message = String(update.message).slice(0, 300);
      } else {
        task.lines.push(clean.slice(0, 300));
        task.lines = task.lines.slice(-8);
      }
    };
    readline.createInterface({ input: child.stdout }).on('line', note);
    readline.createInterface({ input: child.stderr }).on('line', note);
    const limit = name === 'prepare' ? 90 * 60_000 : 10 * 60_000;
    task.timer = setTimeout(() => { task.message = 'It took too long and was stopped.'; child.kill(); }, limit);
    task.timer.unref?.();
    child.on('error', error => {
      clearTimeout(task.timer);
      Object.assign(task, { running: false, ok: false, message: `Could not start Python: ${error.message}`, finishedAt: Date.now() });
    });
    child.on('exit', code => {
      clearTimeout(task.timer);
      if (!task.running) return;
      const ok = code === 0 && !task.failed;
      Object.assign(task, {
        running: false, ok, finishedAt: Date.now(),
        message: ok ? (name === 'modal-login' ? 'Signed in to Modal.' : 'The dancer tools are ready.') : (task.message && task.message !== 'Starting' ? task.message : `It stopped (code ${code}).`),
      });
    });
    return this.status(name);
  }

  stopAll() {
    for (const task of this.tasks.values()) {
      if (task.running) { clearTimeout(task.timer); task.child?.kill(); task.running = false; }
    }
  }
}
