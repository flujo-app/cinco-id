// Drives the WhatsApp page of the Setup window in the real app, with a temporary data folder.
//
// Default (no account, no network): a stand-in for the WhatsApp connector (test/helpers/whatsapp-stand-in),
// served from a local git folder so the real Install button can fetch and build it:
//   1. "link whatsapp" in the console opens Setup on the WhatsApp page,
//   2. Install (stand-in), Link, the QR code is shown large, the phone "scans" it, it says Linked by itself,
//   3. Test call window, then a real signed call from the stand-in: the call window shows the caller,
//      Decline reaches the stand-in,
//   4. Unlink (asks first), Link again, and quitting stops the connector,
//   5. the secret appears nowhere: not on the screen, not in the console, not in any log.
//
// --real <folder>   starts the REAL connector from that folder (read only) with a brand-new
//                   temporary sign-in folder, waits for a real QR code on the page, never scans it,
//                   then stops it. Nothing is changed in that folder.
// --real-install    presses the real Install button (fetches the pinned version from GitHub into the
//                   temporary data folder and builds it), then checks that the copy offers a QR code.
// --exe <CINCO ID.exe>  uses a packaged copy instead of this folder.  --shots <folder> keeps pictures.
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { freePort, launchOptions, takeOption } from './launch.mjs';
import { dialogsOf, leftSwitchedOff, windows } from './desktop.mjs';
import { alive, readRecord, signal, standInConnector, waitFor } from '../helpers/whatsapp.js';

const args = process.argv.slice(2);
const exe = takeOption(args, '--exe');
const real = takeOption(args, '--real');
const realInstall = args.includes('--real-install');
const shots = takeOption(args, '--shots');
const mode = real ? 'real' : realInstall ? 'real-install' : 'stand-in';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-whatsapp-ui-'));
const dataDir = path.join(temp, 'data');
const work = path.join(dataDir, 'whatsapp');
const before = windows();
const problems = [];
const output = [];
let shot = 0;

/** The node.exe programs this app started (the connector): every node.exe below the app's own process. */
function childNodes(rootPid) {
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }'], { encoding: 'utf8' });
  const rows = text.split(/\r?\n/).filter(Boolean).map(line => { const [pid, parent, name] = line.split(','); return { pid: Number(pid), parent: Number(parent), name }; });
  const below = new Set([Number(rootPid)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!below.has(row.pid) && below.has(row.parent)) { below.add(row.pid); grew = true; }
  }
  return rows.filter(row => row.pid !== Number(rootPid) && below.has(row.pid) && /^node(\.exe)?$/i.test(row.name)).map(row => row.pid);
}
function gitState(dir) {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' });
}

const settings = { operator: 'Paul', voice: { tts: { engine: 'browser' } }, whatsapp: { lookNextDoor: false } };
const env = { CINCO_ID_CONFIG: null, CINCO_ID_OPERATOR: null };
let realBefore = null;
if (mode === 'stand-in') {
  // A local "GitHub" holding the stand-in, so Install runs its real steps without any network.
  const repo = path.join(temp, 'repo');
  await standInConnector(repo);
  await fs.rm(path.join(repo, 'dist'), { recursive: true });
  const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'stand-in');
  Object.assign(env, { CINCO_ID_WHATSAPP_INSTALL_FROM: repo, CINCO_ID_WHATSAPP_COMMIT: git('rev-parse', 'HEAD') });
} else if (mode === 'real') {
  const dir = path.resolve(real);
  if (!existsSync(path.join(dir, 'dist', 'index.js'))) { console.error(`No built connector in ${dir}.`); process.exit(1); }
  settings.whatsapp.connectorDir = dir;
  realBefore = { dir, git: gitState(dir), log: await fs.stat(path.join(dir, 'logs', 'mcp-whatsapp.log')).then(info => info.mtimeMs, () => null) };
}
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(path.join(dataDir, 'harness.config.json'), JSON.stringify(settings, null, 2));

const app = await electron.launch(launchOptions({ exe, port: await freePort(19801), dataDir, env }));
app.process().stdout?.on('data', chunk => output.push(String(chunk)));
app.process().stderr?.on('data', chunk => output.push(String(chunk)));
const appPid = app.process().pid;
let connectorPids = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  await page.waitForSelector('.console-log');
  const setup = page.locator('.window.kind-setup');
  const picture = async name => { if (!shots) return; await fs.mkdir(shots, { recursive: true }); await setup.screenshot({ path: path.join(shots, `${mode}-${String(++shot).padStart(2, '0')}-${name}.png`) }); };
  const status = () => setup.locator('[data-role=whatsapp-status]').textContent();
  const role = name => setup.locator(`button[data-role=${name}]`);
  const consoleText = () => page.locator('.console-log').textContent();

  // 1. Saying it opens the right page.
  await page.fill('.console-row input', 'link whatsapp');
  await page.press('.console-row input', 'Enter');
  await setup.waitFor({ timeout: 10000 });
  assert.equal((await setup.locator('.setup-steps li.current').textContent()).trim(), 'WhatsApp', 'Setup opened on the WhatsApp page');
  console.log('"link whatsapp" opened Setup on the WhatsApp page.');
  await page.waitForFunction(() => !/checking/.test(document.querySelector('.kind-setup .setup-facts')?.textContent ?? 'checking'), null, { timeout: 20000 });
  console.log(`This PC: ${(await setup.locator('.setup-facts').textContent()).replace(/\s+/g, ' ').trim()}`);
  await picture('page');

  // 2. Install (stand-in or the real one).
  if (mode !== 'real') {
    await role('whatsapp-install').waitFor({ state: 'visible', timeout: 10000 });
    console.log('Pressing Install...');
    const startedAt = Date.now();
    await role('whatsapp-install').click();
    let last = '';
    await waitFor(async () => {
      const text = await setup.locator('[data-role=whatsapp-install-status]').textContent();
      if (text !== last) { last = text; console.log(`  ${text.split('\n')[0]}`); }
      if (/did not work|not used|was not found|is not on this PC/.test(text)) throw new Error(`Install failed: ${text}`);
      return /is installed\./.test(text);
    }, { timeoutMs: mode === 'real-install' ? 30 * 60_000 : 120_000, stepMs: 1000, what: 'Install to finish' });
    console.log(`Install finished in ${Math.round((Date.now() - startedAt) / 1000)} s: ${last}`);
    const installed = JSON.parse(await fs.readFile(path.join(work, 'connector', 'package.json'), 'utf8'));
    console.log(`Installed copy: ${installed.name} ${installed.version} in ${path.join(work, 'connector')}`);
    await picture('installed');
  }

  // 3. Link: a QR code, large enough for a phone.
  await role('whatsapp-link').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.kind-setup button[data-role=whatsapp-link]')?.disabled === false, null, { timeout: 15000 });
  await role('whatsapp-link').click();
  const qr = setup.locator('img.whatsapp-qr');
  await page.waitForFunction(() => {
    const img = document.querySelector('.kind-setup img.whatsapp-qr');
    return img?.getAttribute('src')?.startsWith('data:image/png;base64,') && img.complete && img.naturalWidth > 0;
  }, null, { timeout: mode === 'stand-in' ? 15000 : 120000 });
  const box = await qr.boundingBox();
  const natural = await qr.evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight, src: img.src }));
  const png = Buffer.from(natural.src.split(',')[1], 'base64');
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a real PNG picture');
  assert.ok(box.width >= 220 && box.height >= 220, `shown large enough to scan (${Math.round(box.width)} x ${Math.round(box.height)})`);
  console.log(`QR code shown: a ${natural.width} x ${natural.height} PNG, drawn at ${Math.round(box.width)} x ${Math.round(box.height)} on the page. Status: "${await status()}"`);
  await picture('qr');
  connectorPids = childNodes(appPid);
  console.log(`The connector runs as a child of the app (process ${connectorPids.join(', ') || 'none found'}).`);
  assert.ok(connectorPids.length >= 1, 'the connector is a child of the app');
  const session = (await page.evaluate(() => fetch('/api/setup/whatsapp').then(r => r.json()))).signInFolder;
  assert.equal(session, path.join(work, 'session'), 'its sign-in folder is inside the data folder');

  if (mode === 'stand-in') {
    // The QR code changes while it waits; the page follows.
    const firstCode = natural.src;
    await page.waitForFunction(first => document.querySelector('.kind-setup img.whatsapp-qr')?.src !== first, firstCode, { timeout: 15000 });
    console.log('The QR code was refreshed on the page while waiting.');

    // 4. The phone "scans" it: Linked, by itself.
    await signal(session, 'scan');
    await page.waitForFunction(() => /^Linked\./.test(document.querySelector('.kind-setup [data-role=whatsapp-status]')?.textContent ?? ''), null, { timeout: 10000 });
    assert.equal(await qr.isVisible(), false, 'the code goes away');
    console.log(`After the "scan": "${await status()}"`);
    await page.waitForFunction(() => /WhatsApp is linked\./.test(document.querySelector('.console-log')?.textContent ?? ''), null, { timeout: 5000 });
    console.log('The console window says: WhatsApp is linked. Incoming calls show up here.');
    await picture('linked');

    // 5. Test call window, then a real call through the stand-in.
    await role('whatsapp-test-call').click();
    const call = page.locator('.window.kind-call');
    await call.waitFor({ timeout: 5000 });
    assert.match(await call.locator('.call-name').textContent(), /Test Caller/);
    await call.locator('button:has-text("Dismiss")').click();
    await page.waitForFunction(() => !document.querySelector('.window.kind-call'), null, { timeout: 4000 });
    console.log('"Test call window" showed the test call.');

    await signal(work, 'ring.json', { callId: 'CALL-UI-1', name: 'Anna Example', number: '15550100123' });
    await call.waitFor({ timeout: 8000 });
    assert.equal(await call.locator('.call-name').textContent(), 'Anna Example');
    assert.equal(await call.locator('.call-number').textContent(), '+15550100123');
    await page.waitForFunction(() => document.querySelector('.kind-call button:nth-child(2)')?.disabled === false, null, { timeout: 5000 });
    await picture('call');
    await call.locator('button:has-text("Decline")').click();
    await waitFor(() => readRecord(work, 'stand-in-rejected.json'), { what: 'Decline to reach the stand-in' });
    assert.deepEqual(await readRecord(work, 'stand-in-rejected.json'), [{ callId: 'CALL-UI-1' }]);
    await page.waitForFunction(() => !document.querySelector('.window.kind-call'), null, { timeout: 4000 });
    console.log('A signed call from the stand-in showed "Anna Example, +15550100123"; Decline reached the stand-in.');

    // 6. Unlink, asking first.
    await role('whatsapp-unlink').click();
    await setup.locator('.setup-confirm').waitFor({ state: 'visible', timeout: 3000 });
    await picture('unlink-question');
    await role('whatsapp-unlink-yes').click();
    await page.waitForFunction(() => /not linked/.test(document.querySelector('.kind-setup [data-role=whatsapp-status]')?.textContent ?? ''), null, { timeout: 10000 });
    assert.equal((await readRecord(work, 'stand-in-logouts.json'))?.length, 1, 'the connector signed out');
    console.log(`Unlink asked first, then: "${await status()}"`);
    const file = JSON.parse(await fs.readFile(path.join(dataDir, 'harness.config.json'), 'utf8'));
    assert.equal(file.whatsapp.enabled, false);

    // 7. Link again, then quit: the connector must not outlive the app.
    await role('whatsapp-link').click();
    await page.waitForFunction(() => document.querySelector('.kind-setup img.whatsapp-qr')?.naturalWidth > 0, null, { timeout: 15000 });
    connectorPids = childNodes(appPid);

    // 8. The secret is nowhere to be seen.
    const secret = await fs.readFile(path.join(work, 'stand-in-secret.txt'), 'utf8');
    const seen = [await page.content(), await consoleText(), output.join('')];
    for (const route of ['/api/state', '/api/settings', '/api/setup/whatsapp?qr=1']) seen.push(await page.evaluate(url => fetch(url).then(r => r.text()), route));
    for (const name of await fs.readdir(path.join(work, 'logs'))) seen.push(await fs.readFile(path.join(work, 'logs', name), 'utf8'));
    assert.ok(secret.startsWith('whsec_') && !seen.join('\n').includes(secret) && !seen.join('\n').includes(secret.slice(6, 30)), 'the secret never shows');
    console.log('The secret is not on the screen, in the console window, in the app\'s output or in the connector\'s log.');
  } else {
    // Real connector: never scanned. Stop it again.
    assert.match(await status(), /scan the code|Connecting|Starting/);
    await role('whatsapp-stop').click();
    await page.waitForFunction(() => /not linked/.test(document.querySelector('.kind-setup [data-role=whatsapp-status]')?.textContent ?? ''), null, { timeout: 15000 });
    console.log(`"Stop linking": "${await status()}"`);
    await waitFor(() => connectorPids.every(pid => !alive(pid)), { timeoutMs: 15000, what: 'the real connector to stop' });
    console.log('The real connector stopped.');
    assert.ok(existsSync(path.join(work, 'session')), 'the brand-new sign-in folder was in the temporary data folder');
  }
  assert.deepEqual(problems, [], 'no errors on the page');
} catch (error) {
  problems.push(error.message);
} finally {
  const dialogs = dialogsOf(windows(), new Set(['electron', 'CINCO ID'])).filter(window => !before.some(old => old.handle === window.handle));
  if (dialogs.length) problems.push(`A Windows dialog was left open: ${dialogs.map(window => window.title).join(', ')}`);
  else await app.close().catch(() => {});
  try {
    await waitFor(() => connectorPids.every(pid => !alive(pid)), { timeoutMs: 15000, what: 'the connector to end' });
    if (connectorPids.length) console.log(`After quitting, the connector (process ${connectorPids.join(', ')}) is gone.`);
  } catch { problems.push(`The connector kept running after the app quit (process ${connectorPids.join(', ')}).`); }
  if (realBefore) {
    if (gitState(realBefore.dir) !== realBefore.git) problems.push('The read-only connector folder was changed.');
    const log = await fs.stat(path.join(realBefore.dir, 'logs', 'mcp-whatsapp.log')).then(info => info.mtimeMs, () => null);
    if (log !== realBefore.log) problems.push('The read-only connector folder\'s own log was written to.');
    else console.log('The read-only connector folder was not changed (same git state, its own log untouched).');
  }
  await fs.rm(temp, { recursive: true, force: true }).catch(error => problems.push(`The temporary folder could not be removed: ${error.message}`));
  if (!existsSync(temp)) console.log('The temporary data folder (with its sign-in folder) was deleted.');
}
problems.push(...leftSwitchedOff(before));
for (const problem of problems) console.error(`Problem: ${problem}`);
console.log(problems.length ? `WhatsApp check (${mode}) FAILED.` : `WhatsApp check (${mode}) passed.`);
process.exitCode = problems.length ? 1 : 0;
