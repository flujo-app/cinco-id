import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/app.js';
import { sign } from '../src/server/events/webhook.js';
import { parseCommand } from '../src/server/commands.js';
import { CONNECTOR, WhatsAppLink, compareVersions, installSource, readConnectorFolder } from '../src/server/whatsapp.js';
import { standInCipher } from './helpers/stand-ins.js';
import { alive, readRecord, signal, standInConnector, waitFor } from './helpers/whatsapp.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['CINCO_ID_CONFIG', 'CINCO_ID_DATA_DIR', 'CINCO_ID_STATE_DIR', 'CINCO_ID_PROJECTS_DIR', 'CINCO_ID_PRINTOUTS_DIR', 'CINCO_ID_OPERATOR', 'CINCO_ID_PORT']) {
  delete process.env[name];
}
const MANUAL_SECRET = `whsec_${Buffer.from('a-manual-secret-that-is-long-enough!').toString('base64')}`;
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-whatsapp-'));

/** An app with its own data folder and the stand-in connector named in its settings. */
async function start({ version = null, overrides = {}, parts = {}, settings = {} } = {}) {
  const dir = await temp();
  const data = path.join(dir, 'data');
  const connector = await standInConnector(path.join(dir, 'connector'), { version });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(data, 'harness.config.json'), JSON.stringify({ operator: 'Paul', ...settings }, null, 2));
  const actions = [];
  const app = await createApp({
    rootDir, dataDir: data,
    overrides: {
      port: 0, voice: { tts: { engine: 'browser' }, stt: { engine: 'off' } }, setup: { onFirstStart: false },
      whatsapp: { connectorDir: connector, lookNextDoor: false },
      ...overrides,
    },
    parts: {
      brain: null, generator: null, secretCipher: standInCipher(), connectorRetryMs: [300],
      whatsappOptions: { pollMs: { waiting: 80, linked: 150 }, dropNoticeMs: 300 },
      ...parts,
    },
  });
  app.computer.on('action', action => actions.push(action));
  const port = await app.listen();
  const work = path.join(data, 'whatsapp');
  const notes = () => actions.filter(action => action.type === 'note').map(action => action.text);
  const stop = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };
  return { app, dir, data, work, connector, port, base: `http://127.0.0.1:${port}`, actions, notes, stop };
}

const started = work => waitFor(() => readRecord(work, 'stand-in-started.json'), { what: 'the stand-in to start' });
const inState = (app, state) => waitFor(() => app.whatsapp.state === state, { what: `the state "${state}"` });

test('the own connector gets exactly the right environment, and the brain only the two safe tools', async () => {
  const leaks = { MCP_HTTP_PORT: '4321', WHATSAPP_WEBHOOK_CHAT_IDS: '123@s.whatsapp.net', BAILEYS_SESSION_DIR: 'C:\\somewhere-else', TRANSPORT: 'http', OPENAI_API_KEY: 'sk-must-not-travel' };
  Object.assign(process.env, leaks);
  const run = await start();
  try {
    await run.app.whatsapp.link();
    const record = await started(run.work);
    assert.equal(record.cwd, run.work, 'it runs in the data folder, so its log lands there');
    assert.equal(record.env.BAILEYS_SESSION_DIR, path.join(run.data, 'whatsapp', 'session'), 'its own sign-in folder inside the data folder');
    assert.equal(record.env.WHATSAPP_BACKEND, 'baileys');
    assert.equal(record.env.WHATSAPP_WEBHOOK_URL, `http://127.0.0.1:${run.port}/hooks/whatsapp`, 'the real port');
    assert.equal(record.env.WHATSAPP_WEBHOOK_EVENTS, 'call.received,call.ended', 'only the two call events');
    assert.equal(record.secretLooksRight, true, 'whsec_ plus the base64 of 24 to 64 random bytes');
    for (const name of ['MCP_HTTP_PORT', 'WHATSAPP_WEBHOOK_CHAT_IDS', 'TRANSPORT', 'OPENAI_API_KEY']) assert.equal(record.env[name], undefined, `${name} is not handed on`);
    assert.equal(path.normalize(record.argv.at(-1)), path.join(run.connector, 'dist', 'index.js'));

    const file = JSON.parse(await fs.readFile(path.join(run.data, 'harness.config.json'), 'utf8'));
    assert.equal(file.whatsapp.enabled, true, 'Link is remembered for the next start');
    const sealed = await fs.readFile(path.join(run.data, '.local', 'secrets.json'), 'utf8');
    const secret = await fs.readFile(path.join(run.work, 'stand-in-secret.txt'), 'utf8');
    assert.ok(JSON.parse(sealed).keys.whatsapp, 'the secret is kept encrypted');
    assert.ok(!sealed.includes(secret) && !JSON.stringify(file).includes(secret), 'and never in readable form');

    await waitFor(() => run.app.connectors.tools().length, { what: 'the tools' });
    const forBrain = run.app.connectors.tools();
    assert.deepEqual(forBrain.map(tool => tool.tool).sort(), ['get_contact_by_id', 'search_contacts']);
    assert.ok(forBrain.every(tool => tool.readOnly), 'both may be used without asking');
    assert.equal(run.app.connectors.canDeclineCalls('own'), true, 'Decline is connected');
  } finally {
    for (const name of Object.keys(leaks)) delete process.env[name];
    await run.stop();
  }
});

test('a setting can widen what the brain may use, but the link itself stays off limits', async () => {
  const run = await start({ overrides: { whatsapp: { connectorDir: null, lookNextDoor: false, brainTools: ['search_contacts', 'send_message', 'logout'] } } });
  try {
    run.app.config.whatsapp.connectorDir = run.connector;
    await run.app.whatsapp.link();
    await waitFor(() => run.app.connectors.tools().length, { what: 'the tools' });
    const forBrain = run.app.connectors.tools();
    assert.deepEqual(forBrain.map(tool => tool.tool).sort(), ['search_contacts', 'send_message']);
    assert.equal(forBrain.find(tool => tool.tool === 'send_message').readOnly, false, 'sending a message asks first');
  } finally { await run.stop(); }
});

test('Link, QR code, pairing code, linked by itself, a call, Decline, drop and back, Unlink', async () => {
  const run = await start();
  try {
    await run.app.whatsapp.link();
    await inState(run.app, 'waiting_for_link');
    const picture = await run.app.whatsapp.qr();
    assert.match(picture, /^data:image\/png;base64,/);
    assert.deepEqual([...Buffer.from(picture.split(',')[1], 'base64').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a real PNG');
    const page = await (await fetch(`${run.base}/api/setup/whatsapp?qr=1`)).json();
    assert.equal(page.qr?.startsWith('data:image/png;base64,'), true, 'the Setup page gets the code');
    assert.equal(page.program.version, '1.4.2');
    assert.equal(page.node.ok, true);

    // The second way: only the digits reach the connector; anything else is refused.
    const pairing = await run.app.whatsapp.pairingCode('+49 151 1234-5678');
    assert.equal(pairing.code, 'ABCD-EF12');
    assert.deepEqual(await readRecord(run.work, 'stand-in-pairing.json'), [{ phone: '4915112345678' }]);
    await assert.rejects(run.app.whatsapp.pairingCode('4915112345678 & calc'), /country code, digits only/);

    // The phone scans the code: it switches to linked by itself and says so once.
    await signal(path.join(run.work, 'session'), 'scan');
    await inState(run.app, 'linked');
    await waitFor(() => run.notes().includes('WhatsApp is linked. Incoming calls show up here.'), { what: 'the linked note' });
    assert.equal(await run.app.whatsapp.qr(), null, 'no code once linked');

    // A call arrives through the address it was given, signed with the kept secret.
    await signal(run.work, 'ring.json', { callId: 'CALL-OWN-1', name: 'Anna Example', number: '15550100123' });
    const window = await waitFor(() => [...run.app.computer.windows.values()].find(open => open.kind === 'call'), { what: 'the call window' });
    assert.equal(window.call.caller, 'Anna Example');
    assert.equal(window.call.via, 'own');
    assert.equal(window.canDecline, true);
    await run.app.computer.declineCall('CALL-OWN-1');
    assert.deepEqual(await readRecord(run.work, 'stand-in-rejected.json'), [{ callId: 'CALL-OWN-1' }], 'Decline reached the connector');
    assert.ok(![...run.app.computer.windows.values()].some(open => open.kind === 'call'));

    // The connection drops for a while and comes back: one plain line each, nothing more.
    await signal(run.work, 'drop');
    await waitFor(() => run.notes().some(note => /lost its connection/.test(note)), { what: 'the dropped note' });
    await fs.rm(path.join(run.work, 'drop'));
    await waitFor(() => run.notes().includes('WhatsApp is connected again.'), { what: 'the back again note' });
    assert.equal(run.notes().filter(note => /lost its connection/.test(note)).length, 1);

    // Unlink: the connector signs out, stops, and it stays off.
    const refused = await fetch(`${run.base}/api/setup/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'unlink' }) });
    assert.equal(refused.status, 400, 'Unlink needs a clear yes');
    const unlinked = await (await fetch(`${run.base}/api/setup/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'unlink', confirm: true }) })).json();
    assert.equal(unlinked.running, false);
    assert.equal((await readRecord(run.work, 'stand-in-logouts.json')).length, 1);
    await waitFor(() => readRecord(run.work, 'stand-in-stopped.json'), { what: 'the stand-in to stop' });
    const file = JSON.parse(await fs.readFile(path.join(run.data, 'harness.config.json'), 'utf8'));
    assert.equal(file.whatsapp.enabled, false);
    assert.ok(!run.notes().some(note => /no longer linked/.test(note)), 'unlinking on purpose is not reported as a lost link');
    assert.equal(run.app.connectors.canDeclineCalls('own'), false);
  } finally { await run.stop(); }
});

test('the next start links again by itself, and a crash is followed by a restart after a pause; quitting stops it cleanly', async () => {
  const run = await start({ settings: { whatsapp: { enabled: true } } });
  try {
    const first = await started(run.work);
    await signal(path.join(run.work, 'session'), 'scan');
    await inState(run.app, 'linked');
    await fs.rm(path.join(run.work, 'stand-in-started.json'));
    await signal(run.work, 'crash');
    await waitFor(() => run.notes().some(note => /^The WhatsApp helper stopped\. It is started again in 1 second\.$/.test(note)), { what: 'the restart note' });
    assert.equal(run.app.connectors.canDeclineCalls('own'), false, 'no Decline while it is down');
    const second = await started(run.work);
    assert.notEqual(second.pid, first.pid, 'a new program was started');
    assert.ok(!alive(first.pid), 'the old one is gone');
    await inState(run.app, 'linked');
    await waitFor(() => run.notes().includes('WhatsApp is connected again.'), { what: 'the back note' });
    await waitFor(() => run.app.connectors.canDeclineCalls('own'), { what: 'Decline to come back' });

    await run.app.close();
    const stopped = await readRecord(run.work, 'stand-in-stopped.json');
    assert.equal(stopped?.how, 'its input was closed', 'asked to stop, not killed');
    await waitFor(() => !alive(second.pid), { what: 'the program to end' });
  } finally { await run.stop().catch(() => {}); }
});

test('the secret never reaches the screen, the console or the log', async () => {
  const run = await start();
  try {
    const socketText = [];
    await run.app.whatsapp.link();
    await signal(path.join(run.work, 'session'), 'scan');
    await inState(run.app, 'linked');
    await signal(run.work, 'ring.json', { callId: 'CALL-S' });
    await waitFor(() => [...run.app.computer.windows.values()].some(open => open.kind === 'call'), { what: 'the call window' });
    const secret = await fs.readFile(path.join(run.work, 'stand-in-secret.txt'), 'utf8');
    assert.match(secret, /^whsec_/);
    for (const route of ['/api/state', '/api/settings', '/api/setup/whatsapp?qr=1', '/api/setup/status']) socketText.push(await (await fetch(`${run.base}${route}`)).text());
    socketText.push(JSON.stringify(run.actions), JSON.stringify(run.app.notes), JSON.stringify(run.app.whatsapp.view()));
    const logs = await fs.readdir(path.join(run.work, 'logs'));
    for (const name of logs) socketText.push(await fs.readFile(path.join(run.work, 'logs', name), 'utf8'));
    socketText.push(await fs.readFile(path.join(run.data, 'harness.config.json'), 'utf8'));
    const everything = socketText.join('\n');
    assert.ok(!everything.includes(secret), 'the secret is nowhere to be seen');
    assert.ok(!everything.includes(secret.slice(6, 30)), 'not even part of it');
  } finally { await run.stop(); }
});

test('an older connector is refused in plain words, and nothing is started', async () => {
  const run = await start({ version: '1.3.0' });
  try {
    const view = await run.app.whatsapp.link();
    assert.equal(view.state, 'problem');
    assert.match(view.text, /is version 1\.3\.0, which is too old\. CINCO ID needs version 1\.4\.2 or newer\. Press Install/);
    const page = await (await fetch(`${run.base}/api/setup/whatsapp`)).json();
    assert.equal(page.program.tooOld, true);
    assert.equal(existsSync(path.join(run.work, 'stand-in-started.json')), false);
  } finally { await run.stop(); }
});

test('without Node.js it says what to install', async () => {
  const run = await start({ parts: { whatsappProbe: { env: process.env, findCommand: async () => null } } });
  try {
    const view = await run.app.whatsapp.link();
    assert.equal(view.state, 'problem');
    assert.equal(view.text, 'Node.js is not on this PC. Install Node.js 22 or newer from nodejs.org, then press Check again.');
    const install = await fetch(`${run.base}/api/setup/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install' }) });
    assert.equal(install.status, 409);
    assert.match((await install.json()).error, /Node\.js is not on this PC/);
  } finally { await run.stop(); }
});

test('where the connector comes from: the settings, then the installed copy, then the folder next door', async () => {
  const dir = await temp();
  try {
    const appDir = path.join(dir, 'cinco-id');
    const dataDir = path.join(dir, 'data');
    const config = { appDir, dataDir, whatsapp: { connectorDir: null, lookNextDoor: true } };
    const link = new WhatsAppLink({ config, connectors: null, getPort: () => 1 });
    assert.equal((await link.locate()).found, false);
    assert.match((await link.locate()).message, /not on this PC yet\. Press Install/);
    await standInConnector(path.join(dir, 'mcp-whatsapp-web'));
    assert.equal((await link.locate()).source, 'next to the app');
    await standInConnector(path.join(dataDir, 'whatsapp', 'connector'));
    assert.equal((await link.locate()).source, 'installed');
    config.whatsapp.connectorDir = await standInConnector(path.join(dir, 'chosen'));
    assert.equal((await link.locate()).source, 'settings');
    // An old copy in the settings does not stop a good one further down the list from being used...
    config.whatsapp.connectorDir = await standInConnector(path.join(dir, 'old'), { version: '1.4.1' });
    assert.equal((await link.locate()).source, 'installed');
    // ...but when nothing usable is there, the old one is what it talks about.
    await fs.rm(path.join(dataDir, 'whatsapp', 'connector'), { recursive: true });
    config.whatsapp.lookNextDoor = false;
    const found = await link.locate();
    assert.equal(found.ok, false);
    assert.match(found.message, /version 1\.4\.1, which is too old/);
    assert.equal(compareVersions('1.10.0', '1.4.2'), 1);
    assert.equal(compareVersions('1.4.2', '1.4.2'), 0);
    assert.equal(compareVersions('1.4.1', '1.4.2'), -1);
    assert.equal((await readConnectorFolder(path.join(dir, 'nothing'))).found, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the manual setup keeps working, and Decline goes through the connection that reported the call', async () => {
  const dir = await temp();
  const manualDir = await standInConnector(path.join(dir, 'manual-connector'));
  const manualWork = path.join(dir, 'manual-work');
  await fs.mkdir(manualWork, { recursive: true });
  // The owner's own setup: a connector run "by another program", named "whatsapp" by hand.
  const run = await start({
    overrides: {
      mcpServers: { whatsapp: { command: process.execPath, args: [path.join(manualDir, 'dist', 'index.js')], cwd: manualWork, env: { BAILEYS_SESSION_DIR: path.join(manualWork, 'session') } } },
      events: { whatsapp: { secret: MANUAL_SECRET, declineTool: 'whatsapp/reject_call', messages: 'sender' } },
    },
  });
  const hook = (event, secret) => {
    const body = JSON.stringify(event);
    const id = `evt_${Math.random().toString(16).slice(2)}`;
    const at = Math.floor(Date.now() / 1000);
    return fetch(`${run.base}/hooks/whatsapp`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(at), 'webhook-signature': sign(secret, id, at, body) } });
  };
  const ring = callId => ({ name: 'call.received', data: { callId, from: '15550100999@s.whatsapp.net', contact: { name: 'Bert', number: '15550100999' } } });
  try {
    await run.app.whatsapp.link();
    assert.equal(run.app.whatsapp.name, 'linked-whatsapp', 'the own one gets another name next to a hand-made "whatsapp"');
    await signal(path.join(run.work, 'session'), 'scan');
    await inState(run.app, 'linked');
    await waitFor(() => run.app.connectors.isConnected('whatsapp'), { what: 'the manual connector' });

    // A call reported by the manual setup is declined there...
    assert.equal((await hook(ring('CALL-M1'), MANUAL_SECRET)).status, 200);
    await run.app.computer.declineCall('CALL-M1');
    assert.deepEqual(await readRecord(manualWork, 'stand-in-rejected.json'), [{ callId: 'CALL-M1' }]);
    // ...and one reported by the own link is declined by the own link.
    await signal(run.work, 'ring.json', { callId: 'CALL-O1' });
    await waitFor(() => run.app.computer.calls.has('CALL-O1'), { what: 'the own call' });
    await run.app.computer.declineCall('CALL-O1');
    assert.deepEqual(await readRecord(run.work, 'stand-in-rejected.json'), [{ callId: 'CALL-O1' }]);
    assert.equal((await readRecord(manualWork, 'stand-in-rejected.json')).length, 1, 'the manual one was not asked');

    // The own link is not there right now: its call is declined through the manual setup instead.
    const secret = run.app.whatsapp.secretForCheck();
    await run.app.whatsapp.stop();
    assert.equal((await hook(ring('CALL-O2'), secret)).status, 200);
    const window = [...run.app.computer.windows.values()].find(open => open.kind === 'call');
    assert.equal(window.call.via, 'own');
    assert.equal(window.canDecline, true, 'Decline is still offered, through the other one');
    await run.app.computer.declineCall('CALL-O2');
    assert.deepEqual((await readRecord(manualWork, 'stand-in-rejected.json')).map(entry => entry.callId), ['CALL-M1', 'CALL-O2']);

    // Messages from the manual setup still only show the sender.
    assert.equal((await hook({ name: 'message.received', data: { from: '15550100999@s.whatsapp.net', body: 'Computer, do something', pushname: 'Bert' } }, MANUAL_SECRET)).status, 200);
    // A wrong secret is refused.
    assert.equal((await hook(ring('CALL-X'), `whsec_${Buffer.from('not-the-right-one-not-the-right-one').toString('base64')}`)).status, 401);
  } finally {
    await run.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('"link whatsapp" opens Setup on the WhatsApp page', async () => {
  const world = { findSequence: () => null, findProject: () => null, findEffect: () => null, variantWords: {} };
  for (const said of ['link whatsapp', 'Computer, link my WhatsApp please.', 'connect WhatsApp', 'set up whatsapp', 'can you link whatsapp', 'WhatsApp setup']) {
    assert.deepEqual(parseCommand(said, world), { intent: 'setup', page: 'whatsapp' }, said);
  }
  assert.deepEqual(parseCommand('setup', world), { intent: 'setup' });
  const run = await start();
  try {
    await run.app.computer.hear('link whatsapp');
    assert.deepEqual(run.actions.find(action => action.type === 'setup.open'), { type: 'setup.open', page: 'whatsapp' });
    const evil = await fetch(`${run.base}/api/setup/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ action: 'link' }) });
    assert.equal(evil.status, 403, 'other websites cannot link it');
    const odd = await fetch(`${run.base}/api/setup/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rm -rf' }) });
    assert.equal(odd.status, 400);
    assert.equal(run.app.whatsapp.running, false);
  } finally { await run.stop(); }
});

test('Install fetches exactly the pinned version with fixed commands, and builds it', async () => {
  // A local "GitHub" with the stand-in in it, so this costs nothing and needs no network.
  const dir = await temp();
  const repo = path.join(dir, 'repo');
  await standInConnector(repo);
  await fs.rm(path.join(repo, 'dist'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'stand-in');
  const commit = git('rev-parse', 'HEAD');
  const started = [];
  const spawn = (command, args, options) => { started.push({ command, args, env: options.env }); return nodeSpawn(command, args, options); };
  const env = { ...process.env, CINCO_ID_WHATSAPP_INSTALL_FROM: repo, CINCO_ID_WHATSAPP_COMMIT: commit, npm_config_something: 'x' };
  const run = await start({ overrides: { whatsapp: { connectorDir: null, lookNextDoor: false } }, parts: { whatsappProbe: { env, spawn } } });
  try {
    const before = await (await fetch(`${run.base}/api/setup/whatsapp`)).json();
    assert.equal(before.program.found, false);
    assert.equal(before.git.found, true);
    const first = await (await fetch(`${run.base}/api/setup/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install' }) })).json();
    assert.equal(first.running, true);
    assert.match(first.message, /step 1 of 3/);
    const done = await waitFor(async () => { const task = run.app.whatsapp.installStatus(); return task.running ? null : task; }, { timeoutMs: 120_000, stepMs: 200, what: 'Install to finish' });
    assert.equal(done.ok, true, done.message);
    assert.equal(done.message, 'The WhatsApp connector 1.4.2 is installed.');
    const found = await run.app.whatsapp.locate();
    assert.equal(found.source, 'installed');
    assert.equal(found.dir, path.join(run.data, 'whatsapp', 'connector'));
    assert.ok(existsSync(path.join(found.dir, 'dist', 'index.js')), 'it was built');
    assert.ok(!existsSync(`${found.dir}.part`), 'nothing half-made is left');

    assert.deepEqual(started.map(entry => entry.args.slice(0, 3)), [
      ['clone', '--quiet', '--no-checkout'],
      ['-c', 'advice.detachedHead=false', 'checkout'],
      [started[2].args[0], 'ci', '--no-audit'],
    ]);
    assert.equal(started[0].args[3], repo);
    assert.equal(started[1].args.at(-1), commit, 'exactly the pinned commit');
    assert.match(started[2].args[0], /npm-cli\.js$/, 'npm is run through Node.js, never through a command shell');
    assert.equal(started[2].env.PUPPETEER_SKIP_DOWNLOAD, '1');
    assert.equal(started[2].env.npm_config_something, undefined, 'nothing from an enclosing npm run');

    // And it can be linked straight away.
    await run.app.whatsapp.link();
    await inState(run.app, 'waiting_for_link');
    assert.match(await run.app.whatsapp.qr(), /^data:image\/png/);
  } finally {
    await run.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Install only ever uses the pinned address and commit unless a test points it elsewhere', () => {
  assert.deepEqual(installSource({}), { repo: CONNECTOR.repo, commit: CONNECTOR.commit });
  assert.equal(CONNECTOR.commit.slice(0, 7), '4be9e22');
  assert.equal(CONNECTOR.repo, 'https://github.com/mario-andreschak/mcp-whatsapp-web.git');
  assert.deepEqual(installSource({ CINCO_ID_WHATSAPP_INSTALL_FROM: 'x; calc', CINCO_ID_WHATSAPP_COMMIT: 'main && calc' }), { repo: CONNECTOR.repo, commit: CONNECTOR.commit });
});
