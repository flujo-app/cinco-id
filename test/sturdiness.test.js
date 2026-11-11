import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/app.js';
import { Library } from '../src/server/projects.js';
import { Computer } from '../src/server/computer.js';
import { Generator } from '../src/server/generator.js';
import { Connectors } from '../src/server/connectors.js';
import { Speaker, voderPackage, VODER_INSTALL } from '../src/server/voice/voice.js';
import { explainStartProblem } from '../src/server/problems.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['CINCO_ID_CONFIG', 'CINCO_ID_DATA_DIR', 'CINCO_ID_STATE_DIR', 'CINCO_ID_PROJECTS_DIR', 'CINCO_ID_PRINTOUTS_DIR', 'CINCO_ID_OPERATOR', 'CINCO_ID_PORT']) {
  delete process.env[name];
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-sturdy-'));

async function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

function appOn(dataDir, port, extra = {}) {
  return createApp({
    rootDir, dataDir,
    overrides: { port, voice: { tts: { engine: 'browser' }, stt: { engine: 'off' } }, setup: { onFirstStart: false }, ...(extra.overrides ?? {}) },
    parts: { brain: null, generator: null, connectors: { tools: () => [], stop: async () => {} }, ...(extra.parts ?? {}) },
  });
}

test('a busy port does not stop the computer: it takes a free one and says what that means', async () => {
  const data = await temp();
  const port = await freePort();
  const first = await appOn(data, port);
  const second = await appOn(path.join(data, 'second'), port);
  try {
    assert.equal(await first.listen(), port);
    assert.deepEqual(first.notes, []);
    const other = await second.listen();
    assert.notEqual(other, port);
    assert.match(second.notes.at(-1), new RegExp(`Port ${port} is used by another program, so this copy uses port ${other}\\. Outside events such as WhatsApp calls`));
    const state = await (await fetch(`http://127.0.0.1:${other}/api/state`)).json();
    assert.ok(state.notes.some(note => /is used by another program/.test(note)), 'the note reaches the console window');
  } finally {
    await second.close();
    await first.close();
    await fs.rm(data, { recursive: true, force: true });
  }
});

test('half-made dancers are never offered, and are cleared away at the next start', async () => {
  const data = await temp();
  try {
    await fs.cp(path.join(rootDir, 'projects', '4d3d3d3'), path.join(data, 'projects', '4d3d3d3'), { recursive: true });
    const library = await new Library(path.join(data, 'projects')).reload();
    const before = library.allSequences().length;
    const place = await library.prepareSequence('4d3d3d3', 'Disco Grandma', { description: 'x' });
    await library.reload();
    assert.equal(library.allSequences().length, before, 'a dancer that is still being made is not offered');
    const again = await library.prepareSequence('4d3d3d3', 'Disco Grandma', {});
    assert.notEqual(again.dir, place.dir, 'a second one does not reuse the folder');
    await library.finishSequence(again.dir);
    await library.reload();
    assert.equal(library.allSequences().length, before + 1, 'a finished one is offered');

    // The app stopped in the middle: the next start removes the half-made one and says so.
    const app = await appOn(data, 0);
    try {
      assert.ok(!existsSync(place.dir), 'the half-made folder is gone');
      assert.ok(existsSync(again.dir), 'the finished one stays');
      assert.match(app.notes.join(' '), /A new sequence was still being made when the computer last stopped, so it was removed: disco-grandma\./);
    } finally { await app.close(); }
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
});

test('quitting while a dancer is being made asks first; Keep running keeps it, Quit goes ahead', async () => {
  const library = await new Library(path.join(rootDir, 'projects')).reload();
  const computer = new Computer({ library, config: { operator: 'Paul' } });
  const actions = [];
  computer.on('action', action => actions.push(action));
  assert.equal(await computer.askToQuit(), true, 'nothing running: no question');
  assert.equal(actions.length, 0);

  computer.jobs.set('job1', { key: 'x' });
  const first = computer.askToQuit();
  const dialog = [...computer.windows.values()].find(window => window.kind === 'dialog');
  assert.deepEqual(dialog.buttons, ['Quit', 'Keep running']);
  assert.equal(dialog.text, 'A new sequence is still being generated. If you quit now it will be lost. Quit anyway?');
  assert.equal(computer.askToQuit(), first, 'asking twice shows one question');
  await computer.dialogAnswer(dialog.dialogId, 'Keep running');
  assert.equal(await first, false);
  assert.ok(![...computer.windows.values()].some(window => window.kind === 'dialog'), 'the question closes');

  const second = computer.askToQuit({ restart: true });
  const restartDialog = [...computer.windows.values()].find(window => window.kind === 'dialog');
  assert.deepEqual(restartDialog.buttons, ['Restart', 'Keep running']);
  assert.match(restartDialog.text, /If you restart now it will be lost/);
  await computer.dialogAnswer(restartDialog.dialogId, 'Restart');
  assert.equal(await second, true);

  const spoken = computer.askToQuit();
  await computer.hear('yes');
  assert.equal(await spoken, true, 'a spoken yes works too');
});

test('quitting stops a dancer that is still being made', async () => {
  const dir = await temp();
  try {
    const script = path.join(dir, 'slow.mjs');
    await fs.writeFile(script, 'console.log(JSON.stringify({ stage: "image", progress: 0.1 })); setTimeout(() => {}, 60000);');
    const generator = new Generator({ python: process.execPath, script });
    const running = generator.run({ name: 'X', prompt: 'x', out: dir });
    await wait(300);
    assert.equal(generator.children.size, 1);
    generator.stop();
    await assert.rejects(running, /stopped/);
    assert.equal(generator.children.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('outside tools: tried again in the background, reconnected after a drop, and Decline follows', async () => {
  const data = await temp();
  const port = await freePort();
  const stateDir = path.join(data, 'door-state');
  const door = () => appOn(path.join(data, 'door'), port, { overrides: { stateDir } });
  // The token for the outside door is kept in its state folder, so it stays the same across restarts.
  await fs.mkdir(stateDir, { recursive: true });
  const token = 'a'.repeat(48);
  await fs.writeFile(path.join(stateDir, 'mcp-token'), `${token}\n`);
  const connectors = new Connectors(
    { door: { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } },
    { declineTool: 'door/look', retryMs: [100], onProblem: () => {} },
  );
  let changes = 0;
  connectors.on('change', () => changes++);
  let server = null;
  try {
    await connectors.start();
    assert.equal(connectors.tools().length, 0, 'nothing there yet');
    assert.equal(connectors.canDeclineCalls(), false);

    server = await door();
    await server.listen();
    for (let i = 0; i < 50 && !connectors.tools().length; i++) await wait(100);
    assert.ok(connectors.tools().some(tool => tool.tool === 'look'), 'connected quietly once it was there');
    assert.equal(connectors.canDeclineCalls(), true);
    assert.ok(changes >= 1);

    // The other side restarts: the next call reconnects once and goes through.
    await server.close();
    server = await door();
    await server.listen();
    assert.match(await connectors.call('door', 'look', {}), /onScreen/);

    // The other side is gone: a check notices, and Decline is no longer offered.
    await server.close();
    server = null;
    assert.equal(await connectors.checkDecline(), false);
    assert.equal(connectors.canDeclineCalls(), false);
    await assert.rejects(connectors.call('door', 'look', {}), /not connected|not reachable/);
  } finally {
    await connectors.stop();
    await server?.close();
    await fs.rm(data, { recursive: true, force: true });
  }
});

test('an incoming call shows Decline only while the connector really answers', async () => {
  const library = await new Library(path.join(rootDir, 'projects')).reload();
  let there = true;
  const connectors = { canDeclineCalls: () => there, checkDecline: async () => there };
  const computer = new Computer({ library, config: { operator: 'Paul' }, connectors });
  const actions = [];
  computer.on('action', action => actions.push(action));
  computer.incomingCall({ callId: 'C1', contact: { name: 'Anna' } });
  const window = [...computer.windows.values()].find(open => open.kind === 'call');
  assert.equal(window.canDecline, true);
  there = false;
  computer.declineAvailabilityChanged();
  assert.equal(window.canDecline, false);
  assert.deepEqual(actions.at(-1), { type: 'call.decline-state', windows: [{ id: window.id, canDecline: false }] });
});

test('the robot voice is found as an installed package too, with the folder next door as fallback', async () => {
  const empty = await temp();
  try {
    assert.equal(await voderPackage('stand-in-python-with-voder', { run: async () => 0 }), true);
    assert.equal(await voderPackage('stand-in-python-without', { run: async () => 3 }), false);
    const speaker = new Speaker({ engine: 'windows', python: 'stand-in-python-with-voder-2', voderPath: empty }, empty);
    assert.equal(speaker.voderAvailable, false);
    let asked = null;
    await speaker.detect({ run: async (command, args) => { asked = { command, args }; return 0; } });
    assert.equal(speaker.voderAvailable, true);
    assert.equal(asked.command, 'stand-in-python-with-voder-2');
    assert.match(asked.args.join(' '), /find_spec\("voder\.engine"\)/, 'it only looks the package up');
    assert.equal(VODER_INSTALL, 'pip install git+https://github.com/flujo-app/voder');
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});

test('a start-up problem is explained in plain words', () => {
  assert.match(explainStartProblem(new Error('C:\\x\\harness.config.json could not be read: Unexpected token')), /^The settings file could not be read, so CINCO ID did not start\.[\s\S]*rename or delete it/);
  assert.match(explainStartProblem(Object.assign(new Error('denied'), { code: 'EPERM' }), { dataDir: 'C:\\data' }), /may not write to its data folder \(C:\\data\)/);
  assert.match(explainStartProblem(new Error('boom')), /^Something went wrong while CINCO ID was starting, so it stopped\.\n\nboom$/);
});
