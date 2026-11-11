import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/app.js';
import { validateSettings, checkPython } from '../src/server/settings.js';
import { Brain } from '../src/server/brain.js';
import { standInCipher, standInSpawn } from './helpers/stand-ins.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['CINCO_ID_CONFIG', 'CINCO_ID_DATA_DIR', 'CINCO_ID_STATE_DIR', 'CINCO_ID_PROJECTS_DIR', 'CINCO_ID_PRINTOUTS_DIR', 'CINCO_ID_OPERATOR', 'CINCO_ID_NO_SETUP']) {
  delete process.env[name];
}

const BRAIN_KEY = 'sk-brain-SECRET-1234567890';
const ROUTER_KEY = 'sk-or-SECRET-0987654321';
const VOICES = [{ engine: 'windows', name: 'Microsoft Zira Desktop', language: 'en-US' }, { engine: 'windows', name: 'Microsoft David Desktop', language: 'en-US' }];

async function start({ cipher = standInCipher(), files = {}, overrides = {}, env = {}, parts = {} } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-settings-'));
  const data = path.join(temp, 'data');
  await fs.mkdir(data, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(data, name), content);
  const python = path.join(temp, 'venv', 'python.exe');
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, '');
  const app = await createApp({
    rootDir, dataDir: data, env: { ...env },
    overrides: { port: 0, voice: { tts: { engine: 'browser' }, stt: { engine: 'off' } }, ...overrides },
    parts: {
      connectors: { tools: () => [], stop: async () => {} },
      secretCipher: cipher,
      probe: {
        listVoices: async () => VOICES,
        findCommand: async name => (name === 'claude' ? 'C:\\tools\\claude.exe' : null),
        checkEars: async () => ({ ok: true, message: 'stand-in ears' }),
        home: temp,
        env: {},
      },
      ...parts,
    },
  });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { await app.close(); await fs.rm(temp, { recursive: true, force: true }); };
  return { app, base, port, temp, data, python, stop };
}

const post = (base, route, body, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** A raw request with a chosen Host header (fetch does not allow changing it). */
function rawGet(port, route, host) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { host } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
}

test('the checks refuse what does not belong in the settings', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-check-'));
  try {
    const python = path.join(temp, 'python.exe');
    await fs.writeFile(python, '');
    const context = { voices: VOICES, canStoreSecrets: true, claudeFound: false };
    const fails = async (input, field) => {
      await assert.rejects(validateSettings(input, context), error => error.field === field, JSON.stringify(input));
    };
    await fails({ operator: '' }, 'operator');
    await fails({ operator: 'x'.repeat(41) }, 'operator');
    await fails({ operator: 'Paul; rm -rf /' }, 'operator');
    await fails({ voice: { tts: { engine: 'windows', voice: 'Microsoft Sam' } } }, 'voice');
    await fails({ voice: { tts: { engine: 'voder' } } }, 'voice');
    await fails({ voice: { stt: { engine: 'whisper', python: 'python' } } }, 'earsPython');
    await fails({ voice: { stt: { engine: 'whisper', python: 'C:\\Windows\\System32\\cmd.exe' } } }, 'earsPython');
    await fails({ voice: { stt: { engine: 'whisper', python: path.join(temp, 'missing', 'python.exe') } } }, 'earsPython');
    await fails({ voice: { stt: { engine: 'whisper', python, model: 'large-v3 & calc' } } }, 'earsModel');
    await fails({ brain: { engine: 'claude-cli' } }, 'brain');
    await fails({ brain: { engine: 'api', baseUrl: 'file:///C:/x', model: 'm' } }, 'brainUrl');
    await fails({ brain: { engine: 'api', baseUrl: 'https://user:pw@example.com/v1', model: 'm' } }, 'brainUrl');
    await fails({ brain: { engine: 'api', baseUrl: 'https://api.openai.com/v1', model: '' } }, 'brainModel');
    await fails({ media: { python: 'C:\\Windows\\System32\\cmd.exe' } }, 'mediaPython');
    await fails({ secrets: { brain: 'has spaces in it' } }, 'brainKey');
    await assert.rejects(validateSettings({ secrets: { brain: BRAIN_KEY } }, { ...context, canStoreSecrets: false }), error => error.status === 409 && !error.message.includes(BRAIN_KEY));

    const ok = await validateSettings({
      operator: ' Anna ', voice: { tts: { engine: 'windows', voice: 'Microsoft Zira Desktop' }, stt: { engine: 'whisper', python, model: 'small', device: 'cpu' } },
      brain: { engine: 'api', baseUrl: 'https://openrouter.ai/api/v1/', model: 'some/model', apiKeyEnv: 'OPENROUTER_API_KEY' },
      media: { python: 'python' }, secrets: { brain: BRAIN_KEY, openrouter: null },
    }, context);
    assert.equal(ok.changes.operator, 'Anna');
    assert.deepEqual(ok.changes.voice.stt, { engine: 'whisper', python, model: 'small', device: 'cpu', computeType: 'int8' });
    assert.equal(ok.changes.brain.baseUrl, 'https://openrouter.ai/api/v1');
    assert.deepEqual(ok.secrets, { brain: BRAIN_KEY, openrouter: null });
    assert.ok(!JSON.stringify(ok.changes).includes('SECRET'), 'keys never go into the settings changes');
    assert.equal(await checkPython(`"${python}"`), python);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('the settings service saves to the settings file, keeps the rest of it, and never hands keys back', async () => {
  const existing = { mcpServers: { mail: { command: 'npx', args: ['x'] } }, events: { whatsapp: { secret: 'whsec_keepme' } }, maxWindows: 50 };
  const { app, base, data, python, stop } = await start({ files: { 'harness.config.json': JSON.stringify(existing) } });
  try {
    const before = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(before.firstRun, false, 'a settings file exists, so this is not a first start');
    assert.equal(before.canStoreSecrets, true);
    assert.deepEqual(before.secrets.brain, { set: false, source: null, envName: 'OPENAI_API_KEY' });

    const saved = await post(base, '/api/settings', {
      operator: 'Anna',
      voice: { tts: { engine: 'windows', voice: 'Microsoft Zira Desktop' }, stt: { engine: 'whisper', python, model: 'small', device: 'cuda' } },
      brain: { engine: 'api', baseUrl: 'https://api.openai.com/v1', model: 'test-model', apiKeyEnv: 'OPENAI_API_KEY' },
      secrets: { brain: BRAIN_KEY, openrouter: ROUTER_KEY },
    });
    assert.equal(saved.status, 200);
    const answer = await saved.text();
    assert.ok(!answer.includes(BRAIN_KEY) && !answer.includes(ROUTER_KEY), 'the answer holds no key');
    const result = JSON.parse(answer);
    assert.deepEqual(result.restart, ['listening'], 'the ears need a restart and say so');
    assert.equal(result.settings.secrets.brain.set, true);
    assert.equal(result.settings.secrets.brain.source, 'stored');

    const file = JSON.parse(await fs.readFile(path.join(data, 'harness.config.json'), 'utf8'));
    assert.equal(file.operator, 'Anna');
    assert.deepEqual(file.mcpServers, existing.mcpServers, 'outside tools stay as they were');
    assert.equal(file.events.whatsapp.secret, 'whsec_keepme');
    assert.equal(file.maxWindows, 50);
    assert.equal(file.voice.tts.voice, 'Microsoft Zira Desktop');
    const everything = await fs.readFile(path.join(data, 'harness.config.json'), 'utf8') + await fs.readFile(path.join(data, '.local', 'secrets.json'), 'utf8');
    assert.ok(!everything.includes(BRAIN_KEY) && !everything.includes(ROUTER_KEY), 'no key in plain text anywhere on disk');

    const after = await (await fetch(`${base}/api/settings`)).text();
    assert.ok(!after.includes(BRAIN_KEY) && !after.includes(ROUTER_KEY));
    assert.equal(JSON.parse(after).voice.stt.engine, 'whisper');

    // Applied right away: the name, the voice and the brain (with the stored key first).
    assert.equal(app.computer.operator, 'Anna');
    assert.equal(app.speaker.engine, 'windows');
    assert.equal(app.speaker.voice, 'Microsoft Zira Desktop');
    assert.ok(app.computer.brain instanceof Brain);
    assert.equal(app.computer.brain.apiKey, BRAIN_KEY);
    assert.equal(app.computer.log.at(-1).text, 'Settings saved, Anna.');
    app.computer.greeted = false;
    app.computer.greet();
    assert.match(app.computer.log.at(-1).text, /^Good \w+, Anna\./);

    // Removing a key, keeping the other.
    await post(base, '/api/settings', { secrets: { brain: null } });
    const removed = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(removed.secrets.brain.set, false);
    assert.equal(removed.secrets.openrouter.source, 'stored');

    // A bad value is refused in plain words and nothing changes.
    const bad = await post(base, '/api/settings', { operator: '', brain: { engine: 'none' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).field, 'operator');
    assert.equal(JSON.parse(await fs.readFile(path.join(data, 'harness.config.json'), 'utf8')).brain.engine, 'api');
  } finally { await stop(); }
});

test('other websites cannot read or change the settings, or start anything', async () => {
  const { base, port, data, stop } = await start();
  try {
    const evil = { origin: 'https://evil.example' };
    assert.equal((await fetch(`${base}/api/settings`, { headers: evil })).status, 403);
    assert.equal((await fetch(`${base}/api/settings`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await post(base, '/api/settings', { operator: 'Mallory' }, evil)).status, 403);
    assert.equal((await post(base, '/api/setup/task', { task: 'modal-login' }, evil)).status, 403);
    assert.equal((await fetch(`${base}/api/setup/status`, { headers: evil })).status, 403);
    // A page that reaches this port under another name (DNS rebinding) is refused too.
    assert.equal(await rawGet(port, '/api/settings', `evil.example:${port}`), 403);
    assert.equal(await rawGet(port, '/api/settings', `127.0.0.1:${port}`), 200);
    await assert.rejects(fs.access(path.join(data, 'harness.config.json')), 'nothing was written');
  } finally { await stop(); }
});

test('the first start opens Setup by itself; a test switch or a saved file stops that', async () => {
  const first = await start();
  try {
    const state = await (await fetch(`${first.base}/api/state`)).json();
    assert.equal(state.setup.firstRun, true);
    await post(first.base, '/api/settings', { announce: false });
    assert.equal(first.app.firstRun, false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(first.data, 'harness.config.json'), 'utf8')), {});
    assert.ok(!first.app.computer.log.some(line => /Settings saved/.test(line.text)), 'closing Setup without changes says nothing');
  } finally { await first.stop(); }

  const switched = await start({ overrides: { setup: { onFirstStart: false } } });
  try {
    assert.equal((await (await fetch(`${switched.base}/api/state`)).json()).setup.firstRun, false);
  } finally { await switched.stop(); }

  process.env.CINCO_ID_NO_SETUP = '1';
  const byEnv = await start();
  try {
    assert.equal(byEnv.app.firstRun, false);
  } finally { delete process.env.CINCO_ID_NO_SETUP; await byEnv.stop(); }
});

test('with settings switched off (CINCO_ID_CONFIG=none) nothing is saved; without encryption no key is stored', async () => {
  process.env.CINCO_ID_CONFIG = 'none';
  const off = await start();
  try {
    assert.equal(off.app.firstRun, false);
    const refused = await post(off.base, '/api/settings', { operator: 'Anna' });
    assert.equal(refused.status, 409);
  } finally { delete process.env.CINCO_ID_CONFIG; await off.stop(); }

  const plain = await start({ cipher: null, env: { OPENAI_API_KEY: 'env-key-123456' } });
  try {
    const shown = await (await fetch(`${plain.base}/api/settings`)).json();
    assert.equal(shown.canStoreSecrets, false);
    assert.deepEqual(shown.secrets.brain, { set: true, source: 'environment', envName: 'OPENAI_API_KEY' });
    const refused = await post(plain.base, '/api/settings', { secrets: { brain: BRAIN_KEY } });
    assert.equal(refused.status, 409);
    assert.ok(!(await refused.text()).includes(BRAIN_KEY));
    // The brain falls back to the environment variable.
    await post(plain.base, '/api/settings', { brain: { engine: 'api', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKeyEnv: 'OPENAI_API_KEY' } });
    assert.equal(plain.app.computer.brain.apiKey, 'env-key-123456');
  } finally { await plain.stop(); }
});

test('the dancer generator gets the stored OpenRouter key in its environment, never on its command line', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-genkey-'));
  const fake = path.join(temp, 'fake-generate.mjs');
  await fs.writeFile(fake, `
    const key = process.env.OPENROUTER_API_KEY ?? '';
    console.log(JSON.stringify({ done: true, hasKey: key.length > 0, keyInArgs: process.argv.some(arg => key && arg.includes(key)) }));
  `);
  const { app, base, stop } = await start({ overrides: { media: { python: process.execPath, script: fake } } });
  try {
    await post(base, '/api/settings', { secrets: { openrouter: ROUTER_KEY } });
    const result = await app.computer.generator.run({ name: 'X', prompt: 'x', out: temp });
    assert.equal(result.hasKey, true);
    assert.equal(result.keyInArgs, false);
  } finally {
    await stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('the Sign in to Modal and Prepare buttons start only the fixed programs, Prepare only after a yes', async () => {
  const { spawn, started } = standInSpawn(({ args }) => (args.includes('--prepare')
    ? { lines: ['{"stage":"setup","progress":0.5,"message":"Downloading the drawing tools"}', '{"done":true,"costUsdEstimate":0.1}'] }
    : { lines: ['\x1b[32mWeb authentication finished successfully!\x1b[0m'] }));
  const { base, python, stop } = await start({ parts: { spawn } });
  try {
    await post(base, '/api/settings', { media: { python } });
    const refused = await post(base, '/api/setup/task', { task: 'prepare' });
    assert.equal(refused.status, 400, 'no yes, no prepare');
    assert.equal(started.length, 0);
    assert.equal((await post(base, '/api/setup/task', { task: 'calc.exe' })).status, 400);

    assert.equal((await post(base, '/api/setup/task', { task: 'modal-login' })).status, 200);
    assert.equal(started[0].command, python);
    assert.deepEqual(started[0].args, ['-m', 'modal', 'setup']);
    await new Promise(resolve => setTimeout(resolve, 80));
    const login = await (await fetch(`${base}/api/setup/task?name=modal-login`)).json();
    assert.equal(login.ok, true);
    assert.deepEqual(login.lines, ['Web authentication finished successfully!']);

    assert.equal((await post(base, '/api/setup/task', { task: 'prepare', confirm: true })).status, 200);
    assert.equal(started[1].command, python);
    assert.deepEqual(started[1].args, [path.join(rootDir, 'tools', 'media', 'generate.py'), '--prepare']);
    await new Promise(resolve => setTimeout(resolve, 80));
    const prepared = await (await fetch(`${base}/api/setup/task?name=prepare`)).json();
    assert.equal(prepared.ok, true);
    assert.equal(prepared.progress, 0.5);

  } finally { await stop(); }
});

test('before Prepare, the plan comes from the dancer tools\' own dry run, with the guide as fallback', async () => {
  const asked = [];
  let answer = { code: 0, stdout: 'some line\n{"dryRun": true, "prepare": {"downloads": ["LTX-2.5"], "alreadyReady": [], "downloadGb": 80, "minutes": 12, "usdEstimate": 0.07, "summary": "downloads LTX-2.5", "ltxSignIn": "Accept the licence on Hugging Face first."}, "danceModelNow": "Wan2.2", "why": "LTX-2.5 is not downloaded yet."}\n', stderr: '' };
  const run = async (command, args) => { asked.push({ command, args }); return answer; };
  const { base, python, stop } = await start({ parts: { probe: { listVoices: async () => VOICES, findCommand: async () => null, home: os.tmpdir(), env: {}, run } } });
  try {
    await post(base, '/api/settings', { media: { python } });
    const plan = await (await fetch(`${base}/api/setup/prepare-info`)).json();
    assert.deepEqual(asked[0], { command: python, args: [path.join(rootDir, 'tools', 'media', 'generate.py'), '--prepare', '--dry-run'] });
    assert.equal(plan.fromTools, true);
    assert.equal(plan.size, '80 GB');
    assert.equal(plan.time, '12 minutes');
    assert.equal(plan.cost, '$0.07');
    assert.equal(plan.summary, 'downloads LTX-2.5');
    assert.equal(plan.ltxSignIn, 'Accept the licence on Hugging Face first.');
    assert.equal(plan.danceModelNow, 'Wan2.2');
    assert.equal(plan.why, 'LTX-2.5 is not downloaded yet.');

    // The tools cannot answer: the numbers from the guide, said plainly where they come from.
    answer = { code: 1, stdout: '{"error": "Could not reach the cloud computer service."}\n', stderr: '' };
    const fallback = await (await fetch(`${base}/api/setup/prepare-info`)).json();
    assert.equal(fallback.fromTools, false);
    assert.equal(fallback.reason, 'Could not reach the cloud computer service.');
    assert.equal(fallback.source, 'docs/MEDIA.md');
  } finally { await stop(); }
});
