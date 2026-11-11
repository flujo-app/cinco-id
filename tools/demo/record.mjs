// Records the demo video: the first-run Setup window, the 4d3d3d3 routine and the dancer in
// d15c0, with the app's own sound (voice, effects, music). THIS IS AUDIBLE and takes about
// three minutes. Nothing else on the PC is recorded: the picture is the app's own window
// content, the sound is the app's own sound.
//
//   node tools/demo/record.mjs [output.mp4] [--voice robot|zira|<part of a Windows voice name>] [--keep-frames]
//
// Needs ffmpeg on the PATH. Uses a fresh temporary data folder, so your own settings and
// projects are not touched.
import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { freePort, root } from '../../test/ui/launch.mjs';

const args = process.argv.slice(2);
const keepFrames = args.includes('--keep-frames');
const voiceAt = args.indexOf('--voice');
const voiceWanted = voiceAt >= 0 ? String(args.splice(voiceAt, 2)[1] ?? 'robot').toLowerCase() : 'robot';
const output = path.resolve(args.find(arg => !arg.startsWith('--')) ?? path.join(root, 'docs', 'demo.mp4'));
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-demo-'));
const framesDir = path.join(work, 'frames');
await fs.mkdir(framesDir, { recursive: true });
const dataDir = path.join(work, 'data');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (command, commandArgs) => new Promise((resolve, reject) => {
  const child = spawn(command, commandArgs, { windowsHide: true });
  let problem = '';
  child.stderr.on('data', chunk => { problem = (problem + chunk).slice(-1500); });
  child.on('error', reject);
  child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${command} stopped (${code}): ${problem}`))));
});

const port = await freePort(19790);
const app = await electron.launch({
  args: ['.', `--port=${port}`, '--no-tray', '--no-print'],
  cwd: root,
  env: { ...process.env, CINCO_ID_DATA_DIR: dataDir, CINCO_ID_OPERATOR: '' },
});

const frames = [];
let audioStartedAt = null;
let ok = false;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.window.kind-setup', { timeout: 20000 });

  // Picture: the page's own frames, with the time each one was shown.
  const client = await page.context().newCDPSession(page);
  let writing = Promise.resolve();
  client.on('Page.screencastFrame', event => {
    const file = path.join(framesDir, `f${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, at: event.metadata.timestamp });
    writing = writing.then(() => fs.writeFile(file, Buffer.from(event.data, 'base64')));
    client.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  // Sound: everything the app itself plays.
  audioStartedAt = await page.evaluate(() => window.betaSequence.startRecording());
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 86, everyNthFrame: 2 });

  const spoken = text => page.waitForFunction(
    wanted => window.betaSequence.voiceLog().some(line => line.text.includes(wanted)),
    text, { timeout: 40000 },
  ).catch(() => {});
  let saidSoFar = 0;
  /** Types a line the way a person would, sends it, and waits until the answer has been spoken. */
  const say = async (text, { answer = true, after = 700 } = {}) => {
    const input = page.locator('.console-row input');
    await input.click();
    await input.pressSequentially(text, { delay: 26 });
    await pause(250);
    await input.press('Enter');
    if (answer) {
      await page.waitForFunction(count => window.betaSequence.voiceLog().length > count, saidSoFar, { timeout: 40000 }).catch(() => {});
      saidSoFar = await page.evaluate(() => window.betaSequence.voiceLog().length);
    }
    await pause(after);
  };

  // ---- 1. First start: the Setup window ----
  const setup = page.locator('.window.kind-setup');
  const next = async (wait = 1500) => { await pause(wait); await setup.locator('button[data-role=next]').click(); };
  await pause(1800);
  await setup.locator('input[name=operator]').click();
  await setup.locator('input[name=operator]').fill('');
  await setup.locator('input[name=operator]').pressSequentially('Paul', { delay: 90 });
  await next();
  await pause(900); // Voice
  // Pick the voice for this recording: the robot voice, or a Windows voice by (part of) its name.
  const voiceValue = await setup.locator('input[name=voice]').evaluateAll((inputs, wanted) => {
    const values = inputs.map(input => input.value);
    const found = wanted === 'robot'
      ? values.find(value => value === 'voder')
      : values.find(value => value.toLowerCase().startsWith('windows:') && value.toLowerCase().includes(wanted));
    return found ?? values[0];
  }, voiceWanted);
  console.log(`Voice for this recording: ${voiceValue}`);
  await setup.locator(`input[name=voice][value="${voiceValue}"]`).check();
  await setup.locator('button[data-role=say-something]').click();
  await page.waitForFunction(() => !/Speaking/.test(document.querySelector('.kind-setup .setup-status')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});
  await next(3200);
  await next(2200); // Listening
  await pause(900); // Brain
  const claude = setup.locator('input[name=brain][value=claude-cli]');
  if (await claude.count()) await claude.check();
  await next(2200);
  await next(3200); // WhatsApp
  await next(3000); // New dancers
  await pause(2200); // Finish
  await setup.locator('button[data-role=finish]').click();
  await setup.locator('button[data-role=close]').waitFor({ timeout: 20000 });
  await pause(1500);
  await setup.locator('button[data-role=close]').click();
  await spoken('What will your first sequence of the day be');
  saidSoFar = await page.evaluate(() => window.betaSequence.voiceLog().length);
  await pause(600);

  // ---- 2. The 4d3d3d3 routine ----
  await say('Computer, load up Celery Man please.', { after: 1500 });
  await say('Could you kick up the 4d3d3d3?', { after: 4500 });
  await say('More disco.', { after: 3500 });
  await say('Add sequence: Oyster.', { after: 1200 });
  await say('Give me a printout of Oyster smiling.', { after: 4200 });
  await say('Computer, do we have any new sequences?');
  await say('Alright.', { after: 2500 });
  await say('Now Tayne I can get into.', { answer: false, after: 1200 });
  await say('Can I get a hat wobble?', { after: 2200 });
  await say('And a Flarhgunnstow?', { after: 3200 });
  await say('Is there any way to generate a nude Tayne?');
  await say('Nude. Tayne.', { after: 1200 });
  await say('Mmm... mm-hmm.', { after: 5000 });

  // ---- 3. The dancer that was made from one sentence ----
  await say('clear the desktop', { after: 900 });
  await say('kick up the d15c0', { after: 3500 });
  await say('Mooooore discooooo!', { after: 5000 });
  await say('rainbow', { after: 4000 });

  // ---- 4. A call comes in ----
  await say('test call from my wife', { after: 1800 });
  await page.locator('.kind-call button', { hasText: 'Accept' }).click();
  await page.waitForFunction(count => window.betaSequence.voiceLog().length > count, saidSoFar, { timeout: 30000 }).catch(() => {});
  saidSoFar = await page.evaluate(() => window.betaSequence.voiceLog().length);
  await pause(900);
  await page.locator('.kind-call button', { hasText: 'Decline' }).click();
  await page.waitForFunction(count => window.betaSequence.voiceLog().length > count, saidSoFar, { timeout: 30000 }).catch(() => {});
  await pause(2500);

  await client.send('Page.stopScreencast').catch(() => {});
  await writing;
  const audio = await page.evaluate(() => window.betaSequence.stopRecording());
  if (!audio) throw new Error('No sound was recorded.');
  await fs.writeFile(path.join(work, 'sound.webm'), Buffer.from(audio, 'base64'));
  ok = true;
} catch (error) {
  console.error(`Recording FAILED: ${error.message}`);
} finally {
  await app.close().catch(() => {});
}

if (ok && frames.length > 10) {
  // Each frame is shown until the next one arrives, so the timing in the video is the real timing.
  const list = ['ffconcat version 1.0'];
  for (let i = 0; i < frames.length; i++) {
    const length = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].at - frames[i].at) : 0.5;
    list.push(`file '${frames[i].file.replace(/\\/g, '/')}'`, `duration ${length.toFixed(4)}`);
  }
  list.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`);
  await fs.writeFile(path.join(work, 'frames.txt'), list.join('\n'));
  const soundOffset = audioStartedAt / 1000 - frames[0].at; // how much later than the first picture the sound begins
  await fs.mkdir(path.dirname(output), { recursive: true });
  await run('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', path.join(work, 'frames.txt'),
    '-itsoffset', soundOffset.toFixed(3), '-i', path.join(work, 'sound.webm'),
    '-vf', 'fps=30,scale=1280:-2:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart',
    output,
  ]);
  const seconds = frames.at(-1).at - frames[0].at;
  const size = (await fs.stat(output)).size;
  console.log(`Demo video: ${output}`);
  console.log(`${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s, ${frames.length} pictures, ${(size / 1048576).toFixed(1)} MB, sound starts ${soundOffset.toFixed(2)} s after the first picture.`);
} else if (ok) {
  console.error('Too few pictures were captured.');
  ok = false;
}
if (!keepFrames) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
else console.log(`Working files kept in ${work}`);
process.exitCode = ok ? 0 : 1;
