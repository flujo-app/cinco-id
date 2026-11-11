import { promises as fs } from 'node:fs';
import path from 'node:path';

/** The only keys the app keeps. */
export const SECRET_NAMES = ['brain', 'openrouter'];

/** Which environment variable stands in for a key that is not stored. */
export function secretEnvName(name, config) {
  if (name === 'openrouter') return 'OPENROUTER_API_KEY';
  if (name === 'brain') return config?.brain?.apiKeyEnv || null;
  return null;
}

/**
 * Keys for outside services (the brain's chat service, OpenRouter), kept encrypted in the data
 * folder. The desktop app hands in Electron's safeStorage, which encrypts with the Windows
 * sign-in of the person using the PC. Without it (plain server mode) nothing can be stored and
 * keys come from environment variables only.
 *
 * Only the encrypted form is kept in memory; a key is decrypted when it is used. Keys are never
 * logged, never written to the settings file and never sent back to the screen.
 */
export class SecretStore {
  constructor({ file, cipher = null }) {
    this.file = file;
    this.cipher = cipher; // { isEncryptionAvailable(), encryptString(text) -> Buffer, decryptString(Buffer) -> text }
    this.sealed = {};
  }

  get canStore() {
    try { return Boolean(this.file && this.cipher?.isEncryptionAvailable()); } catch { return false; }
  }

  async load() {
    if (!this.file) return this;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.sealed = {};
      for (const name of SECRET_NAMES) {
        if (typeof saved.keys?.[name] === 'string' && saved.keys[name]) this.sealed[name] = saved.keys[name];
      }
    } catch { this.sealed = {}; }
    return this;
  }

  has(name) { return Boolean(this.sealed[name]); }

  /** The key in plain text, or null. Only for handing it to the service it belongs to. */
  get(name) {
    if (!this.sealed[name] || !this.canStore) return null;
    try { return this.cipher.decryptString(Buffer.from(this.sealed[name], 'base64')) || null; } catch { return null; }
  }

  async set(name, value) {
    if (!SECRET_NAMES.includes(name)) throw new Error('There is no such key.');
    if (!this.canStore) throw Object.assign(new Error('Keys can only be stored by the desktop app. Use an environment variable instead.'), { status: 409 });
    this.sealed[name] = Buffer.from(this.cipher.encryptString(String(value))).toString('base64');
    await this.save();
  }

  async remove(name) {
    if (!this.sealed[name]) return;
    delete this.sealed[name];
    await this.save();
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const partial = `${this.file}.part`;
    await fs.writeFile(partial, JSON.stringify({ note: 'Encrypted with this Windows sign-in. Only CINCO ID on this PC can read it.', keys: this.sealed }, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(partial, this.file);
  }
}

/** A key from the store first, then from its environment variable. */
export function findSecret(name, { secrets, env = process.env, config }) {
  const stored = secrets?.get(name);
  if (stored) return { value: stored, source: 'stored' };
  const envName = secretEnvName(name, config);
  if (envName && env[envName]) return { value: env[envName], source: 'environment', envName };
  return { value: null, source: null, envName };
}
