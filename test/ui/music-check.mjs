// Checks the disco music in the real app WITHOUT making a sound: the app starts with --silent
// (everything muted) and Chromium's own --mute-audio. It turns the music on from inside the page,
// then reads back that the three loops were decoded, that a looping loop is playing in time, that
// "more disco" reaches level 3, and that the music stops again. Then it hides the loops from the page
// and checks that the small band made on the spot takes over.
// Usage: node test/ui/music-check.mjs [--exe <packaged CINCO ID.exe>]
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { freePort, launchOptions, root, takeOption } from './launch.mjs';
import { leftSwitchedOff, windows } from './desktop.mjs';

const args = process.argv.slice(2);
const exe = takeOption(args, '--exe');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-music-'));
const before = windows();
const list = JSON.parse(await fs.readFile(path.join(root, 'src', 'ui', 'music', 'music.json'), 'utf8'));

const app = await electron.launch(launchOptions({
  exe, port: await freePort(19788), dataDir: path.join(temp, 'data'), args: ['--mute-audio'],
  env: { CINCO_ID_CONFIG: 'none', CINCO_ID_OPERATOR: 'Paul' },
}));
let failed = false;
try {
  const page = await app.firstWindow();
  const problems = [];
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  await page.waitForSelector('.console-log');
  const status = () => page.evaluate(() => window.betaSequence.musicStatus());
  const sound = (call, ...rest) => page.evaluate(async ([name, values]) => (await import('/ui/sound.js'))[name](...values), [call, rest]);

  await sound('music', true);
  await page.waitForFunction(() => window.betaSequence.musicStatus().playing !== 'nothing', null, { timeout: 20000 });
  let now = await status();
  assert.equal(now.muted, true, 'the app is muted');
  assert.equal(now.volume, 0, 'nothing reaches the speakers');
  assert.equal(now.error, null, `the loops loaded (${now.error})`);
  assert.equal(now.playing, 'loops', 'the real loops play, not the fallback band');
  assert.equal(now.loaded.length, 3, 'three loops decoded');
  for (const track of list.tracks) {
    const loaded = now.loaded.find(item => item.level === track.level);
    assert.ok(Math.abs(loaded.seconds - track.seconds) < 0.002, `level ${track.level} decodes to ${loaded.seconds} s, listed ${track.seconds} s (no gap or padding)`);
    assert.equal(loaded.channels, 2);
  }
  assert.deepEqual(now.loop, { level: 1, looping: true, seconds: now.loaded[0].seconds }, 'level 1 loops');
  const time = now.context.time;
  await page.waitForTimeout(600);
  now = await status();
  assert.equal(now.context.state, 'running');
  assert.ok(now.context.time > time + 0.3, 'the sound clock runs');
  console.log(`Loops decoded: ${now.loaded.map(item => `level ${item.level} ${item.seconds.toFixed(3)} s`).join(', ')} at ${now.context.sampleRate} Hz`);

  assert.equal(await sound('moreDisco'), 2);
  assert.equal(await sound('moreDisco'), 3);
  assert.equal(await sound('moreDisco'), 3, 'level 3 is the most');
  await page.waitForTimeout(1300);
  now = await status();
  assert.equal(now.level, 3);
  assert.equal(now.loop.level, 3, 'the level 3 loop plays after the blends');
  assert.equal(now.loop.looping, true);
  console.log('More disco: level 2, then level 3; the level 3 loop is playing.');

  await sound('music', false);
  await page.waitForTimeout(1000);
  now = await status();
  assert.equal(now.on, false);
  assert.equal(now.playing, 'nothing', 'the music stopped');

  // The fallback: the page cannot get the loops, so the band made on the spot plays.
  await page.route('**/ui/music/**', route => route.fulfill({ status: 404, body: 'gone' }));
  await page.reload();
  await page.waitForSelector('.console-log');
  await sound('music', true);
  await page.waitForFunction(() => window.betaSequence.musicStatus().playing !== 'nothing', null, { timeout: 20000 });
  now = await status();
  assert.equal(now.playing, 'band', 'the fallback band plays');
  assert.match(now.error ?? '', /404/);
  assert.equal(await sound('moreDisco'), 2);
  await sound('music', false);
  await page.waitForTimeout(1000);
  assert.equal((await status()).playing, 'nothing');
  console.log(`Fallback: without the loops (${now.error}) the band made on the spot plays.`);
  assert.deepEqual(problems, [], 'no errors on the page');
  console.log('Music check passed (nothing was audible).');
} catch (error) {
  console.error(`Music check FAILED: ${error.message}`);
  failed = true;
} finally {
  await app.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
for (const problem of leftSwitchedOff(before)) { console.error(`Problem: ${problem}`); failed = true; }
process.exitCode = failed ? 1 : 0;
