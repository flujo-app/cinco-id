import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server/app.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const musicDir = path.join(rootDir, 'src', 'ui', 'music');
const list = JSON.parse(await fs.readFile(path.join(musicDir, 'music.json'), 'utf8'));

test('music.json lists three loops, one per disco level, that match the files on disk', async () => {
  assert.deepEqual(list.tracks.map(track => track.level), [1, 2, 3]);
  assert.ok(list.bpm >= 118 && list.bpm <= 124, 'a disco tempo');
  assert.ok(list.seconds >= 30 && list.seconds <= 70, 'about 30 to 70 seconds');
  assert.ok([16, 32].includes(list.bars));
  assert.ok(Math.abs(list.bars * 4 * 60 / list.bpm - list.seconds) < 0.001, 'a whole number of bars');
  for (const track of list.tracks) {
    assert.match(track.file, /^[\w.-]+\.ogg$/);
    const info = await fs.stat(path.join(musicDir, track.file));
    assert.equal(info.size, track.bytes, `${track.file} is the file that was measured`);
    assert.equal(track.bpm, list.bpm, 'every loop has the same tempo');
    assert.equal(track.bars, list.bars, 'every loop has the same length, so a switch stays in time');
    assert.ok(Math.abs(track.seconds - list.seconds) < 0.001);
    assert.equal(track.decodedSamples, track.samples, `${track.file} decodes to exactly its length (no padding)`);
    assert.ok(track.loudnessLufs > -18 && track.loudnessLufs < -13, 'about -16 LUFS');
    assert.ok(track.truePeakDb <= -0.5, 'headroom, no clipping');
    assert.equal(typeof track.seed, 'number');
    assert.ok(track.prompt.includes('disco') && track.prompt.includes('no vocals'));
    assert.equal(track.lyrics, '[Instrumental]');
  }
  const levels = list.tracks.map(track => track.loudnessLufs);
  assert.ok(levels[2] >= levels[0] - 0.5 && levels[2] - levels[0] <= 2.5, 'level 3 is as loud or up to 2 dB louder');
});

test('the music says where it came from: open model, exact revision, licence', () => {
  assert.equal(list.model.repo, 'ACE-Step/acestep-v15-xl-turbo-diffusers');
  assert.match(list.model.revision, /^[0-9a-f]{40}$/);
  assert.equal(list.model.license, 'mit');
  assert.match(list.made, /^\d{4}-\d{2}-\d{2}$/);
});

test('the loops stay small: about 1 MB each, 4 MB in all at most', async () => {
  const sizes = await Promise.all(list.tracks.map(async track => (await fs.stat(path.join(musicDir, track.file))).size));
  for (const size of sizes) assert.ok(size <= 1_100_000, `${size} bytes`);
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= 4_000_000);
});

test('the local server hands out the loops as Ogg sound and their list as JSON', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-music-'));
  process.env.CINCO_ID_CONFIG = 'none';
  const app = await createApp({
    rootDir,
    overrides: {
      port: 0, operator: 'Paul', stateDir: path.join(temp, 'state'), printouts: { dir: path.join(temp, 'printouts') },
      voice: { tts: { engine: 'browser' }, stt: { engine: 'off' } },
    },
    parts: { brain: null, generator: null },
  });
  try {
    const base = `http://127.0.0.1:${await app.listen()}`;
    const manifest = await fetch(`${base}/ui/music/music.json`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /^application\/json/);
    for (const track of list.tracks) {
      const response = await fetch(`${base}/ui/music/${track.file}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'audio/ogg');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, track.bytes);
      assert.equal(bytes.subarray(0, 4).toString('latin1'), 'OggS');
      assert.ok(bytes.includes(Buffer.from('OpusHead')), `${track.file} is Ogg Opus`);
    }
  } finally {
    await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
