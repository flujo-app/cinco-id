// Checks that generated clips really play in the app with a see-through background.
// Usage: node test/ui/clip-check.mjs [--projects <folder>] [--shots <folder>] "<sequence name>" ...
// A name may be followed by "/variant", for example "Tayne/nude".
import { _electron as electron } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const take = flag => { const at = args.indexOf(flag); return at >= 0 ? args.splice(at, 2)[1] : null; };
const projects = take('--projects');
const shots = take('--shots');
const names = args;
if (!names.length) { console.error('Give at least one sequence name.'); process.exit(2); }
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'beta-sequence-clip-'));

const app = await electron.launch({
  args: ['.', '--port=19784', '--silent', '--no-tray', '--no-print'],
  cwd: root,
  env: {
    ...process.env, BETA_SEQUENCE_CONFIG: 'none', BETA_SEQUENCE_STATE_DIR: path.join(temp, 'state'),
    BETA_SEQUENCE_PRINTOUTS_DIR: path.join(temp, 'printouts'), ...(projects ? { BETA_SEQUENCE_PROJECTS_DIR: projects } : {}),
  },
});
let failed = false;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.console-log');
  const say = async text => { await page.fill('.console-row input', text); await page.press('.console-row input', 'Enter'); await page.waitForTimeout(400); };
  for (const entry of names) {
    const [name, variant] = entry.split('/');
    await say('clear the desktop');
    await say(`load up ${name}`);
    if (variant) {
      await page.evaluate(() => { /* skip the spoken gate: answer through the dialog */ });
      await say(`${variant} ${name}`);
      await say(`${variant} ${name}`);
      await say('yes');
      await page.waitForTimeout(1500);
    }
    const ready = await page.waitForFunction(() => window.betaSequence.clipStatus().some(clip => clip.ready && clip.time > 0.3), null, { timeout: 15000 })
      .then(() => true).catch(() => false);
    const status = await page.evaluate(() => window.betaSequence.clipStatus());
    const pixels = await page.evaluate(() => {
      const canvas = document.querySelector('.window.kind-sequence canvas');
      if (!canvas) return null;
      const { width, height } = canvas;
      const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      let filled = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 24) filled++;
      const alphaAt = (x, y) => data[(y * width + x) * 4 + 3];
      return { filled: filled / (width * height), corners: [alphaAt(2, 2), alphaAt(width - 3, 2), alphaAt(2, Math.floor(height / 2)), alphaAt(width - 3, Math.floor(height / 2))] };
    });
    const clip = status[0];
    const ok = ready && clip && !clip.error && pixels && pixels.filled > 0.04 && pixels.filled < 0.75 && pixels.corners.every(alpha => alpha < 24);
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${entry}: ${clip ? `${clip.width}x${clip.height} playing=${ready}` : 'no clip loaded (puppet shown)'}`
      + (pixels ? `, figure covers ${(pixels.filled * 100).toFixed(0)}% of the window, edge see-through=${pixels.corners.every(alpha => alpha < 24)}` : '')
      + (clip?.error ? `, error: ${clip.error}` : ''));
    if (!ok) failed = true;
    if (shots) {
      await fs.mkdir(shots, { recursive: true });
      await page.locator('.window.kind-sequence').first().screenshot({ path: path.join(shots, `${entry.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) });
    }
  }
} catch (error) {
  console.error(`Clip check FAILED: ${error.message}`);
  failed = true;
} finally {
  await app.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
process.exitCode = failed ? 1 : 0;
