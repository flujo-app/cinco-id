// Checks "your own music" in the real app, without a sound: two short test tones are put into a
// temporary music folder; the app (muted twice over) must play them as the disco levels. With an
// empty folder the band made on the spot must play.
// Usage: node test/ui/music-check.mjs [--exe <packaged CINCO ID.exe>]
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { freePort, launchOptions, takeOption } from './launch.mjs';

const exe = takeOption(process.argv.slice(2), '--exe');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-music-'));
let failed = false;
async function run(withFiles) {
  const dataDir = path.join(temp, withFiles ? 'own' : 'empty');
  await fs.mkdir(path.join(dataDir, 'music'), { recursive: true });
  if (withFiles) {
    for (const [name, tone, seconds] of [['1 first.ogg', 220, 3], ['2 second.mp3', 330, 4]]) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`, path.join(dataDir, 'music', name)]);
    }
  }
  const app = await electron.launch(launchOptions({ exe, port: await freePort(19788), dataDir, args: ['--mute-audio'], env: { CINCO_ID_CONFIG: 'none', CINCO_ID_OPERATOR: 'Paul' } }));
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.console-log');
    // A muted app keeps its music off, so the check switches it on from inside the page.
    await page.evaluate(() => import('/ui/sound.js').then(sound => sound.music(true)));
    await page.waitForFunction(() => window.betaSequence.musicStatus().playing !== 'nothing', null, { timeout: 15000 });
    let now = await page.evaluate(() => window.betaSequence.musicStatus());
    assert.equal(now.muted, true, 'the app is muted');
    if (!withFiles) { assert.equal(now.playing, 'band'); console.log('Empty music folder: the band made on the spot plays.'); return; }
    assert.equal(now.playing, 'loops');
    assert.deepEqual(now.loaded.map(entry => Math.round(entry.seconds)), [3, 4, 4], 'two files: the second also serves level 3');
    await page.evaluate(() => import('/ui/sound.js').then(sound => sound.moreDisco()));
    await page.waitForFunction(() => window.betaSequence.musicStatus().loop?.level === 2, null, { timeout: 8000 });
    now = await page.evaluate(() => window.betaSequence.musicStatus());
    assert.equal(Math.round(now.loop.seconds), 4);
    assert.equal(now.loop.looping, true);
    console.log('Own music: the first file plays for "disco", the second after "more disco", both looping.');
  } finally { await app.close().catch(() => {}); }
}
try { await run(true); await run(false); console.log('Music check passed (nothing was audible).'); }
catch (error) { console.error(`Music check FAILED: ${error.message}`); failed = true; }
finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
process.exitCode = failed ? 1 : 0;
