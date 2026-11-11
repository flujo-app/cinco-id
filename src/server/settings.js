import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SECRET_NAMES, findSecret } from './secrets.js';

/**
 * The settings people can change from the Setup window, how they are checked, and how they are
 * written to the settings file. Everything else in the file (outside tools, WhatsApp, printing)
 * is kept exactly as it was.
 */

export const BRAIN_PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
};

export const SPEECH_MODELS = ['large-v3', 'large-v3-turbo', 'medium', 'small', 'base', 'tiny'];

const MODEL = /^[\w.:/@+-]{1,120}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const KEY = /^[\x21-\x7e]{8,400}$/; // printable, no spaces
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,39}$/u;
const PYTHON_FILE = /^(python|pythonw|py)[\d.]*(\.exe)?$/i;

export class SettingsError extends Error {
  constructor(message, field = null, status = 400) {
    super(message);
    this.field = field;
    this.status = status;
  }
}

function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function merge(base, extra) {
  const out = { ...(isObject(base) ? base : {}) };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = isObject(value) ? merge(out[key], value) : value;
  }
  return out;
}

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

/**
 * A Python the app may start. Either the plain word "python" (found by Windows the usual way,
 * only where `allowBare`) or the full path of an existing python.exe. Nothing else: whatever is
 * typed on the screen can never become some other program.
 */
export async function checkPython(value, { allowBare = false, field = 'python', exists = isFile } = {}) {
  const text = String(value ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (allowBare && text === 'python') return text;
  if (!text) throw new SettingsError('Give the full path of python.exe.', field);
  if (!path.isAbsolute(text)) throw new SettingsError('Give the full path of python.exe, for example C:\\Python313\\python.exe.', field);
  if (!PYTHON_FILE.test(path.basename(text))) throw new SettingsError('That file is not a Python program (python.exe).', field);
  if (!(await exists(text))) throw new SettingsError('There is no such file.', field);
  return path.normalize(text);
}

function text(value, field, { pattern, message, optional = false }) {
  const clean = String(value ?? '').trim();
  if (!clean && optional) return null;
  if (!pattern.test(clean)) throw new SettingsError(message, field);
  return clean;
}

/**
 * Checks what the screen sent and turns it into changes for the settings file plus key changes.
 * `context`: { voices: [{ engine, name }], canStoreSecrets, claudeFound, exists }.
 * Throws a SettingsError naming the field and saying in plain words what is wrong.
 */
export async function validateSettings(input, context = {}) {
  if (!isObject(input)) throw new SettingsError('The settings could not be read.');
  const changes = {};
  const secrets = {};
  const exists = context.exists ?? isFile;

  if (input.operator !== undefined) {
    changes.operator = text(input.operator, 'operator', { pattern: NAME, message: 'Use up to 40 letters, numbers or spaces for the name.' });
  }

  const tts = input.voice?.tts;
  if (tts !== undefined) {
    if (!isObject(tts)) throw new SettingsError('The voice could not be read.', 'voice');
    const voices = context.voices ?? [];
    if (tts.engine === 'voder') {
      if (!voices.some(voice => voice.engine === 'voder')) throw new SettingsError('The robot voice is not installed next to this app.', 'voice');
      changes.voice = { tts: { engine: 'voder', voice: null } };
    } else if (tts.engine === 'windows') {
      const found = voices.find(voice => voice.engine === 'windows' && voice.name === tts.voice);
      if (!found) throw new SettingsError('There is no such Windows voice on this PC.', 'voice');
      changes.voice = { tts: { engine: 'windows', voice: found.name } };
    } else if (tts.engine === 'browser') {
      changes.voice = { tts: { engine: 'browser', voice: null } };
    } else {
      throw new SettingsError('Choose one of the voices in the list.', 'voice');
    }
  }

  const stt = input.voice?.stt;
  if (stt !== undefined) {
    if (!isObject(stt)) throw new SettingsError('The listening settings could not be read.', 'ears');
    if (stt.engine === 'off') {
      changes.voice = merge(changes.voice, { stt: { engine: 'off' } });
    } else if (stt.engine === 'whisper') {
      const python = await checkPython(stt.python, { field: 'earsPython', exists });
      const model = text(stt.model || 'large-v3', 'earsModel', { pattern: MODEL, message: 'That is not a speech model name.' });
      const device = stt.device === 'cpu' ? 'cpu' : 'cuda';
      changes.voice = merge(changes.voice, { stt: { engine: 'whisper', python, model, device, computeType: device === 'cpu' ? 'int8' : 'int8_float16' } });
    } else {
      throw new SettingsError('Choose whether the computer should listen.', 'ears');
    }
  }

  const brain = input.brain;
  if (brain !== undefined) {
    if (!isObject(brain)) throw new SettingsError('The brain settings could not be read.', 'brain');
    if (brain.engine === 'none') {
      changes.brain = { enabled: false };
    } else if (brain.engine === 'claude-cli') {
      if (!context.claudeFound) throw new SettingsError('The claude command was not found on this PC.', 'brain');
      changes.brain = { enabled: true, engine: 'claude-cli', model: text(brain.model || 'haiku', 'brainModel', { pattern: MODEL, message: 'That is not a model name.' }) };
    } else if (brain.engine === 'api') {
      let address;
      try { address = new URL(String(brain.baseUrl ?? '').trim()); } catch { address = null; }
      if (!address || !/^https?:$/.test(address.protocol) || address.username || address.password) {
        throw new SettingsError('Give the web address of the service, starting with https://', 'brainUrl');
      }
      changes.brain = {
        enabled: true,
        engine: 'api',
        baseUrl: address.href.replace(/\/$/, ''),
        model: text(brain.model, 'brainModel', { pattern: MODEL, message: 'Give the name of the model to use.' }),
        apiKeyEnv: text(brain.apiKeyEnv, 'brainKeyEnv', { pattern: ENV_NAME, message: 'That is not a name for an environment variable.', optional: true }),
      };
    } else {
      throw new SettingsError('Choose a brain.', 'brain');
    }
  }

  if (input.media?.python !== undefined) {
    changes.media = { python: await checkPython(input.media.python, { allowBare: true, field: 'mediaPython', exists }) };
  }

  for (const [name, value] of Object.entries(input.secrets ?? {})) {
    if (!SECRET_NAMES.includes(name)) throw new SettingsError('There is no such key.', 'secrets');
    if (value === undefined || value === '') continue; // keep what is stored
    if (value === null) { secrets[name] = null; continue; }
    // Never repeat the key in a message: it would end up on the screen.
    if (typeof value !== 'string' || !KEY.test(value.trim())) throw new SettingsError('That key does not look right (no spaces, at least 8 characters).', `${name}Key`);
    if (!context.canStoreSecrets) {
      throw new SettingsError('Keys can only be stored by the desktop app. Set the environment variable instead.', `${name}Key`, 409);
    }
    secrets[name] = value.trim();
  }
  return { changes, secrets };
}

/** The settings file as it is on disk (an empty object when there is none yet). */
export async function readSettingsFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new SettingsError(`The settings file could not be read, so it was left alone: ${error.message}`, null, 409);
  }
}

/** Adds the changes to the settings file, keeping everything else in it. */
export async function writeSettingsFile(file, changes) {
  const merged = merge(await readSettingsFile(file), changes);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.part`;
  await fs.writeFile(partial, JSON.stringify(merged, null, 2) + '\n');
  await fs.rename(partial, file);
  return merged;
}

/** What the screen may see of the settings: everything except the keys themselves. */
export function publicSettings(config, { secrets, env = process.env, speaker, firstRun = false }) {
  const brain = config.brain ?? {};
  const keyInfo = name => {
    const found = findSecret(name, { secrets, env, config });
    return { set: Boolean(found.value), source: found.source, envName: found.envName ?? null };
  };
  return {
    operator: config.operator,
    operatorFromEnv: config.fromEnv?.includes('operator') ?? false,
    dataDir: config.dataDir,
    configFile: config.configFile,
    firstRun,
    canStoreSecrets: Boolean(secrets?.canStore),
    voice: {
      tts: { engine: speaker?.engine ?? config.voice.tts.engine, voice: speaker ? speaker.voice : config.voice.tts.voice ?? null },
      stt: {
        engine: config.voice.stt.engine, python: config.voice.stt.python, model: config.voice.stt.model, device: config.voice.stt.device,
      },
    },
    brain: {
      // A key-based brain without a model does nothing, so it counts as none.
      engine: !brain.enabled ? 'none' : brain.engine === 'claude-cli' ? 'claude-cli' : brain.model ? 'api' : 'none',
      baseUrl: brain.baseUrl ?? '', model: brain.model ?? '', apiKeyEnv: brain.apiKeyEnv ?? null,
    },
    media: { python: config.media?.python ?? 'python' },
    secrets: Object.fromEntries(SECRET_NAMES.map(name => [name, keyInfo(name)])),
    presets: BRAIN_PRESETS,
    speechModels: SPEECH_MODELS,
  };
}
