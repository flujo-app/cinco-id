// Checks real printing on Windows: asks for a printout and waits for the PDF printer's
// "save as" window, which proves the job went through the Windows print system.
//
// It also guards against a nasty side effect: Windows switches the window that "owns" such a
// dialog off for mouse clicks while the dialog is open. The check therefore makes sure that
//   - the dialog belongs to this app's own printing window, not to some other program, and
//   - no window on the PC is left switched off afterwards (if one is, it is switched back on
//     and the check fails).
// The dialog is closed politely and the app is only stopped after it is gone.
// Usage: node test/ui/print-check.mjs [--exe <packaged CINCO ID.exe>]
import { _electron as electron } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { launchOptions, takeOption } from './launch.mjs';
import { closeWindow, dialogsOf, leftSwitchedOff, windows } from './desktop.mjs';

const args = process.argv.slice(2);
const exe = takeOption(args, '--exe');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-print-'));

const PRINT_PROGRAMS = new Set(['electron', 'CINCO ID', 'splwow64', 'PrintIsolationHost']);
const OUR_PROGRAMS = new Set(['electron', 'CINCO ID']);

const before = windows();
const dialogsBefore = new Set(dialogsOf(before, PRINT_PROGRAMS).map(window => window.handle));
const app = await electron.launch(launchOptions({
  exe, port: 19785, print: true, dataDir: path.join(temp, 'data'),
  env: { CINCO_ID_CONFIG: 'none', CINCO_ID_OPERATOR: 'Paul' },
}));
const problems = [];
let dialog = null;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.console-log');
  await page.fill('.console-row input', 'give me a printout of Oyster smiling');
  await page.press('.console-row input', 'Enter');
  await page.waitForFunction(() => /^Sent to /.test(document.querySelector('.kind-printout .status-line')?.textContent ?? ''), null, { timeout: 12000 });
  console.log(`The app says: ${await page.locator('.kind-printout .status-line').textContent()}`);

  for (let attempt = 0; attempt < 25 && !dialog; attempt++) {
    await page.waitForTimeout(800);
    dialog = dialogsOf(windows(), PRINT_PROGRAMS).find(window => !dialogsBefore.has(window.handle)) ?? null;
  }
  if (!dialog) {
    problems.push('No print window appeared within 20 seconds.');
  } else {
    console.log(`Windows opened its print window: "${dialog.title}" (attached to a window of: ${dialog.ownerProgram || 'nothing'})`);
    if (dialog.ownerProgram && !OUR_PROGRAMS.has(dialog.ownerProgram)) {
      problems.push(`The print window attached itself to another program (${dialog.ownerProgram}); that program cannot be clicked while it is open.`);
    }
    // Close it politely and wait until it is really gone before stopping the app.
    closeWindow(dialog.handle);
    let gone = false;
    for (let attempt = 0; attempt < 20 && !gone; attempt++) {
      await page.waitForTimeout(500);
      gone = !windows().some(window => window.handle === dialog.handle);
    }
    if (!gone) problems.push('The print window did not close.');
    await page.waitForTimeout(1500); // let Windows hand control back to the owner window
  }
} catch (error) {
  problems.push(error.message);
} finally {
  await app.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}

// Nothing on the PC may be left switched off for clicks because of this check.
await new Promise(resolve => setTimeout(resolve, 1000));
problems.push(...leftSwitchedOff(before));

for (const problem of problems) console.error(`Problem: ${problem}`);
console.log(problems.length ? 'Print check FAILED.' : 'Print check passed.');
process.exitCode = problems.length ? 1 : 0;
