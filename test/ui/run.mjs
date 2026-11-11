// Starts the real desktop shell (silently), plays the whole routine through the console and
// checks what ends up on screen. It runs with its own empty data folder, so it also checks that
// the demo project is copied there on the first start.
// Usage: node test/ui/run.mjs [folder for pictures] [--overlay] [--exe <packaged CINCO ID.exe>]
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { launchOptions, takeOption } from './launch.mjs';
import { leftSwitchedOff, windows } from './desktop.mjs';

const args = process.argv.slice(2);
const exe = takeOption(args, '--exe');
const overlay = args.includes('--overlay');
const shots = args.find(arg => !arg.startsWith('--')) ?? null;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-ui-'));
const dataDir = path.join(temp, 'data');
const before = windows();

const app = await electron.launch(launchOptions({
  exe, port: 19781, dataDir, args: overlay ? ['--overlay'] : [],
  env: { CINCO_ID_CONFIG: 'none', CINCO_ID_OPERATOR: 'Paul' },
}));

const problems = [];
let step = 0;
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  await page.waitForSelector('.console-log');
  if (exe) console.log(`Packaged app: ${exe}`);
  const copied = await fs.readdir(path.join(dataDir, 'projects')).catch(() => []);
  assert.ok(copied.includes('4d3d3d3'), 'the demo project was copied into the empty data folder on the first start');
  console.log(`Example projects copied into the new data folder: ${copied.join(', ')}`);
  assert.equal(await page.locator('.window.kind-setup').count(), 0, 'the Setup window stays closed with --no-setup');

  const count = selector => page.locator(selector).count();
  const lastLine = async () => (await page.locator('.console-log .computer').last().textContent()) ?? '';
  const picture = async name => {
    if (!shots) return;
    await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${String(++step).padStart(2, '0')}-${name}.png`) });
  };
  const say = async (text, expected, settle = 500) => {
    await page.fill('.console-row input', text);
    await page.press('.console-row input', 'Enter');
    if (expected) {
      await page.waitForFunction(
        want => [...document.querySelectorAll('.console-log .computer')].at(-1)?.textContent === want,
        expected, { timeout: 8000 },
      ).catch(async () => { throw new Error(`After "${text}" expected "${expected}" but the computer said "${await lastLine()}"`); });
    }
    await page.waitForTimeout(settle);
  };

  await page.waitForFunction(() => /first sequence of the day/.test(document.querySelector('.console-log')?.textContent ?? ''), null, { timeout: 8000 });
  await picture('greeting');

  await say('Computer, load up Celery Man please.', null);
  assert.equal(await count('.window.kind-sequence'), 1, 'one dancer window');
  await picture('celery-man');

  await say('Could you kick up the 4d3d3d3?', '4d3d3d3 engaged.', 2200);
  assert.ok(await count('.window.kind-sequence') > 20, 'kicking it up fills the screen');
  await picture('engaged');

  await say('Add sequence: Oyster.', 'Sequence added.');
  await say('Give me a printout of Oyster smiling.', 'Printing.', 4200);
  assert.equal(await count('.window.kind-printout'), 1, 'a printout window');
  await page.waitForFunction(() => /^Saved:/.test(document.querySelector('.kind-printout .status-line')?.textContent ?? ''), null, { timeout: 8000 });
  const printed = await fs.readdir(path.join(dataDir, 'printouts'));
  assert.equal(printed.length, 1, 'the printout was saved as a picture');
  await picture('printout');

  await say('Computer, do we have any new sequences?', 'I have a BETA sequence I have been working on. Would you like to see it?');
  await say('Alright.', 'Tayne.', 900);
  await say('Now Tayne I can get into.', null);
  await say('Can I get a hat wobble?', 'Yes.');
  await say('And a Flarhgunnstow?', 'Yes.', 900);
  await picture('tayne-effects');

  await say('Is there any way to generate a nude Tayne?', 'Not computing. Please repeat.');
  await say('Nude. Tayne.', 'This is not suitable for work. Are you sure?');
  assert.equal(await count('.window.kind-dialog'), 1, 'the are-you-sure dialog');
  await picture('are-you-sure');
  await say('Mmm... mm-hmm.', 'Generating.', 2200);
  assert.equal(await count('.window.kind-dialog'), 0, 'the dialog is gone');
  await picture('variant');

  await say('test call from my wife', null, 700);
  assert.equal(await count('.window.kind-call'), 1, 'an incoming call window');
  assert.match(await page.locator('.kind-call .call-name').textContent(), /My Wife/);
  await picture('call');
  await page.click('.kind-call button:has-text("Decline")');
  await page.waitForFunction(() => !document.querySelector('.window.kind-call'), null, { timeout: 4000 });

  // Drawing must actually happen: a dancer canvas may not be blank.
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('.window.kind-sequence canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let filled = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) filled++;
    return filled / (data.length / 4);
  });
  assert.ok(painted > 0.03, `a dancer is drawn (${(painted * 100).toFixed(1)}% of the window)`);

  const frames = await page.evaluate(() => new Promise(resolve => {
    let n = 0;
    const start = performance.now();
    const tick = () => { n++; if (performance.now() - start < 2000) requestAnimationFrame(tick); else resolve(n / 2); };
    requestAnimationFrame(tick);
  }));
  console.log(`Windows on screen: ${await count('.window')}, about ${Math.round(frames)} pictures per second.`);

  await say('clear the desktop', 'Desktop cleared.');
  assert.equal(await count('.window.kind-sequence'), 0);
  assert.deepEqual(problems, [], 'no errors on the page');
  console.log('UI run passed.');
} catch (error) {
  console.error(`UI run FAILED: ${error.message}`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  const switchedOff = leftSwitchedOff(before);
  for (const problem of switchedOff) console.error(`Problem: ${problem}`);
  if (switchedOff.length) process.exitCode = 1;
}
