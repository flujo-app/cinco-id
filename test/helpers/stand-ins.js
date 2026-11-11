// Stand-ins shared by the fast tests.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** Like Electron's safeStorage: reversible, but the stored bytes never contain the key. */
export const standInCipher = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: text => Buffer.concat([Buffer.from('SEALED:'), Buffer.from(text, 'utf8').map(byte => byte ^ 0x5a)]),
  decryptString: buffer => {
    if (!buffer.subarray(0, 7).equals(Buffer.from('SEALED:'))) throw new Error('not ours');
    return Buffer.from(buffer.subarray(7).map(byte => byte ^ 0x5a)).toString('utf8');
  },
});

/** Records what would have been started, and plays a scripted program instead of starting it. */
export function standInSpawn(script = () => ({})) {
  const started = [];
  const spawn = (command, args, options) => {
    started.push({ command, args, options });
    return makeChild(script({ command, args, options }));
  };
  return { spawn, started };
}

function makeChild({ lines = [], errLines = [], code = 0, delayMs = 10 }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', null); };
  setTimeout(() => {
    for (const line of lines) child.stdout.write(`${line}\n`);
    for (const line of errLines) child.stderr.write(`${line}\n`);
    child.stdout.end();
    child.stderr.end();
    setTimeout(() => { if (!child.killed) child.emit('exit', code); }, delayMs);
  }, delayMs);
  return child;
}
