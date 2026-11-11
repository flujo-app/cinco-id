// "Builds" the stand-in the way the real connector is built by npm ci: src/index.js -> dist/index.js.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(here, 'dist'), { recursive: true });
copyFileSync(path.join(here, 'src', 'index.js'), path.join(here, 'dist', 'index.js'));
