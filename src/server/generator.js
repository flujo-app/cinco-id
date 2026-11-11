import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import readline from 'node:readline';

/**
 * Runs the media generator (tools/media/generate.py) in the background to make a new sequence.
 * The script reports progress as one JSON object per line and ends with {"done": true}.
 */
export class Generator {
  /** `extraEnv()` adds to the child's environment on every run (the stored OpenRouter key, if any). */
  constructor({ python, script, timeoutMs = 45 * 60_000, extraEnv = () => ({}) }) {
    this.python = python;
    this.script = script;
    this.timeoutMs = timeoutMs;
    this.extraEnv = extraEnv;
  }

  static create(config, { extraEnv } = {}) {
    if (!config?.enabled || !config.script || !existsSync(config.script)) return null;
    return new Generator({ ...config, ...(extraEnv ? { extraEnv } : {}) });
  }

  run({ name, prompt, out, expressions = ['smiling'] }, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const args = [this.script, '--name', name, '--prompt', prompt, '--out', out];
      if (expressions.length) args.push('--expressions', ...expressions);
      // Keys travel in the environment only, never on the command line.
      const env = { ...process.env, ...this.extraEnv(), PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
      const child = spawn(this.python, args, { env, windowsHide: true });
      let finished = null;
      let problem = '';
      const timer = setTimeout(() => { problem = 'it took too long'; child.kill(); }, this.timeoutMs);
      readline.createInterface({ input: child.stdout }).on('line', line => {
        let update;
        try { update = JSON.parse(line); } catch { return; }
        if (update.error) problem = update.error;
        else if (update.done) finished = update;
        else onProgress(update);
      });
      child.stderr.on('data', chunk => { if (!problem) problem = String(chunk).trim().split('\n').at(-1).slice(0, 300); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => {
        clearTimeout(timer);
        if (code === 0 && finished) resolve(finished);
        else reject(new Error(problem || `the generator stopped (code ${code})`));
      });
    });
  }
}
