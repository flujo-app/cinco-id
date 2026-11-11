// Checks the app's sturdiness in the real desktop shell, each with its own data folder:
//   1. port in use: another program holds the port, the app starts anyway and says so,
//   2. only one copy: starting it a second time does not start a second copy,
//   3. quitting while a new dancer is being made asks first (Keep running / Quit), using a
//      stand-in for the dancer tools that makes nothing and costs nothing,
//   4. the next start clears the half-made dancer away,
//   5. a start-up problem (a broken settings file) shows a plain error window and leaves nothing
//      running; the window is closed politely by this check.
// Usage: node test/ui/sturdy-check.mjs [--exe <packaged CINCO ID.exe>]
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { freePort, launchOptions, root, takeOption } from './launch.mjs';
import { closeWindow, dialogsOf, leftSwitchedOff, windows } from './desktop.mjs';

const args = process.argv.slice(2);
const exe = takeOption(args, '--exe');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-sturdy-'));
const dataDir = path.join(temp, 'data');
const OUR_PROGRAMS = new Set(['electron', 'CINCO ID']);
const before = windows();
const problems = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// A stand-in for the dancer tools: reports one step, then takes its time and makes nothing.
const slow = path.join(temp, 'slow-generate.mjs');
await fs.writeFile(slow, 'console.log(JSON.stringify({ stage: "image", progress: 0.1, message: "Drawing (stand-in)" })); setTimeout(() => {}, 120000);\n');
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(path.join(dataDir, 'harness.config.json'), JSON.stringify({
  operator: 'Paul', media: { python: process.execPath, script: slow }, voice: { tts: { engine: 'browser' } },
}, null, 2));

/** Starts the app without playwright, the way a person would start it a second time. */
function startPlain(extraArgs, env) {
  const command = exe ? path.resolve(exe) : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(command, [...(exe ? [] : ['.']), ...extraArgs], { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' });
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ child, exited: false }), 20000);
    child.on('exit', code => { clearTimeout(timer); resolve({ child, exited: true, code }); });
  });
}

const busy = net.createServer();
let app = null;
try {
  // 1. Another program holds the port.
  const port = await freePort(19790);
  await new Promise(resolve => busy.listen(port, '127.0.0.1', resolve));
  app = await electron.launch(launchOptions({ exe, port, dataDir }));
  let page = await app.firstWindow();
  await page.waitForFunction(p => (document.querySelector('.console-log')?.textContent ?? '').includes(`Port ${p} is used by another program`), port, { timeout: 15000 });
  console.log(`1. Port ${port} was busy: the app started anyway and said so in the console window.`);

  // 2. A second start does not make a second copy.
  const second = await startPlain([`--port=${port}`, '--silent', '--no-tray', '--no-print', '--no-setup'], { CINCO_ID_DATA_DIR: dataDir });
  if (!second.exited) { second.child.kill(); throw new Error('A second copy kept running.'); }
  await page.waitForFunction(() => /CINCO ID was started again/.test(document.querySelector('.console-log')?.textContent ?? ''), null, { timeout: 8000 });
  console.log(`2. Starting it again ended at once (code ${second.code}); the running copy came to the front.`);

  // 3. Quitting while a new dancer is being made.
  await page.fill('.console-row input', 'generate a new sequence of a test dancer in a paper hat');
  await page.press('.console-row input', 'Enter');
  await page.locator('.window.kind-progress').waitFor({ timeout: 10000 });
  const half = path.join(dataDir, 'projects', '4d3d3d3', 'sequences');
  const making = (await fs.readdir(half)).find(name => existsSync(path.join(half, name, '.generating')));
  assert.ok(making, 'the new dancer\'s folder is marked as being made');
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
  const question = page.locator('.window.kind-dialog');
  await question.waitFor({ timeout: 8000 });
  const text = await question.locator('.dialog-text').textContent();
  assert.equal(text, 'A new sequence is still being generated. If you quit now it will be lost. Quit anyway?');
  await question.locator('button:has-text("Keep running")').click();
  await wait(1500);
  assert.equal(await page.locator('.window.kind-progress').count(), 1, 'Keep running: still running, still making it');
  console.log(`3. Quit while "${making}" was being made asked first; Keep running kept it.`);
  const exited = new Promise(resolve => app.process().once('exit', resolve));
  await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
  await question.waitFor({ timeout: 8000 });
  await question.locator('button:has-text("Quit")').click();
  await Promise.race([exited, wait(15000).then(() => { throw new Error('The app did not quit after Quit.'); })]);
  app = null;
  console.log('   Quit then closed it.');

  // 4. The next start clears the half-made dancer away.
  busy.close();
  app = await electron.launch(launchOptions({ exe, port: await freePort(19790), dataDir }));
  page = await app.firstWindow();
  await page.waitForFunction(() => /still being made when the computer last stopped/.test(document.querySelector('.console-log')?.textContent ?? ''), null, { timeout: 15000 });
  assert.ok(!existsSync(path.join(half, making)), 'the half-made folder is gone');
  console.log(`4. The next start removed the half-made "${making}" and said so.`);
  await app.close();
  app = null;

  // 5. A broken settings file: a plain error window, then nothing left running.
  const broken = path.join(temp, 'broken');
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, 'harness.config.json'), '{ this is not right');
  const dialogsBefore = new Set(dialogsOf(windows(), OUR_PROGRAMS).map(window => window.handle));
  const failing = startPlain([`--port=${await freePort(19790)}`, '--silent', '--no-tray', '--no-print'], { CINCO_ID_DATA_DIR: broken });
  let shown = null;
  for (let i = 0; i < 30 && !shown; i++) {
    await wait(500);
    shown = dialogsOf(windows(), OUR_PROGRAMS).find(window => !dialogsBefore.has(window.handle)) ?? null;
  }
  assert.ok(shown, 'an error window appeared');
  console.log(`5. A broken settings file showed: "${shown.title}"`);
  assert.equal(shown.title, 'CINCO ID could not start');
  closeWindow(shown.handle);
  const ended = await failing;
  assert.ok(ended.exited, 'after the error window, nothing is left running');
  console.log(`   After closing it the program ended (code ${ended.code}).`);
} catch (error) {
  problems.push(error.message);
} finally {
  busy.close();
  const left = dialogsOf(windows(), OUR_PROGRAMS).filter(window => !before.some(old => old.handle === window.handle));
  for (const window of left) { closeWindow(window.handle); problems.push(`A Windows dialog was left open and was closed: ${window.title}`); }
  await wait(left.length ? 2000 : 0);
  await app?.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
problems.push(...leftSwitchedOff(before));
for (const problem of problems) console.error(`Problem: ${problem}`);
console.log(problems.length ? 'Sturdiness check FAILED.' : 'Sturdiness check passed.');
process.exitCode = problems.length ? 1 : 0;
