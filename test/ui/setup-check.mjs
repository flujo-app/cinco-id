// Drives the Setup window in the real app, the way a person would on the first start:
//   1. starts a copy with an empty data folder: Setup opens by itself and the greeting waits,
//   2. changes the name and the voice, tries "Say something",
//   3. presses "Sign in to Modal" and "Prepare..." with a stand-in for Modal's tools (a small
//      fake "modal" package put first on Python's search path), so no browser opens and
//      nothing in the cloud is used or paid for; Prepare is first answered with No, then with Yes,
//   4. finishes, and checks the settings file in the data folder and the greeting with the new name,
//   5. starts the copy again: no Setup this time, the name and voice stayed; "setup" reopens it.
// Usage: node test/ui/setup-check.mjs [--exe <packaged CINCO ID.exe>] [--python <python.exe>] [--shots <folder for pictures>]
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { freePort, launchOptions, takeOption } from './launch.mjs';
import { dialogsOf, leftSwitchedOff, windows } from './desktop.mjs';

const args = process.argv.slice(2);
const exe = takeOption(args, '--exe');
let python = takeOption(args, '--python');
const shots = takeOption(args, '--shots');
let shot = 0;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-setup-'));
const dataDir = path.join(temp, 'data');
const standIn = path.join(temp, 'stand-in');
const NAME = 'Ingrid';
const VOICE = 'Microsoft Zira Desktop';

// The stand-in for Modal: "python -m modal setup" prints what the real sign-in prints when it
// worked; anything else that touches it (the dancer tools) fails at once.
await fs.mkdir(path.join(standIn, 'modal'), { recursive: true });
await fs.writeFile(path.join(standIn, 'modal', '__init__.py'), [
  'STANDIN = True',
  'def __getattr__(name):',
  '    raise RuntimeError("This is a stand-in for Modal in a test; nothing was sent to the cloud.")',
  '',
].join('\n'));
await fs.writeFile(path.join(standIn, 'modal', '__main__.py'), 'print("Web authentication finished successfully! (stand-in, nothing was signed in)")\n');
python ??= execFileSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
const env = { PYTHONPATH: standIn, MODAL_CONFIG_PATH: path.join(temp, 'no-modal.toml'), CINCO_ID_OPERATOR: null, CINCO_ID_CONFIG: null };
// Safety first: make sure this Python really picks up the stand-in and not a real Modal.
const found = execFileSync(python, ['-c', 'import modal; print(modal.__file__); print(modal.STANDIN)'], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: standIn } }).trim().split(/\r?\n/);
if (!found[0].startsWith(standIn) || found[1] !== 'True') { console.error(`The stand-in for Modal is not used (${found[0]}); stopping before anything starts.`); process.exit(1); }

const before = windows();
const problems = [];
const launch = async () => electron.launch(launchOptions({ exe, port: await freePort(19786), dataDir, setup: true, env }));

let app = await launch();
try {
  let page = await app.firstWindow();
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  const setup = page.locator('.window.kind-setup');
  await setup.waitFor({ timeout: 15000 });
  console.log('First start: the Setup window opened by itself.');
  assert.equal(await page.locator('.console-log .computer').count(), 0, 'the greeting waits until Setup is closed');
  const picture = async name => { if (!shots) return; await fs.mkdir(shots, { recursive: true }); await setup.screenshot({ path: path.join(shots, `${String(++shot).padStart(2, '0')}-${name}.png`) }); };
  const next = async () => { await picture(`page-${shot + 1}`); await setup.locator('button[data-role=next]').click(); };
  const status = () => setup.locator('.setup-status').first().textContent();

  // 1. Name
  await setup.locator('input[name=operator]').fill(NAME);
  await next();

  // 2. Voice
  const zira = setup.locator(`input[name=voice][value="windows:${VOICE}"]`);
  await zira.waitFor({ timeout: 20000 });
  await zira.check();
  await setup.locator('button[data-role=say-something]').click();
  await page.waitForFunction(() => !/Speaking/.test(document.querySelector('.kind-setup .setup-status')?.textContent ?? 'Speaking'), null, { timeout: 30000 });
  const spoke = await status();
  console.log(`"Say something": ${spoke}`);
  assert.match(spoke, /voice works/, 'the test sentence was made');

  // 3. Listening (left off), brain (left at none)
  await next();
  assert.equal(await setup.locator('input[name=ears][value=off]').isChecked(), true);
  await next();
  await setup.locator('input[name=brain][value=none]').check();
  await next();

  // 4. New dancers, with the stand-in for Modal
  await setup.locator('input[name=mediaPython]').fill(python);
  await setup.locator('button[data-role=modal-login]').click();
  await page.waitForFunction(() => /Signed in to Modal|stopped|Could not/.test(document.querySelector('.kind-setup .setup-status')?.textContent ?? ''), null, { timeout: 30000 });
  const login = await status();
  console.log(`"Sign in to Modal" (stand-in): ${login.replace(/\n/g, ' | ')}`);
  assert.match(login, /Signed in to Modal/);
  assert.match(login, /stand-in/);

  await setup.locator('button[data-role=prepare]').click();
  const confirm = await setup.locator('.setup-page').textContent();
  console.log(`"Prepare..." asks first: ${confirm.replace(/\s+/g, ' ').slice(0, 260)}`);
  assert.match(confirm, /costs about \$[\d.]+/, 'the cost is shown before anything starts');
  assert.match(confirm, /about \d+( to \d+)? minutes/, 'the time is shown too');
  await setup.locator('button[data-role=prepare-no]').click();
  const afterNo = await page.evaluate(() => fetch('/api/setup/task?name=prepare').then(r => r.json()));
  assert.equal(afterNo.ok, null, 'No started nothing');
  assert.equal(afterNo.running, false);
  await setup.locator('button[data-role=prepare]').click();
  await setup.locator('button[data-role=prepare-yes]').click();
  let prepared = null;
  for (let waited = 0; waited < 60 && prepared?.ok == null; waited++) {
    await page.waitForTimeout(1000);
    prepared = await page.evaluate(() => fetch('/api/setup/task?name=prepare').then(r => r.json()));
  }
  console.log(`"Prepare" after Yes (stand-in): ${prepared.message}`);
  assert.equal(prepared.ok, false, 'with the stand-in the dancer tools stop at once');
  assert.match(prepared.message, /stand-in/, 'and say why, in plain words');
  await next();

  // 5. Finish
  const summary = await setup.locator('.setup-summary').textContent();
  assert.match(summary, new RegExp(NAME));
  assert.match(summary, new RegExp(VOICE));
  await picture('summary');
  await setup.locator('button[data-role=finish]').click();
  await setup.locator('button[data-role=close]').waitFor({ timeout: 15000 });
  console.log(`After Finish: ${(await setup.locator('.setup-page').textContent()).replace(/\s+/g, ' ').trim()}`);
  const file = JSON.parse(await fs.readFile(path.join(dataDir, 'harness.config.json'), 'utf8'));
  assert.equal(file.operator, NAME, 'the settings file was written in the data folder');
  assert.deepEqual(file.voice.tts, { engine: 'windows', voice: VOICE });
  assert.equal(file.media.python, path.normalize(python));
  console.log(`Settings file written: ${path.join(dataDir, 'harness.config.json')}`);
  await setup.locator('button[data-role=close]').click();
  await page.waitForFunction(name => [...document.querySelectorAll('.console-log .computer')].some(line => new RegExp(`^Good \\w+, ${name}\\.`).test(line.textContent)), NAME, { timeout: 8000 });
  console.log(`Greeting: ${await page.locator('.console-log .computer').last().textContent()}`);
  assert.equal(await setup.count(), 0, 'Setup is closed');
  await app.close();

  // Second start: no Setup, the name and the voice stayed.
  app = await launch();
  page = await app.firstWindow();
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  await page.waitForFunction(name => /first sequence of the day/.test(document.querySelector('.console-log')?.textContent ?? '') && document.querySelector('.console-log').textContent.includes(name), NAME, { timeout: 10000 });
  assert.equal(await page.locator('.window.kind-setup').count(), 0, 'Setup does not open again');
  const shown = await page.evaluate(() => fetch('/api/settings').then(r => r.json()));
  assert.equal(shown.voice.tts.voice, VOICE);
  console.log('Second start: no Setup, greeting and voice kept.');
  await page.fill('.console-row input', 'setup');
  await page.press('.console-row input', 'Enter');
  await page.locator('.window.kind-setup').waitFor({ timeout: 5000 });
  await page.locator('.window.kind-setup button[data-role=cancel]').click();
  await page.waitForFunction(() => !document.querySelector('.window.kind-setup'), null, { timeout: 4000 });
  console.log('Typing "setup" opened it again; Cancel closed it.');
  assert.deepEqual(problems, [], 'no errors on the page');
} catch (error) {
  problems.push(error.message);
} finally {
  const dialogs = dialogsOf(windows(), new Set(['electron', 'CINCO ID'])).filter(window => !before.some(old => old.handle === window.handle));
  if (dialogs.length) problems.push(`A Windows dialog was left open: ${dialogs.map(window => window.title).join(', ')}`);
  else await app.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
problems.push(...leftSwitchedOff(before));
for (const problem of problems) console.error(`Problem: ${problem}`);
console.log(problems.length ? 'Setup check FAILED.' : 'Setup check passed.');
process.exitCode = problems.length ? 1 : 0;
