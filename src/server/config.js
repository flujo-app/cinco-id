import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key], value) : value;
  }
  return out;
}

function capitalise(name) {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

/** Where the settings file is, or null when settings are switched off (CINCO_ID_CONFIG=none). */
export function settingsFile(dataDir, env = process.env) {
  if (env.CINCO_ID_CONFIG === 'none') return null;
  return env.CINCO_ID_CONFIG ? path.resolve(env.CINCO_ID_CONFIG) : path.join(dataDir, 'harness.config.json');
}

/**
 * Settings: sensible defaults, then harness.config.json (not in git, machine-specific),
 * then whatever the caller passes in.
 *
 * `rootDir` is the app folder (code, helper scripts, the bundled demo project). `dataDir` is
 * where the settings file, memory, printouts, caches and projects live; it is the app folder
 * itself unless something else is given (see paths.js).
 */
export async function loadConfig(rootDir, overrides = {}, { dataDir = null } = {}) {
  const env = process.env;
  const data = dataDir ?? (env.CINCO_ID_DATA_DIR ? path.resolve(env.CINCO_ID_DATA_DIR) : rootDir);
  const siblingVoder = path.join(rootDir, '..', 'voder');
  const defaults = {
    port: 19773, // 0x4d3d
    operator: capitalise(path.basename(os.homedir()) || os.userInfo().username),
    defaultProject: '4d3d3d3',
    maxWindows: 96,
    projectsDir: path.join(data, 'projects'),
    musicDir: path.join(data, 'music'), // your own music: any mp3, ogg or wav put here is played instead of the built-in band
    stateDir: path.join(data, '.local'),
    setup: { onFirstStart: true }, // the Setup window opens by itself when there is no settings file yet
    gate: { repeatFirst: true },
    voice: {
      tts: {
        // The robot voice if the voder project sits next door; otherwise the voice built into
        // Windows, so a fresh copy can speak without any extra setup.
        engine: existsSync(path.join(siblingVoder, 'voder', 'engine.py')) ? 'voder' : process.platform === 'win32' ? 'windows' : 'browser',
        python: 'python',
        voderPath: siblingVoder,
        pitch: 104,
        rate: 1.02,
        expression: 0.55,
        mode: 'clear',
      },
      stt: {
        engine: 'off', // "whisper" once a Python with faster-whisper is configured
        python: 'python',
        model: 'large-v3',
        device: 'cuda',
        computeType: 'int8_float16',
        hubCache: null,
        offline: true,
        language: 'en',
      },
    },
    mcp: { enabled: true, token: null }, // the local door for AI agents; token is made on first start
    brain: {
      enabled: true,
      engine: 'api', // "api": any chat service with a key. "claude-cli": the Claude subscription on this PC
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      model: null, // no model, no brain: the fixed phrases still work
      maxSteps: 6,
    },
    mcpServers: {},
    // CINCO ID's own WhatsApp link: it runs its own copy of the WhatsApp connector (mcp-whatsapp-web)
    // as one more linked device, with its sign-in in <data>/whatsapp. "Link WhatsApp" in Setup
    // switches it on. See whatsapp.js.
    whatsapp: {
      enabled: false,
      connectorDir: null, // a folder with mcp-whatsapp-web 1.4.2 or newer; otherwise the copy Setup installed, then one next to this folder
      lookNextDoor: true, // also use a mcp-whatsapp-web folder next to the app folder (handy when developing)
      brainTools: ['search_contacts', 'get_contact_by_id'], // what the brain may use from it; anything beyond these two asks first
    },
    events: {
      whatsapp: { secret: null, messages: 'sender', declineTool: null },
      generic: { secret: null },
    },
    // print: "pdf" sends each printout straight to `printer` through the Windows print system
    // (the PDF printer then asks where to save), "dialog" shows the Windows print window, "off" only saves the picture.
    printouts: { dir: path.join(data, 'printouts'), print: 'pdf', printer: 'Microsoft Print to PDF' },
    media: { python: 'python', script: path.join(rootDir, 'tools', 'media', 'generate.py'), enabled: true },
  };
  // For tests and second copies: CINCO_ID_CONFIG=none ignores the settings file,
  // CINCO_ID_STATE_DIR keeps their memory apart from the real one.
  const configFile = settingsFile(data, env);
  let fromFile = {};
  if (configFile) {
    try {
      fromFile = JSON.parse(await fs.readFile(configFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`${configFile} could not be read: ${error.message}`);
    }
  }
  const fromEnv = {};
  if (env.CINCO_ID_PORT) fromEnv.port = Number(env.CINCO_ID_PORT);
  if (env.CINCO_ID_OPERATOR) fromEnv.operator = env.CINCO_ID_OPERATOR;
  if (env.CINCO_ID_STATE_DIR) fromEnv.stateDir = env.CINCO_ID_STATE_DIR;
  if (env.CINCO_ID_PROJECTS_DIR) fromEnv.projectsDir = env.CINCO_ID_PROJECTS_DIR;
  if (env.CINCO_ID_PRINTOUTS_DIR) fromEnv.printouts = { dir: env.CINCO_ID_PRINTOUTS_DIR };
  if (/^(1|true|yes|off)$/i.test(env.CINCO_ID_NO_SETUP ?? '')) fromEnv.setup = { onFirstStart: false };
  const config = merge(merge(merge(defaults, fromFile), fromEnv), overrides);
  // Where things are is decided here, never by the settings file.
  return {
    ...config,
    appDir: rootDir,
    dataDir: data,
    configFile,
    cacheDir: path.join(data, '.cache'),
    bundledProjectsDir: path.join(rootDir, 'projects'),
    fromEnv: Object.keys(fromEnv),
    // Whether someone picked the voice; if not, the robot voice is used once it is found.
    voiceEngineChosen: Boolean(fromFile.voice?.tts?.engine || overrides.voice?.tts?.engine),
  };
}
