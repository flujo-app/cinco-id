import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { SecretStore, findSecret } from '../src/server/secrets.js';
import { standInCipher } from './helpers/stand-ins.js';

const KEY = 'sk-test-0123456789abcdef';

test('keys are kept encrypted on disk and come back only through the store', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-secrets-'));
  try {
    const file = path.join(temp, '.local', 'secrets.json');
    const store = await new SecretStore({ file, cipher: standInCipher() }).load();
    assert.equal(store.canStore, true);
    assert.equal(store.has('brain'), false);
    await store.set('brain', KEY);
    const onDisk = await fs.readFile(file, 'utf8');
    assert.ok(!onDisk.includes(KEY), 'the key itself is not in the file');
    assert.ok(!onDisk.includes(Buffer.from(KEY).toString('base64')), 'not even as plain base64');
    assert.equal(store.get('brain'), KEY);

    // A fresh start reads it back.
    const again = await new SecretStore({ file, cipher: standInCipher() }).load();
    assert.equal(again.has('brain'), true);
    assert.equal(again.get('brain'), KEY);
    await again.remove('brain');
    assert.equal(again.has('brain'), false);
    assert.equal((await new SecretStore({ file, cipher: standInCipher() }).load()).has('brain'), false);

    await assert.rejects(store.set('anything-else', 'x'.repeat(20)), /no such key/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('without encryption (plain server mode) nothing can be stored and keys come from the environment', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-secrets-'));
  try {
    const none = await new SecretStore({ file: path.join(temp, 'secrets.json'), cipher: null }).load();
    assert.equal(none.canStore, false);
    await assert.rejects(none.set('brain', KEY), /desktop app/);
    const off = await new SecretStore({ file: path.join(temp, 'secrets.json'), cipher: standInCipher(false) }).load();
    assert.equal(off.canStore, false);

    const config = { brain: { apiKeyEnv: 'OPENAI_API_KEY' } };
    assert.deepEqual(findSecret('brain', { secrets: none, env: { OPENAI_API_KEY: 'from-env-123' }, config }), { value: 'from-env-123', source: 'environment', envName: 'OPENAI_API_KEY' });
    assert.equal(findSecret('openrouter', { secrets: none, env: {}, config }).value, null);

    // A stored key wins over the environment variable.
    const store = await new SecretStore({ file: path.join(temp, 'secrets.json'), cipher: standInCipher() }).load();
    await store.set('openrouter', KEY);
    assert.deepEqual(findSecret('openrouter', { secrets: store, env: { OPENROUTER_API_KEY: 'from-env-456' }, config }), { value: KEY, source: 'stored' });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
