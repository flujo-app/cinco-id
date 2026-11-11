// Checks the see-through mode on the real desktop (Windows only):
//  1. with dancers up, takes one picture of the whole screen (to look at by eye),
//  2. confirms that empty areas let clicks through to whatever is behind,
//  3. confirms that the layer catches clicks again when the pointer is over one of its windows.
// Usage: node test/ui/overlay-check.mjs <folder for the picture>
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = process.argv[2];
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'beta-sequence-overlay-'));

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
}

/** Name of the program whose window would receive a click at this screen position. */
function programAt(x, y) {
  return powershell(`
    Add-Type @"
    using System; using System.Runtime.InteropServices;
    public class Hit {
      [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
      [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
      [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    }
"@
    [Hit]::SetProcessDPIAware() | Out-Null
    $p = New-Object Hit+POINT; $p.X = ${Math.round(x)}; $p.Y = ${Math.round(y)}
    $pid2 = 0; [Hit]::GetWindowThreadProcessId([Hit]::WindowFromPoint($p), [ref]$pid2) | Out-Null
    (Get-Process -Id $pid2).ProcessName`);
}

const app = await electron.launch({
  args: ['.', '--port=19783', '--silent', '--no-tray', '--overlay'],
  cwd: root,
  env: { ...process.env, BETA_SEQUENCE_CONFIG: 'none', BETA_SEQUENCE_STATE_DIR: path.join(temp, 'state'), BETA_SEQUENCE_PRINTOUTS_DIR: path.join(temp, 'printouts') },
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.console-log');
  const say = async text => { await page.fill('.console-row input', text); await page.press('.console-row input', 'Enter'); };
  await say('kick up the 4d3d3d3');
  await page.waitForTimeout(2500);
  await say('free');
  await page.waitForTimeout(1200);

  if (shots) {
    await fs.mkdir(shots, { recursive: true });
    const file = path.join(shots, 'overlay-desktop.png').replace(/'/g, "''");
    powershell(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
      $bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()`);
  }

  const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.match(bodyBackground, /rgba\(0, 0, 0, 0\)|transparent/, 'the page itself has no background in overlay mode');

  await say('clear the desktop');
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const box = document.querySelector('.window.kind-console').getBoundingClientRect();
    return { scale: devicePixelRatio, screenX: window.screenX, screenY: window.screenY, width: innerWidth, height: innerHeight, console: { x: box.x + box.width / 2, y: box.y + 8 } };
  });
  const toScreen = (x, y) => [(info.screenX + x) * info.scale, (info.screenY + y) * info.scale];

  // An empty spot (top right, far from the console window).
  const emptyOwner = programAt(...toScreen(info.width - 60, 60));
  console.log(`A click on an empty part would go to: ${emptyOwner}`);
  assert.notEqual(emptyOwner.toLowerCase(), 'electron', 'empty areas let clicks through');

  // Pointer over one of our windows: the layer must take clicks again.
  await page.evaluate(() => window.shell.setIgnoreMouse(false));
  await page.waitForTimeout(300);
  const consoleOwner = programAt(...toScreen(info.console.x, info.console.y));
  console.log(`A click on the console window would go to: ${consoleOwner}`);
  assert.equal(consoleOwner.toLowerCase(), 'electron', 'our own windows take clicks');
  await page.evaluate(() => window.shell.setIgnoreMouse(true));
  console.log('Overlay check passed.');
} catch (error) {
  console.error(`Overlay check FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
