import http from 'node:http';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handleMcp } from './mcp-endpoint.js';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { Library } from './projects.js';
import { Computer } from './computer.js';
import { createBrain } from './brain.js';
import { Connectors } from './connectors.js';
import { Generator } from './generator.js';
import { Speaker, Listener } from './voice/voice.js';
import { verify, routeWhatsApp } from './events/webhook.js';

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
export async function createApp({ rootDir, overrides = {}, env = process.env, parts = {} } = {}) {
  const config = await loadConfig(rootDir, overrides);
  const library = await new Library(config.projectsDir).reload();
  const notes = [];
  const connectors = parts.connectors ?? await new Connectors(config.mcpServers, {
    declineTool: config.events.whatsapp.declineTool,
    onProblem: text => notes.push(text),
  }).start();
  let port = config.port;
  // Two keys to the /mcp door: one for the computer's own brain (new on every start), and one
  // for outside agents you connect yourself (kept in the state folder so it stays the same).
  const brainToken = randomBytes(24).toString('hex');
  const guestToken = config.mcp?.token ?? await keptToken(path.join(config.stateDir, 'mcp-token'));
  const computer = new Computer({
    library,
    config,
    stateFile: path.join(config.stateDir, 'state.json'),
    brain: parts.brain !== undefined ? parts.brain : createBrain(config.brain, env, {
      workDir: path.join(config.stateDir, 'brain'),
      mcpUrl: () => `http://127.0.0.1:${port}/mcp`,
      token: brainToken,
    }),
    generator: parts.generator !== undefined ? parts.generator : Generator.create(config.media),
    connectors,
  });
  await computer.restore();
  const speaker = parts.speaker ?? new Speaker(config.voice.tts, path.join(rootDir, '.cache', 'tts'));
  const listener = parts.listener ?? new Listener(config.voice.stt);

  const sockets = new Set();
  const broadcast = action => {
    const text = JSON.stringify(action);
    for (const socket of sockets) if (socket.readyState === 1) socket.send(text);
  };
  computer.on('action', broadcast);

  const ownOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
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
    if (config.printouts.printer && process.platform === 'win32') {
      spawn('mspaint.exe', ['/pt', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    return file;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const route = decodeURIComponent(url.pathname);

      // Signed events from outside programs (WhatsApp calls and messages).
      if (request.method === 'POST' && route === '/hooks/whatsapp') {
        const body = (await readBody(request, 1024 * 1024)).toString('utf8');
        if (!verify({ secret: config.events.whatsapp.secret, headers: request.headers, body })) return send(response, 401, 'Bad signature.');
        const outcome = routeWhatsApp(JSON.parse(body), computer, config.events.whatsapp);
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

      if (request.method === 'GET') {
        if (route === '/' || route === '/index.html') return serveFile(response, UI_DIR, 'index.html');
        if (route.startsWith('/ui/')) return serveFile(response, UI_DIR, route.slice(4));
        if (route.startsWith('/projects/')) return serveFile(response, config.projectsDir, route.slice(10), { mediaOnly: true });
        if (route.startsWith('/printouts/')) return serveFile(response, config.printouts.dir, route.slice(11), { mediaOnly: true });
        if (route === '/api/state') return send(response, 200, { ...computer.snapshot(), voice: voiceInfo(), notes });
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
          const file = await savePrintout(JSON.parse((await readBody(request)).toString('utf8')));
          return send(response, 200, { ok: true, file, url: `/printouts/${path.basename(file)}` });
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

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://127.0.0.1').pathname !== '/ws' || fromElsewhere(request)) return socket.destroy();
    wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client));
  });
  wss.on('connection', socket => {
    sockets.add(socket);
    socket.send(JSON.stringify({ ...computer.snapshot(), voice: voiceInfo(), notes }));
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
      } catch (error) {
        broadcast({ type: 'note', level: 'error', text: error.message });
      }
    });
  });

  return {
    config, computer, library, server, speaker, listener, connectors, notes, guestToken,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', resolve);
      });
      port = server.address().port;
      listener.warm();
      speaker.warm(['yes', 'ok', 'added', 'printing', 'betaOffer', 'notComputing', 'gateConfirm', 'generating', 'cleared', 'closed']
        .map(key => computer.fill(computer.phrases[key])));
      return port;
    },
    get port() { return port; },
    async close() {
      for (const socket of sockets) socket.terminate();
      speaker.stop();
      listener.stop();
      await connectors.stop?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
