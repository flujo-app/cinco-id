import { spawn } from 'node:child_process';
import readline from 'node:readline';

/**
 * A helper program that stays running and answers one JSON line per request.
 * Used for the voice (speaking) and for the ears (speech recognition), so the slow start-up
 * (loading the voice or the recognition model) happens only once.
 */
export class LineWorker {
  constructor({ command, args, env = {}, name, startTimeoutMs = 120_000 }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.name = name;
    this.startTimeoutMs = startTimeoutMs;
    this.child = null;
    this.waiting = new Map();
    this.nextId = 1;
    this.ready = null;
    this.lastError = '';
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      const timer = setTimeout(() => reject(new Error(`${this.name} did not start in time. ${this.lastError}`.trim())), this.startTimeoutMs);
      child.on('error', error => { clearTimeout(timer); this.fail(error); reject(error); });
      child.on('exit', code => {
        clearTimeout(timer);
        const error = new Error(`${this.name} stopped (code ${code}). ${this.lastError}`.trim());
        this.fail(error);
        reject(error);
      });
      child.stderr.on('data', chunk => { this.lastError = String(chunk).trim().split('\n').at(-1).slice(0, 300); });
      readline.createInterface({ input: child.stdout }).on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.ready) { clearTimeout(timer); resolve(); return; }
        const waiter = this.waiting.get(message.id);
        if (!waiter) return;
        this.waiting.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error));
        else waiter.resolve(message);
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  fail(error) {
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
    this.child = null;
    this.ready = null;
  }

  async request(payload, timeoutMs = 60_000) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${this.name} took too long.`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child) {
      child.removeAllListeners('exit');
      try { child.stdin.end(); } catch { /* already gone */ }
      child.kill();
    }
  }
}
