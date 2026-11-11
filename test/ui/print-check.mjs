// Checks real printing on Windows: asks for a printout and waits for the PDF printer's
// "save as" window to appear, which proves the job went through the Windows print system.
// The window is then closed again, so nothing is saved and nothing is left open.
// Usage: node test/ui/print-check.mjs
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'beta-sequence-print-'));

/** Lists visible dialog windows as "title|program"; with `close`, asks matching ones to close. */
function dialogs(close = false) {
  const script = `
    Add-Type @"
    using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
    public class Wins {
      public delegate bool Proc(IntPtr h, IntPtr p);
      [DllImport("user32.dll")] public static extern bool EnumWindows(Proc cb, IntPtr p);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
      [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
      [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
      [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
      public static List<string> Find(bool close) {
        var found = new List<string>();
        EnumWindows((h, p) => {
          if (!IsWindowVisible(h)) return true;
          var cls = new StringBuilder(64); GetClassName(h, cls, 64);
          if (cls.ToString() != "#32770") return true;
          var title = new StringBuilder(256); GetWindowText(h, title, 256);
          uint pid; GetWindowThreadProcessId(h, out pid);
          string name = ""; try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
          found.Add(title + "|" + name);
          if (close && (name == "electron" || name == "splwow64" || name == "PrintIsolationHost")) PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
          return true;
        }, IntPtr.Zero);
        return found;
      }
    }
"@
    [Wins]::Find($${close ? 'true' : 'false'}) -join [char]10`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    .split('\n').map(line => line.trim()).filter(Boolean);
}
const fromPrinting = line => /\|(electron|splwow64|PrintIsolationHost)$/.test(line);

const before = dialogs().filter(fromPrinting).length;
const app = await electron.launch({
  args: ['.', '--port=19785', '--silent', '--no-tray'],
  cwd: root,
  env: { ...process.env, BETA_SEQUENCE_CONFIG: 'none', BETA_SEQUENCE_STATE_DIR: path.join(temp, 'state'), BETA_SEQUENCE_PRINTOUTS_DIR: path.join(temp, 'printouts') },
});
let passed = false;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.console-log');
  await page.fill('.console-row input', 'give me a printout of Oyster smiling');
  await page.press('.console-row input', 'Enter');
  await page.waitForFunction(() => /^Sent to /.test(document.querySelector('.kind-printout .status-line')?.textContent ?? ''), null, { timeout: 12000 });
  console.log(`The app says: ${await page.locator('.kind-printout .status-line').textContent()}`);
  for (let attempt = 0; attempt < 25 && !passed; attempt++) {
    await page.waitForTimeout(800);
    const open = dialogs().filter(fromPrinting);
    if (open.length > before) {
      console.log(`Windows opened its print window: "${open.at(-1).split('|')[0]}"`);
      passed = true;
    }
  }
  if (!passed) console.error('No print window appeared within 20 seconds.');
} catch (error) {
  console.error(`Print check FAILED: ${error.message}`);
} finally {
  dialogs(true); // close the print window again without saving
  await new Promise(resolve => setTimeout(resolve, 1200));
  await app.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
console.log(passed ? 'Print check passed.' : 'Print check FAILED.');
process.exitCode = passed ? 0 : 1;
