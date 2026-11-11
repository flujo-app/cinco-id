import http from 'node:http';
import path from 'node:path';
import { promises as fs, createReadStream, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handleMcp } from './mcp-endpoint.js';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { seedProjects } from './paths.js';
import { SecretStore } from './secrets.js';
import { SettingsError, publicSettings, validateSettings, writeSettingsFile } from './settings.js';
import { SetupTasks, checkEars, findOnPath, setupStatus } from './setup.js';
import { Library } from './projects.js';
import { Computer } from './computer.js';
import { createBrain } from './brain.js';
import { Connectors } from './connectors.js';
import { Generator } from './generator.js';
import { Speaker, Listener } from './voice/voice.js';
import { verify, routeWhatsApp } from './events/webhook.js';
import { WhatsAppLink } from './whatsapp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(here, '..', 'ui');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const MEDIA_ONLY = new Set(['.png', '.jpg', '.webm', '.wav', '.ogg', '.mp3']);

function send(response, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

async function readBody(request, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sameText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** Reads the kept access token for outside agents, making one the first time. */
async function keptToken(file) {
  try {
    const saved = (await fs.readFile(file, 'utf8')).trim();
    if (saved.length >= 32) return saved;
  } catch { /* first run */ }
  const token = randomBytes(24).toString('hex');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, token + '\n');
  return token;
}

/** Serves one file from inside `root`, refusing anything that tries to leave it. */
async function serveFile(response, root, relative, { mediaOnly = false } = {}) {
  const file = path.normalize(path.join(root, relative));
  if (!file.startsWith(path.normalize(root + path.sep))) return send(response, 403, 'Not allowed.');
  const extension = path.extname(file).toLowerCase();
  if (!TYPES[extension] || (mediaOnly && !MEDIA_ONLY.has(extension))) return send(response, 404, 'Not found.');
  try {
    const info = await fs.stat(file);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, { 'content-type': TYPES[extension], 'content-length': info.size, 'cache-control': 'no-cache', 'accept-ranges': 'none' });
    createReadStream(file).pipe(response);
  } catch {
    send(response, 404, 'Not found.');
  }
}

/**
 * Puts the whole thing together: projects, the computer, voice, brain, outside tools and the
 * small local web server the screen talks to. Only this machine can reach it.
 */
export async function createApp({ rootDir, dataDir = null, overrides = {}, env = process.env, parts = {} } = {}) {
  const config = await loadConfig(rootDir, overrides, { dataDir });
  // An installed copy starts with the bundled demo project in its own data folder, so people can
  // add theirs next to it. A clone already has it in place.
  const seeded = config.projectsDir === path.join(config.dataDir, 'projects')
    ? await seedProjects(config.bundledProjectsDir, config.projectsDir).catch(() => [])
    : [];
  const notes = [];
  // New dancers that were still being made when the app last stopped are only half there.
  const library = new Library(config.projectsDir);
  const unfinished = await library.removeUnfinished().catch(() => []);
  if (unfinished.length) {
    notes.push(`${unfinished.length === 1 ? 'A new sequence was' : `${unfinished.length} new sequences were`} still being made when the computer last stopped, so ${unfinished.length === 1 ? 'it was' : 'they were'} removed: ${unfinished.map(dir => path.basename(dir)).join(', ')}.`);
  }
  await library.reload();
  const connectors = parts.connectors ?? await new Connectors(config.mcpServers, {
    declineTool: config.events.whatsapp.declineTool,
    onProblem: text => notes.push(text),
    ...(parts.connectorRetryMs ? { retryMs: parts.connectorRetryMs } : {}),
  }).start();
  let port = config.port;
  // Two keys to the /mcp door: one for the computer's own brain (new on every start), and one
  // for outside agents you connect yourself (kept in the state folder so it stays the same).
  const speaker = parts.speaker ?? new Speaker(config.voice.tts, path.join(config.cacheDir, 'tts'));
  if (!parts.speaker) {
    // The robot voice may also be installed as a Python package; then it is the default voice.
    await speaker.detect({ run: parts.probe?.runVoderCheck });
    if (!config.voiceEngineChosen && config.voice.tts.engine !== 'voder' && speaker.voderInstalled) {
      config.voice.tts.engine = 'voder';
      speaker.engine = 'voder';
    }
  }
  const brainToken = randomBytes(24).toString('hex');
  const guestToken = config.mcp?.token ?? await keptToken(path.join(config.stateDir, 'mcp-token'));
  // Keys stored by the Setup window (desktop app only; encrypted with the Windows sign-in).
  const secrets = await new SecretStore({ file: path.join(config.stateDir, 'secrets.json'), cipher: parts.secretCipher ?? null }).load();
  const makeBrain = () => createBrain(config.brain, env, {
    workDir: path.join(config.stateDir, 'brain'),
    mcpUrl: () => `http://127.0.0.1:${port}/mcp`,
    token: brainToken,
    secrets,
  });
  // The dancer generator gets the stored OpenRouter key in its environment, never on its command line.
  const makeGenerator = () => Generator.create(config.media, {
    extraEnv: () => { const key = secrets.get('openrouter'); return key ? { OPENROUTER_API_KEY: key } : {}; },
  });
  const computer = new Computer({
    library,
    config,
    stateFile: path.join(config.stateDir, 'state.json'),
    brain: parts.brain !== undefined ? parts.brain : makeBrain(),
    generator: parts.generator !== undefined ? parts.generator : makeGenerator(),
    connectors,
    voices: speaker,
  });
  await computer.restore();
  // Outside tools that come back (or go away) later: tell the screen, and keep Decline honest.
  connectors.on?.('change', () => computer.declineAvailabilityChanged());
  connectors.on?.('note', text => computer.send({ type: 'note', text }));
  // CINCO ID's own WhatsApp link (started in listen(), once the real port is known).
  const whatsapp = new WhatsAppLink({
    config, connectors, secrets,
    getPort: () => port,
    save: async changes => { if (config.configFile) await writeSettingsFile(config.configFile, changes); },
    probe: parts.whatsappProbe ?? { env },
    ...(parts.whatsappOptions ?? {}), // for tests: { pollMs, dropNoticeMs }
  });
  whatsapp.on('note', text => computer.send({ type: 'note', text }));
  whatsapp.on('change', view => broadcast({ type: 'whatsapp', ...view }));
  const listener = parts.listener ?? new Listener(config.voice.stt);
  const runningEars = JSON.stringify(config.voice.stt);
  // The Setup window opens by itself the first time, when there is no settings file yet.
  let firstRun = config.setup?.onFirstStart !== false && Boolean(config.configFile) && !existsSync(config.configFile);
  const tasks = new SetupTasks({ getConfig: () => config, spawn: parts.spawn, run: parts.probe?.run, env });

  const sockets = new Set();
  const broadcast = action => {
    const text = JSON.stringify(action);
    for (const socket of sockets) if (socket.readyState === 1) socket.send(text);
  };
  computer.on('action', broadcast);

  const ownOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const ownHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  /** Other websites open in a browser must not be able to give the computer orders. */
  const fromElsewhere = request => {
    const origin = request.headers.origin;
    if (origin && !ownOrigins().has(origin)) return true;
    return request.headers['sec-fetch-site'] === 'cross-site';
  };

  async function savePrintout({ caption = 'printout', dataUrl }) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? '');
    if (!match) throw Object.assign(new Error('not a picture'), { status: 400 });
    await fs.mkdir(config.printouts.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = String(caption).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'printout';
    const file = path.join(config.printouts.dir, `${stamp}-${safe}.png`);
    await fs.writeFile(file, Buffer.from(match[1], 'base64'));
    // A real print job, when the desktop shell gave us a printer and printing is switched on.
    let printing = null;
    if (parts.printer && config.printouts.print !== 'off') {
      printing = config.printouts.print === 'dialog' ? 'the Windows print window' : config.printouts.printer;
      parts.printer({ file, caption, url: `http://127.0.0.1:${port}/print/${encodeURIComponent(path.basename(file))}`, settings: config.printouts })
        .then(result => {
          if (result?.success) computer.send({ type: 'note', text: `Printout "${caption}" was handed to ${result.printer ?? 'the printer'}.` });
          else if (result?.reason && !/cancel/i.test(result.reason)) computer.problem(`Printing did not work: ${result.reason}`);
        })
        .catch(error => computer.problem(`Printing did not work: ${error.message}`));
    }
    return { file, printing };
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const route = decodeURIComponent(url.pathname);

      // Signed events from outside programs (WhatsApp calls and messages): from CINCO ID's own
      // WhatsApp link, or from a connector run by another program (the manual way). The secret
      // that signed it says which one sent it.
      if (request.method === 'POST' && route === '/hooks/whatsapp') {
        const body = (await readBody(request, 1024 * 1024)).toString('utf8');
        const via = verify({ secret: whatsapp.secretForCheck(), headers: request.headers, body }) ? 'own'
          : verify({ secret: config.events.whatsapp.secret, headers: request.headers, body }) ? 'manual' : null;
        if (!via) return send(response, 401, 'Bad signature.');
        const outcome = routeWhatsApp(JSON.parse(body), computer, via === 'own' ? { ...config.events.whatsapp, messages: 'off' } : config.events.whatsapp, { via });
        return send(response, 200, { ok: true, outcome });
      }

      if (fromElsewhere(request)) return send(response, 403, 'Not allowed.');

      // The door for AI agents (the computer's own brain and any you connect): MCP over HTTP.
      if (route === '/mcp') {
        if (config.mcp?.enabled === false) return send(response, 404, 'Not found.');
        const given = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const scope = sameText(given, brainToken) ? 'brain' : sameText(given, guestToken) ? 'guest' : null;
        if (!scope) return send(response, 401, { error: 'A valid access token is needed.' });
        if (request.method !== 'POST') return send(response, 405, { error: 'Only POST is supported.' });
        const body = JSON.parse((await readBody(request, 4 * 1024 * 1024)).toString('utf8'));
        return handleMcp(request, response, body, { computer, scope });
      }

      // The Setup window. On top of the origin check above, the address the request was sent to
      // must be this computer's own, so a web page cannot sneak in under another name.
      if (route === '/api/settings' || route.startsWith('/api/setup/')) {
        if (!ownHosts().has(String(request.headers.host ?? '').toLowerCase())) return send(response, 403, 'Not allowed.');
        try {
          return await handleSetup(request, response, route, url);
        } catch (error) {
          return send(response, error.status ?? 500, { error: error.message, field: error.field ?? null });
        }
      }

      if (request.method === 'GET') {
        if (route === '/' || route === '/index.html') return serveFile(response, UI_DIR, 'index.html');
        if (route.startsWith('/ui/')) return serveFile(response, UI_DIR, route.slice(4));
        if (route.startsWith('/projects/')) return serveFile(response, config.projectsDir, route.slice(10), { mediaOnly: true });
        if (route.startsWith('/printouts/')) return serveFile(response, config.printouts.dir, route.slice(11), { mediaOnly: true });
        if (route.startsWith('/print/')) {
          // One printout laid out on a sheet of paper, for the Windows printer.
          const name = route.slice(7);
          const known = /^[\w-][\w.-]*\.png$/.test(name)
            && await fs.access(path.join(config.printouts.dir, name)).then(() => true, () => false);
          if (!known) return send(response, 404, 'Not found.');
          const title = name.replace(/^\d{4}-\d\d-\d\dT[\d-]+-/, '').replace(/\.png$/, '').replace(/-/g, ' ');
          return send(response, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Printout ${title}</title>`
            + '<style>@page{size:A4;margin:12mm}html,body{margin:0;background:#fff}img{display:block;margin:0 auto;max-width:100%;max-height:270mm}</style>'
            + `</head><body><img src="/printouts/${encodeURIComponent(name)}" alt=""></body></html>`, { 'content-type': 'text/html; charset=utf-8' });
        }
        if (route === '/api/state') return send(response, 200, screenState());
        if (route === '/api/tts') {
          const file = await speaker.speak(url.searchParams.get('text') ?? '').catch(error => { notes.push(`Voice: ${error.message}`); return null; });
          if (!file) return send(response, 204, '');
          return serveFile(response, path.dirname(file), path.basename(file));
        }
        return send(response, 404, 'Not found.');
      }

      if (request.method === 'POST') {
        if (route === '/api/command') {
          const { text } = JSON.parse((await readBody(request, 64 * 1024)).toString('utf8'));
          await computer.hear(text, { source: 'typed' });
          return send(response, 200, { ok: true });
        }
        if (route === '/api/stt') {
          const audio = await readBody(request);
          const extension = /ogg/.test(request.headers['content-type'] ?? '') ? 'ogg' : /wav/.test(request.headers['content-type'] ?? '') ? 'wav' : 'webm';
          const text = await listener.transcribe(audio, { extension, vocabulary: [...library.vocabulary(), 'hat wobble', 'beta sequence', 'printout'] });
          return send(response, 200, { text });
        }
        if (route === '/api/printouts') {
          const { file, printing } = await savePrintout(JSON.parse((await readBody(request)).toString('utf8')));
          return send(response, 200, { ok: true, file, url: `/printouts/${path.basename(file)}`, printing });
        }
        return send(response, 404, 'Not found.');
      }
      return send(response, 405, 'Not allowed.');
    } catch (error) {
      send(response, error.status ?? 500, { error: error.message });
    }
  });

  function voiceInfo() {
    return { speak: speaker.serverSide ? 'server' : 'browser', listen: listener.available };
  }

  /** Everything the screen needs when it (re)connects. */
  function screenState() {
    return {
      ...computer.snapshot(), voice: voiceInfo(), notes,
      folders: { data: config.dataDir, projects: config.projectsDir, printouts: config.printouts.dir },
      setup: { firstRun },
    };
  }

  // ---------- the Setup window ----------

  const probe = parts.probe ?? {};
  const listVoices = () => (probe.listVoices ?? (() => speaker.list()))();
  const findCommand = name => (probe.findCommand ?? (wanted => findOnPath(wanted, { env })))(name);
  let savedEars = config.voice.stt; // what the settings file says; the running ears change on restart

  const readJson = async (request, limit = 64 * 1024) => {
    try { return JSON.parse((await readBody(request, limit)).toString('utf8') || '{}'); } catch { throw new SettingsError('That could not be read.'); }
  };

  async function handleSetup(request, response, route, url) {
    const shown = () => publicSettings({ ...config, voice: { ...config.voice, stt: savedEars } }, { secrets, env, speaker, firstRun });
    if (request.method === 'GET') {
      if (route === '/api/settings') return send(response, 200, shown());
      if (route === '/api/setup/status') {
        return send(response, 200, await setupStatus({ ...config, voice: { ...config.voice, stt: savedEars } }, {
          secrets, probe: { ...probe, env: probe.env ?? env, listVoices, findCommand },
        }));
      }
      if (route === '/api/setup/prepare-info') return send(response, 200, await tasks.plan({ docsFile: path.join(config.appDir, 'docs', 'MEDIA.md') }));
      if (route === '/api/setup/task') return send(response, 200, tasks.status(url.searchParams.get('name')));
      if (route === '/api/setup/whatsapp') {
        const overview = await whatsapp.overview();
        const qr = url.searchParams.get('qr') === '1' ? await whatsapp.qr() : null;
        return send(response, 200, { ...overview, qr });
      }
      return send(response, 404, 'Not found.');
    }
    if (request.method !== 'POST') return send(response, 405, 'Not allowed.');
    const body = await readJson(request);
    if (route === '/api/settings') return send(response, 200, await saveSettings(body));
    if (route === '/api/setup/test-voice') {
      const { changes } = await validateSettings({ voice: { tts: { engine: body.engine, voice: body.voice } } }, { voices: await listVoices() });
      const tts = changes.voice.tts;
      if (tts.engine === 'browser') return send(response, 204, '');
      let name = config.operator;
      try { name = (await validateSettings({ operator: body.operator })).changes.operator ?? name; } catch { /* keep the current name */ }
      const tester = new Speaker({ ...config.voice.tts, engine: tts.engine, voice: tts.voice }, path.join(config.cacheDir, 'tts'));
      try {
        const file = await tester.speak(`Hello, ${name}. This is how I sound.`);
        return serveFile(response, path.dirname(file), path.basename(file));
      } catch (error) {
        throw Object.assign(new Error(`That voice did not work: ${error.message}`), { status: 500 });
      } finally {
        tester.stop();
      }
    }
    if (route === '/api/setup/test-ears') {
      const { changes } = await validateSettings({ voice: { stt: { engine: 'whisper', python: body.python, model: body.model } } }, { exists: probe.fileExists });
      const ears = changes.voice.stt;
      return send(response, 200, await (probe.checkEars ?? checkEars)(ears.python, ears.model, { hubCache: savedEars.hubCache ?? null }));
    }
    if (route === '/api/setup/task') return send(response, 200, await tasks.start(String(body.task), { confirm: body.confirm === true }));
    // The WhatsApp page: each button is one fixed action; only a phone number's digits are passed on.
    if (route === '/api/setup/whatsapp') {
      const action = String(body.action ?? '');
      if (action === 'link') return send(response, 200, await whatsapp.link());
      if (action === 'stop') return send(response, 200, await whatsapp.stop({ disable: true }));
      if (action === 'unlink') {
        if (body.confirm !== true) throw Object.assign(new Error('Unlinking needs a clear yes first.'), { status: 400 });
        return send(response, 200, await whatsapp.unlink());
      }
      if (action === 'install') return send(response, 200, await whatsapp.install());
      if (action === 'pair') return send(response, 200, await whatsapp.pairingCode(body.phone));
      if (action === 'check') { await whatsapp.findNode({ fresh: true }); return send(response, 200, await whatsapp.overview()); }
      throw Object.assign(new Error('There is no such action.'), { status: 400 });
    }
    return send(response, 404, 'Not found.');
  }

  async function saveSettings(input) {
    if (!config.configFile) throw new SettingsError('Settings are switched off for this copy, so nothing can be saved.', null, 409);
    const { changes, secrets: keys } = await validateSettings(input, {
      voices: input?.voice?.tts !== undefined ? await listVoices() : [],
      canStoreSecrets: secrets.canStore,
      claudeFound: input?.brain?.engine === 'claude-cli' ? Boolean(await findCommand('claude')) : false,
      exists: probe.fileExists,
    });
    await writeSettingsFile(config.configFile, changes);
    for (const [name, value] of Object.entries(keys)) {
      if (value === null) await secrets.remove(name);
      else await secrets.set(name, value);
    }
    firstRun = false;

    // Apply what can be applied right away: the name, the voice, the brain and the dancer tools.
    // The name still comes from CINCO_ID_OPERATOR while that is set.
    const fresh = await loadConfig(rootDir, overrides, { dataDir: config.dataDir });
    const restart = [];
    config.operator = fresh.operator;
    computer.operator = fresh.operator;
    if (changes.voice?.tts) {
      Object.assign(config.voice.tts, changes.voice.tts);
      const { engine, voice } = changes.voice.tts;
      const chosen = await speaker.use({ engine, name: engine === 'voder' ? 'Robot' : engine === 'browser' ? 'Browser' : voice });
      computer.voiceChoice = chosen;
      await computer.persist().catch(() => {});
      computer.send({ type: 'quiet' });
    }
    if (changes.brain || 'brain' in keys) {
      config.brain = { ...config.brain, ...(changes.brain ?? {}) };
      if (parts.brain === undefined) computer.brain = makeBrain();
    }
    if (changes.media) {
      config.media = { ...config.media, ...changes.media };
      if (parts.generator === undefined) computer.generator = makeGenerator();
    }
    if (changes.voice?.stt) savedEars = { ...savedEars, ...changes.voice.stt };
    if (JSON.stringify(savedEars) !== runningEars) restart.push('listening');
    broadcast({ type: 'settings.changed', operator: computer.operator, voice: voiceInfo(), setup: { firstRun } });
    if (input?.announce !== false && (Object.keys(changes).length || Object.keys(keys).length)) computer.say('settingsSaved');
    return {
      ok: true,
      restart,
      operator: computer.operator,
      operatorFromEnv: fresh.fromEnv.includes('operator'),
      settings: shownAfterSave(),
    };
  }

  function shownAfterSave() {
    return publicSettings({ ...config, voice: { ...config.voice, stt: savedEars } }, { secrets, env, speaker, firstRun });
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://127.0.0.1').pathname !== '/ws' || fromElsewhere(request)) return socket.destroy();
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client));
  });
  wss.on('connection', socket => {
    sockets.add(socket);
    socket.send(JSON.stringify(screenState()));
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', async raw => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      try {
        if (message.type === 'command') await computer.hear(message.text, { source: message.source ?? 'typed' });
        else if (message.type === 'hello') computer.greet();
        else if (message.type === 'window.closed') computer.windowClosed(message.id);
        else if (message.type === 'dialog.answer') await computer.dialogAnswer(message.dialogId, message.button);
        else if (message.type === 'call.decline') await computer.declineCall(message.callId);
        else if (message.type === 'call.accept') computer.acceptCall();
      } catch (error) {
        broadcast({ type: 'note', level: 'error', text: error.message });
      }
    });
  });

  return {
    config, computer, library, server, speaker, listener, connectors, notes, guestToken, seeded, secrets, tasks, whatsapp,
    get firstRun() { return firstRun; },
    async listen() {
      const tryPort = wanted => new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', done); reject(error); };
        const done = () => { server.off('error', failed); resolve(); };
        server.once('error', failed);
        server.once('listening', done);
        server.listen(wanted, '127.0.0.1');
      });
      try {
        await tryPort(config.port);
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || !config.port) throw error;
        // Another program has the usual port: take a free one rather than not starting at all.
        await tryPort(0);
        notes.push(`Port ${config.port} is used by another program, so this copy uses port ${server.address().port}. `
          + `Outside events such as WhatsApp calls are sent to port ${config.port} and will not arrive here until that port is free and CINCO ID is restarted.`);
      }
      port = server.address().port;
      // WhatsApp was linked before: start CINCO ID's own connector again, with the real port.
      if (whatsapp.enabled) {
        whatsapp.start().then(view => {
          if (view.state === 'problem') computer.send({ type: 'note', level: 'error', text: `WhatsApp: ${view.text}` });
        }).catch(error => computer.problem(`WhatsApp could not start: ${error.message}`));
      }
      listener.warm();
      speaker.warm(['yes', 'ok', 'added', 'printing', 'betaOffer', 'notComputing', 'gateConfirm', 'generating', 'cleared', 'closed']
        .map(key => computer.fill(computer.phrases[key])));
      return port;
    },
    get port() { return port; },
    async close() {
      for (const socket of sockets) socket.terminate();
      tasks.stopAll();
      computer.generator?.stop?.();
      speaker.stop();
      listener.stop();
      await whatsapp.close().catch(() => {});
      await connectors.stop?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
