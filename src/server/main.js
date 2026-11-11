import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

// Runs the computer without the desktop shell: open the printed address in a browser.
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = await createApp({ rootDir });
const port = await app.listen();
console.log(`CINCO ID is running at http://127.0.0.1:${port}`);
for (const note of app.notes) console.log(`Note: ${note}`);
const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
