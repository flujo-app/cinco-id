// Helpers for the WhatsApp tests: a ready-to-run copy of the stand-in connector, its signals, and waiting.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAND_IN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'whatsapp-stand-in');

/** Copies the stand-in into `dir` and "builds" it there. `version` pretends to be another version. */
export async function standInConnector(dir, { version = null } = {}) {
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'build.mjs']) await fs.copyFile(path.join(STAND_IN, name), path.join(dir, name));
  await fs.copyFile(path.join(STAND_IN, 'src', 'index.js'), path.join(dir, 'src', 'index.js'));
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fs.copyFile(path.join(STAND_IN, 'src', 'index.js'), path.join(dir, 'dist', 'index.js'));
  if (version) {
    const file = path.join(dir, 'package.json');
    const info = JSON.parse(await fs.readFile(file, 'utf8'));
    info.version = version;
    await fs.writeFile(file, JSON.stringify(info, null, 2));
  }
  return dir;
}

/** Gives the stand-in a signal (see its own description). */
export function signal(dir, name, value = {}) {
  return fs.writeFile(path.join(dir, name), JSON.stringify(value));
}

/** Reads what the stand-in wrote down, or null. */
export async function readRecord(dir, name) {
  try { return JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')); } catch { return null; }
}

export async function waitFor(check, { timeoutMs = 10_000, stepMs = 50, what = 'something' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Waited ${timeoutMs} ms for ${what}.`);
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
