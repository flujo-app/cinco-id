// Makes a brand-new dancer for real, from inside the real app, by typing the sentence from the
// guide. THIS COSTS MONEY on your Modal account (about 35 to 50 cents) and takes several minutes,
// so it only runs with --yes-spend.
//
//   node test/ui/live-generate.mjs --yes-spend [--project d15c0] [--shots <folder>] ["<sentence>"]
//
// It starts a new hex project (or uses it if it exists), asks for the dancer, waits for the
// computer to announce the new beta sequence, has it shown, and checks that a generated,
// see-through clip is really playing. The new project stays in the projects folder.
import { _electron as electron } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const take = flag => { const at = args.indexOf(flag); return at >= 0 ? args.splice(at, 2)[1] : null; };
const project = take('--project') ?? 'd15c0';
const shots = take('--shots');
const spend = args.includes('--yes-spend');
const sentence = args.find(arg => !arg.startsWith('--')) ?? 'generate a new sequence of a grandmother in a gold tracksuit doing disco moves';
if (!spend) { console.error('This makes a real dancer and costs money. Add --yes-spend to run it.'); process.exit(2); }

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-live-'));
const started = Date.now();
const clock = () => `${String(Math.floor((Date.now() - started) / 60000)).padStart(2, '0')}:${String(Math.floor((Date.now() - started) / 1000) % 60).padStart(2, '0')}`;
const app = await electron.launch({
  args: ['.', '--port=19786', '--silent', '--no-tray', '--no-print'],
  cwd: root,
  env: { ...process.env, CINCO_ID_CONFIG: 'none', CINCO_ID_OPERATOR: 'Paul', CINCO_ID_STATE_DIR: path.join(temp, 'state'), CINCO_ID_PRINTOUTS_DIR: path.join(temp, 'printouts') },
});
let ok = false;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.console-log');
  const lines = kind => page.locator(`.console-log .${kind}`).allTextContents();
  const last = async () => (await lines('computer')).at(-1) ?? '';
  const say = async text => { await page.fill('.console-row input', text); await page.press('.console-row input', 'Enter'); await page.waitForTimeout(900); };

  await say(`kick up the ${project}`);
  if (/Shall I start one/.test(await last())) await say('yes');
  console.log(`[${clock()}] project: ${await last()}`);

  await say(sentence);
  console.log(`[${clock()}] asked: "${sentence}" -> ${await last()}`);
  if ((await last()) !== 'Working on it.') throw new Error(`The computer did not start working: "${await last()}"`);

  let lastProgress = '';
  let outcome = null;
  while (!outcome && Date.now() - started < 30 * 60_000) {
    await page.waitForTimeout(5000);
    const progress = await page.locator('.kind-progress .pad').first().textContent().catch(() => '');
    if (progress && progress !== lastProgress) { lastProgress = progress; console.log(`[${clock()}] ${progress}`); }
    const answer = await last();
    if (/I have a new BETA sequence/.test(answer)) outcome = 'made';
    else if (/did not work out/.test(answer)) outcome = 'failed';
  }
  if (outcome !== 'made') {
    const notes = await lines('system');
    throw new Error(`No new dancer (${outcome ?? 'gave up after 30 minutes'}). ${notes.at(-1) ?? ''}`);
  }
  console.log(`[${clock()}] ${await last()}`);

  await say('do we have any new sequences?');
  console.log(`[${clock()}] ${await last()}`);
  await say('alright');
  const name = (await last()).replace(/\.$/, '');
  console.log(`[${clock()}] revealed: ${name}`);
  const playing = await page.waitForFunction(() => window.betaSequence.clipStatus().some(clip => clip.ready && clip.time > 0.3), null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  const clip = (await page.evaluate(() => window.betaSequence.clipStatus()))[0];
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector('.window.kind-sequence canvas');
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let filled = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 24) filled++;
    return { filled: filled / (width * height), cornerAlpha: data[(2 * width + 2) * 4 + 3] };
  });
  console.log(`[${clock()}] clip: ${clip ? `${clip.width}x${clip.height} playing=${playing}` : 'none (a stand-in puppet is shown)'}; figure covers ${(pixels.filled * 100).toFixed(0)}% of the window; corner see-through=${pixels.cornerAlpha < 24}`);
  ok = Boolean(clip) && playing && pixels.filled > 0.04 && pixels.cornerAlpha < 24;

  await say('can I get a hat wobble?');
  await page.waitForTimeout(1200);
  if (shots) {
    await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'live-new-dancer.png') });
  }
  const folders = await fs.readdir(path.join(root, 'projects', project, 'sequences')).catch(() => []);
  for (const folder of folders) {
    const media = JSON.parse(await fs.readFile(path.join(root, 'projects', project, 'sequences', folder, 'media.json'), 'utf8').catch(() => 'null'));
    if (media) console.log(`[${clock()}] saved as projects/${project}/sequences/${folder} (estimated cost $${media.provenance?.costUsdEstimate ?? '?'})`);
  }
} catch (error) {
  console.error(`[${clock()}] FAILED: ${error.message}`);
} finally {
  await app.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
console.log(ok ? `Live generation passed in ${clock()}.` : 'Live generation FAILED.');
process.exitCode = ok ? 0 : 1;
