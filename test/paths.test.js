import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, seedProjects } from '../src/server/paths.js';
import { loadConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['CINCO_ID_CONFIG', 'CINCO_ID_DATA_DIR', 'CINCO_ID_STATE_DIR', 'CINCO_ID_PROJECTS_DIR', 'CINCO_ID_PRINTOUTS_DIR', 'CINCO_ID_PORT', 'CINCO_ID_OPERATOR', 'CINCO_ID_NO_SETUP']) {
  delete process.env[name];
}

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-paths-'));
/** The example projects that come with the app (hex-named folders). */
const bundled = async () => (await fs.readdir(path.join(rootDir, 'projects'))).filter(name => /^[0-9a-f]+$/.test(name)).sort();

test('the data folder: the project folder for a clone, the per-user folder when installed, or a chosen one', () => {
  const appDir = path.resolve('C:/apps/cinco');
  assert.equal(resolveDataDir({ appDir, env: {} }), appDir);
  assert.equal(resolveDataDir({ appDir, packaged: false, userData: 'C:/Users/x/AppData/Roaming/CINCO ID', env: {} }), appDir);
  assert.equal(resolveDataDir({ appDir, packaged: true, userData: 'C:/Users/x/AppData/Roaming/CINCO ID', env: {} }), 'C:/Users/x/AppData/Roaming/CINCO ID');
  assert.equal(resolveDataDir({ appDir, packaged: true, userData: 'u', env: { CINCO_ID_DATA_DIR: 'C:/elsewhere' } }), path.resolve('C:/elsewhere'));
  assert.equal(resolveDataDir({ appDir, env: { CINCO_ID_DATA_DIR: 'C:/elsewhere' }, option: 'D:/chosen' }), path.resolve('D:/chosen'));
});

test('a clone keeps everything in the project folder, exactly as before', async () => {
  const config = await loadConfig(rootDir, {});
  assert.equal(config.dataDir, rootDir);
  assert.equal(config.configFile, path.join(rootDir, 'harness.config.json'));
  assert.equal(config.projectsDir, path.join(rootDir, 'projects'));
  assert.equal(config.stateDir, path.join(rootDir, '.local'));
  assert.equal(config.printouts.dir, path.join(rootDir, 'printouts'));
  assert.equal(config.cacheDir, path.join(rootDir, '.cache'));
});

test('with a data folder, settings, memory, printouts, caches and projects live there; code stays in the app folder', async () => {
  const data = await temp();
  try {
    await fs.writeFile(path.join(data, 'harness.config.json'), JSON.stringify({ operator: 'Ingrid', maxWindows: 12 }));
    const config = await loadConfig(rootDir, {}, { dataDir: data });
    assert.equal(config.operator, 'Ingrid', 'the settings file is read from the data folder');
    assert.equal(config.maxWindows, 12);
    assert.equal(config.configFile, path.join(data, 'harness.config.json'));
    assert.equal(config.projectsDir, path.join(data, 'projects'));
    assert.equal(config.stateDir, path.join(data, '.local'));
    assert.equal(config.printouts.dir, path.join(data, 'printouts'));
    assert.equal(config.cacheDir, path.join(data, '.cache'));
    assert.equal(config.media.script, path.join(rootDir, 'tools', 'media', 'generate.py'));
    assert.equal(config.bundledProjectsDir, path.join(rootDir, 'projects'));

    // The test switches still win over the data folder.
    process.env.CINCO_ID_STATE_DIR = path.join(data, 'other-state');
    process.env.CINCO_ID_PROJECTS_DIR = path.join(data, 'other-projects');
    process.env.CINCO_ID_PRINTOUTS_DIR = path.join(data, 'other-printouts');
    process.env.CINCO_ID_OPERATOR = 'Paul';
    process.env.CINCO_ID_PORT = '19799';
    const switched = await loadConfig(rootDir, {}, { dataDir: data });
    assert.equal(switched.stateDir, path.join(data, 'other-state'));
    assert.equal(switched.projectsDir, path.join(data, 'other-projects'));
    assert.equal(switched.printouts.dir, path.join(data, 'other-printouts'));
    assert.equal(switched.operator, 'Paul');
    assert.equal(switched.port, 19799);

    process.env.CINCO_ID_CONFIG = 'none';
    assert.equal((await loadConfig(rootDir, {}, { dataDir: data })).configFile, null);
    process.env.CINCO_ID_DATA_DIR = data;
    assert.equal((await loadConfig(rootDir, {})).dataDir, data, 'CINCO_ID_DATA_DIR works without the desktop shell too');
  } finally {
    for (const name of ['CINCO_ID_STATE_DIR', 'CINCO_ID_PROJECTS_DIR', 'CINCO_ID_PRINTOUTS_DIR', 'CINCO_ID_OPERATOR', 'CINCO_ID_PORT', 'CINCO_ID_CONFIG', 'CINCO_ID_DATA_DIR']) delete process.env[name];
    await fs.rm(data, { recursive: true, force: true });
  }
});

test('the demo project is copied on the first start only, and never over the user\'s own projects', async () => {
  const data = await temp();
  try {
    const target = path.join(data, 'projects');
    assert.deepEqual((await seedProjects(path.join(rootDir, 'projects'), target)).sort(), await bundled());
    const copied = JSON.parse(await fs.readFile(path.join(target, '4d3d3d3', 'project.json'), 'utf8'));
    assert.ok(copied.name);
    assert.ok((await fs.stat(path.join(target, '4d3d3d3', 'sequences', 'tayne', 'loop.webm'))).size > 1000, 'the clips come along');

    // Changes the user made stay, and a second start copies nothing.
    await fs.writeFile(path.join(target, '4d3d3d3', 'project.json'), '{"name":"Mine now"}');
    assert.deepEqual(await seedProjects(path.join(rootDir, 'projects'), target), []);
    assert.equal(await fs.readFile(path.join(target, '4d3d3d3', 'project.json'), 'utf8'), '{"name":"Mine now"}');

    // Someone who deleted the demo but has their own project does not get it back.
    await fs.rm(path.join(target, '4d3d3d3'), { recursive: true });
    await fs.mkdir(path.join(target, 'beef', 'sequences'), { recursive: true });
    assert.deepEqual(await seedProjects(path.join(rootDir, 'projects'), target), []);
    // The same folder is never copied onto itself.
    assert.deepEqual(await seedProjects(path.join(rootDir, 'projects'), path.join(rootDir, 'projects')), []);
  } finally {
    await fs.rm(data, { recursive: true, force: true });
  }
});

test('an app started with a data folder copies the demo there and keeps its memory there', async () => {
  const data = await temp();
  const app = await createApp({ rootDir, dataDir: data, overrides: { port: 0, voice: { tts: { engine: 'browser' }, stt: { engine: 'off' } } }, parts: { brain: null, generator: null, connectors: { tools: () => [], stop: async () => {} } } });
  try {
    assert.deepEqual([...app.seeded].sort(), await bundled());
    assert.ok(app.library.projects.has('4d3d3d3'));
    assert.ok(app.library.allSequences().every(sequence => sequence.dir.startsWith(data)), 'sequences are read from the data folder');
    await app.listen();
    await fs.access(path.join(data, '.local', 'mcp-token'));
    await app.computer.hear('kick up the beef');
    await app.computer.hear('yes');
    await fs.access(path.join(data, 'projects', 'beef', 'project.json'));
  } finally {
    await app.close();
    await fs.rm(data, { recursive: true, force: true });
  }
});
