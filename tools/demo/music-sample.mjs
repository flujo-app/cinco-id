// Makes a listening sample of the built-in band: every theme at every "more disco" level, one after
// another, taken from inside the app. It makes NO SOUND on this PC while it records.
//   node tools/demo/music-sample.mjs [output.mp3] [seconds per part]
//   node tools/demo/music-sample.mjs [output.mp3] --song house [seconds]   one tune from its start, e.g. a whole song
import { _electron as electron } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { freePort, root } from '../../test/ui/launch.mjs';

const args = process.argv.slice(2);
const songAt = args.indexOf('--song');
const song = songAt >= 0 ? args.splice(songAt, 2)[1] : null;
const output = path.resolve(args[0] ?? 'music-sample.mp3');
const seconds = Number(args[1] ?? (song ? 156 : 9));
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-sample-'));
const app = await electron.launch({
  args: ['.', `--port=${await freePort(19830)}`, '--no-tray', '--no-print', '--no-setup', '--mute-audio'],
  cwd: root, env: { ...process.env, CINCO_ID_DATA_DIR: path.join(work, 'data'), CINCO_ID_CONFIG: 'none', CINCO_ID_OPERATOR: 'Paul', CINCO_ID_MUSIC_DIR: path.join(work, 'no-music') },
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.console-log');
  // Let the greeting be spoken and finish, so no voice ends up in the sample.
  await page.waitForFunction(() => window.betaSequence.voiceLog().length > 0, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(9000);
  const parts = await page.evaluate(async ([secondsEach, song]) => {
    const sound = await import('/ui/sound.js');
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const names = [];
    sound.quiet();
    await window.betaSequence.startRecording();
    if (song) {
      sound.setTheme(song);
      sound.music(true);
      await wait(secondsEach * 1000);
      sound.music(false);
      await wait(900);
      return { names: [song], audio: await window.betaSequence.stopRecording() };
    }
    for (const name of sound.THEME_NAMES) {
      sound.setTheme(name);
      sound.music(true);
      for (const level of [1, 2, 3]) { names.push(`${name} ${level}`); await wait(secondsEach * 1000); if (level < 3) sound.moreDisco(); }
      sound.music(false);
      await wait(1200);
      sound.resetDisco();
    }
    return { names, audio: await window.betaSequence.stopRecording() };
  }, [seconds, song]);
  await fs.writeFile(path.join(work, 'sample.webm'), Buffer.from(parts.audio, 'base64'));
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(work, 'sample.webm'), '-b:a', '192k', output]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  console.log(`Sample: ${output}\nIn order, ${seconds} s each: ${parts.names.join(', ')}`);
} finally {
  await app.close().catch(() => {});
  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
}
