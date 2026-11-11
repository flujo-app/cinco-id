// Checks that the computer really speaks. THIS ONE IS AUDIBLE: it starts the app with sound on
// and lets it say the greeting and one answer through the speakers.
//
//   node test/ui/voice-check.mjs            uses your own settings (your chosen voice)
//   node test/ui/voice-check.mjs --plain    ignores your settings (the default voice of a fresh copy)
import { _electron as electron } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const plain = process.argv.includes('--plain');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-voice-'));
const app = await electron.launch({
  args: ['.', '--no-tray', '--no-print'],
  cwd: root,
  env: {
    ...process.env, CINCO_ID_PORT: '19787', CINCO_ID_STATE_DIR: path.join(temp, 'state'), CINCO_ID_PRINTOUTS_DIR: path.join(temp, 'printouts'),
    ...(plain ? { CINCO_ID_CONFIG: 'none', CINCO_ID_OPERATOR: 'Paul' } : {}),
  },
});
let ok = false;
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.console-log');
  const heard = wanted => page.waitForFunction(
    text => window.betaSequence.voiceLog().find(line => line.text.includes(text))?.outcome,
    wanted, { timeout: 45000 },
  ).then(handle => handle.jsonValue()).catch(() => 'nothing was said within 45 seconds');

  const greeting = await heard('What will your first sequence of the day be');
  console.log(`Greeting: ${greeting}`);
  await page.fill('.console-row input', 'load up oyster');
  await page.press('.console-row input', 'Enter');
  const answer = await heard('Yes,');
  console.log(`Answer to "load up oyster": ${answer}`);
  const state = await page.evaluate(async () => (await (await fetch('/api/state')).json()).voice);
  console.log(`Voice comes from: ${state.speak === 'server' ? 'the computer itself (robot or Windows voice)' : 'the browser'}`);
  ok = greeting === 'played' && answer === 'played';
  await page.waitForTimeout(800);
} catch (error) {
  console.error(`Voice check FAILED: ${error.message}`);
} finally {
  await app.close().catch(() => {});
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
console.log(ok ? 'Voice check passed: both sentences were played to the end.' : 'Voice check FAILED.');
process.exitCode = ok ? 0 : 1;
