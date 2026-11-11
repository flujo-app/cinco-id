// The manual way: prepares the link between a WhatsApp connector (mcp-whatsapp-web) that another
// program runs and this computer, so incoming calls pop up on screen. Makes a private shared
// secret once, stores it in harness.config.json, and prints the three settings that connector
// needs. (The usual way is "Link WhatsApp" in the Setup window, which needs none of this.)
//
//   npm run whatsapp:link            shows the settings with the secret hidden
//   npm run whatsapp:link -- --show  shows the secret too (to copy it into the connector)
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, settingsFile } from '../config.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dataDir = process.env.CINCO_ID_DATA_DIR ? path.resolve(process.env.CINCO_ID_DATA_DIR) : rootDir;
const file = settingsFile(dataDir) ?? path.join(dataDir, 'harness.config.json');
const show = process.argv.includes('--show');

let saved = {};
try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
saved.events ??= {};
saved.events.whatsapp ??= {};
let created = false;
if (!/^whsec_/.test(saved.events.whatsapp.secret ?? '') || /</.test(saved.events.whatsapp.secret)) {
  saved.events.whatsapp.secret = `whsec_${randomBytes(32).toString('base64')}`;
  saved.events.whatsapp.messages ??= 'off';
  await fs.writeFile(file, JSON.stringify(saved, null, 2) + '\n');
  created = true;
}
const config = await loadConfig(rootDir, {}, { dataDir });
const secret = saved.events.whatsapp.secret;

console.log('This is the manual way. The Setup window can link WhatsApp by itself: say "link whatsapp" there.\n');
console.log(created ? 'A new private secret was saved in harness.config.json.' : 'Using the secret already saved in harness.config.json.');
console.log('\nGive the WhatsApp connector these three settings (in the "env" part of its entry), then restart it:\n');
console.log(`  WHATSAPP_WEBHOOK_URL=http://127.0.0.1:${config.port}/hooks/whatsapp`);
console.log(`  WHATSAPP_WEBHOOK_SECRET=${show ? secret : 'whsec_... (run again with -- --show to see it)'}`);
console.log('  WHATSAPP_WEBHOOK_EVENTS=call.received,call.ended');
console.log('\nAdd message.received to the last line if new messages should pop up too,');
console.log('and set "messages" to "sender" or "preview" in harness.config.json.');
