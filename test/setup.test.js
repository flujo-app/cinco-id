import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkEars, findOnPath, modalSignInFile, prepareInfo, setupStatus } from '../src/server/setup.js';
import { SecretStore } from '../src/server/secrets.js';
import { Library } from '../src/server/projects.js';
import { Computer } from '../src/server/computer.js';
import { parseCommand } from '../src/server/commands.js';
import { standInCipher } from './helpers/stand-ins.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('commands are found the way Windows finds them, without running anything', async () => {
  const present = new Set([path.join('C:\\Tools', 'claude.exe'), path.join('C:\\Py\\Scripts', 'modal.exe')]);
  const fileExists = async file => present.has(file);
  const env = { PATH: 'C:\\Windows;"C:\\Tools";C:\\Py\\Scripts', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(await findOnPath('claude', { env, platform: 'win32', fileExists }), path.join('C:\\Tools', 'claude.exe'));
  assert.equal(await findOnPath('modal', { env, platform: 'win32', fileExists }), path.join('C:\\Py\\Scripts', 'modal.exe'));
  assert.equal(await findOnPath('calc', { env, platform: 'win32', fileExists }), null);
});

test('the status check reports what this PC has, with stand-ins for the PC', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-status-'));
  try {
    const secrets = await new SecretStore({ file: path.join(temp, 'secrets.json'), cipher: standInCipher() }).load();
    const config = {
      voice: { stt: { engine: 'whisper', python: 'C:\\venv\\python.exe', model: 'small' } },
      media: { script: path.join(rootDir, 'tools', 'media', 'generate.py') },
      brain: { apiKeyEnv: 'OPENAI_API_KEY' },
    };
    const looked = [];
    const probe = {
      env: { MODAL_CONFIG_PATH: path.join(temp, 'modal.toml') },
      home: temp,
      fileExists: async file => { looked.push(file); return file === path.join(temp, 'modal.toml') || file === config.media.script; },
      findCommand: async name => (name === 'modal' ? 'C:\\Py\\Scripts\\modal.exe' : null),
      listVoices: async () => [{ engine: 'voder', name: 'Robot' }, { engine: 'windows', name: 'Microsoft Zira Desktop', language: 'en-US' }],
      checkEars: async (python, model) => ({ ok: true, message: `${python} ${model}` }),
    };
    const status = await setupStatus(config, { secrets, probe });
    assert.equal(status.voder.available, true);
    assert.deepEqual(status.voices.map(voice => voice.name), ['Robot', 'Microsoft Zira Desktop']);
    assert.equal(status.claude.found, false);
    assert.deepEqual(status.modal, { command: true, signedIn: true });
    assert.equal(status.ears.ok, true);
    assert.equal(status.ears.message, 'C:\\venv\\python.exe small');
    assert.deepEqual(status.openrouter, { set: false, source: null });
    assert.equal(status.generator.script, true);
    assert.ok(looked.includes(path.join(temp, 'modal.toml')), 'the sign-in file is only looked for');

    await secrets.set('openrouter', 'sk-or-1234567890');
    const after = await setupStatus({ ...config, voice: { stt: { engine: 'off' } } }, { secrets, probe: { ...probe, fileExists: async () => false, findCommand: async name => (name === 'claude' ? 'C:\\c\\claude.exe' : null) } });
    assert.deepEqual(after.openrouter, { set: true, source: 'stored' });
    assert.equal(after.claude.found, true);
    assert.deepEqual(after.modal, { command: false, signedIn: false });
    assert.deepEqual(after.ears, { configured: false });
    assert.ok(!JSON.stringify(after).includes('sk-or-1234567890'));

    assert.equal(modalSignInFile({}, 'C:\\Users\\x'), path.join('C:\\Users\\x', '.modal.toml'));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('the ears test asks the chosen Python with fixed code, and only an existing python.exe', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-ears-'));
  try {
    const python = path.join(temp, 'python.exe');
    await fs.writeFile(python, '');
    const calls = [];
    const run = async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '{"ok": true, "version": "1.2.3", "model": false}\n', stderr: '' };
    };
    const result = await checkEars(python, 'small', { run });
    assert.equal(result.ok, true);
    assert.match(result.message, /faster-whisper 1\.2\.3/);
    assert.match(result.message, /not on this PC yet/);
    assert.equal(calls[0].command, python);
    assert.equal(calls[0].args[0], '-c');
    assert.equal(calls[0].args[2], 'small', 'the model name is an argument, not part of the code');
    assert.equal(calls[0].options.env.HF_HUB_OFFLINE, '1', 'nothing is downloaded');

    const missing = await checkEars(path.join(temp, 'nope', 'python.exe'), 'small', { run });
    assert.equal(missing.ok, false);
    const notPython = await checkEars('C:\\Windows\\System32\\cmd.exe', 'small', { run });
    assert.equal(notPython.ok, false);
    assert.equal(calls.length, 1, 'nothing else was started');

    const without = await checkEars(python, 'small', { run: async () => ({ code: 0, stdout: '{"ok": false, "reason": "faster-whisper is not installed in this Python."}', stderr: '' }) });
    assert.deepEqual(without, { ok: false, message: 'faster-whisper is not installed in this Python.' });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('when the dancer tools cannot be asked, the fallback numbers come from the guide\'s table', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-guide-'));
  try {
    const guide = path.join(temp, 'MEDIA.md');
    await fs.writeFile(guide, '| | Size | Time | Cloud cost |\n|---|---|---|---|\n| A | 1 GB | about 1 minutes | about $0.01 |\n| **Total** | **240 GB** | **about 40 minutes** | **about $0.25** |\n');
    assert.deepEqual(await prepareInfo(guide), { found: true, size: '240 GB', time: '40 minutes', cost: '$0.25', source: 'docs/MEDIA.md' });
    await fs.writeFile(guide, 'Nothing about costs here.\n');
    assert.equal((await prepareInfo(guide)).found, false);
    assert.equal((await prepareInfo(path.join(temp, 'missing.md'))).found, false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('saying or typing "setup" or "settings" opens the Setup window', async () => {
  const world = { findSequence: () => null, findProject: () => null, findEffect: () => null, variantWords: {} };
  for (const said of ['setup', 'Settings', 'Computer, open the settings please.', 'show me the setup', 'set up', 'open settings', 'preferences']) {
    assert.equal(parseCommand(said, world).intent, 'setup', said);
  }
  for (const said of ['load up celery man', 'settle down']) assert.notEqual(parseCommand(said, world).intent, 'setup', said);

  const library = await new Library(path.join(rootDir, 'projects')).reload();
  const computer = new Computer({ library, config: { operator: 'Paul' } });
  const actions = [];
  computer.on('action', action => actions.push(action));
  await computer.hear('setup');
  assert.ok(actions.some(action => action.type === 'setup.open'));
  assert.equal(computer.log.at(-1).text, 'Setup.');
});
