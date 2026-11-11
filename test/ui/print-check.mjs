// Checks real printing on Windows: asks for a printout and waits for the PDF printer's
// "save as" window, which proves the job went through the Windows print system.
//
// It also guards against a nasty side effect: Windows switches the window that "owns" such a
// dialog off for mouse clicks while the dialog is open. The check therefore makes sure that
//   - the dialog belongs to this app's own printing window, not to some other program, and
//   - no window on the PC is left switched off afterwards (if one is, it is switched back on
//     and the check fails).
// The dialog is closed politely and the app is only stopped after it is gone.
// Usage: node test/ui/print-check.mjs
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-print-'));

const NATIVE = `
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class Wins {
  public delegate bool Proc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnableWindow(IntPtr h, bool on);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Name(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }
  // Visible top-level windows as "handle|program|enabled|class|title|ownerHandle|ownerProgram"
  public static List<string> All() {
    var rows = new List<string>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(64); GetClassName(h, cls, 64);
      var title = new StringBuilder(128); GetWindowText(h, title, 128);
      IntPtr owner = GetWindow(h, 4);
      rows.Add(h.ToInt64() + "|" + Name(h) + "|" + (IsWindowEnabled(h) ? "1" : "0") + "|" + cls + "|" + title.ToString().Replace("|", " ") + "|" + owner.ToInt64() + "|" + (owner == IntPtr.Zero ? "" : Name(owner)));
      return true; }, IntPtr.Zero);
    return rows; }
  public static void Close(long h) { PostMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero); }
  public static bool SwitchOn(long h) { var p = new IntPtr(h); if (!IsWindow(p)) return false; EnableWindow(p, true); return IsWindowEnabled(p); }
}
"@
`;
function native(call) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${NATIVE}\n${call}`], { encoding: 'utf8' })
    .split('\n').map(line => line.trim()).filter(Boolean);
}
function windows() {
  return native('[Wins]::All() -join [char]10').map(line => {
    const [handle, program, enabled, className, title, owner, ownerProgram] = line.split('|');
    return { handle, program, enabled: enabled === '1', className, title, owner, ownerProgram };
  });
}
const PRINT_PROGRAMS = new Set(['electron', 'splwow64', 'PrintIsolationHost']);
const printDialogs = list => list.filter(window => window.className === '#32770' && PRINT_PROGRAMS.has(window.program));

const before = windows();
const dialogsBefore = new Set(printDialogs(before).map(window => window.handle));
const app = await electron.launch({
  args: ['.', '--port=19785', '--silent', '--no-tray'],
  cwd: root,
  env: { ...process.env, CINCO_ID_CONFIG: 'none', CINCO_ID_OPERATOR: 'Paul', CINCO_ID_STATE_DIR: path.join(temp, 'state'), CINCO_ID_PRINTOUTS_DIR: path.join(temp, 'printouts') },
});
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
    dialog = printDialogs(windows()).find(window => !dialogsBefore.has(window.handle)) ?? null;
  }
  if (!dialog) {
    problems.push('No print window appeared within 20 seconds.');
  } else {
    console.log(`Windows opened its print window: "${dialog.title}" (attached to a window of: ${dialog.ownerProgram || 'nothing'})`);
    if (dialog.ownerProgram && dialog.ownerProgram !== 'electron') {
      problems.push(`The print window attached itself to another program (${dialog.ownerProgram}); that program cannot be clicked while it is open.`);
    }
    // Close it politely and wait until it is really gone before stopping the app.
    native(`[Wins]::Close(${dialog.handle})`);
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
const wasEnabled = new Map(before.filter(window => window.enabled).map(window => [window.handle, window]));
for (const window of windows()) {
  if (!window.enabled && wasEnabled.has(window.handle)) {
    const fixed = native(`[Wins]::SwitchOn(${window.handle})`).at(-1) === 'True';
    problems.push(`The window "${window.title}" of ${window.program} was left switched off for clicks${fixed ? ' (switched back on)' : ' and could NOT be switched back on'}.`);
  }
}

for (const problem of problems) console.error(`Problem: ${problem}`);
console.log(problems.length ? 'Print check FAILED.' : 'Print check passed.');
process.exitCode = problems.length ? 1 : 0;
