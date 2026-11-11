// Shared by the checks in test/ui: how to start a test copy of the app, either from this folder
// (electron .) or from a packaged copy (--exe <path to CINCO ID.exe>), always silently, without a
// tray icon, on its own port and with its own data folder, so nothing touches the real one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Removes "--name value" from the argument list and returns the value (or null). */
export function takeOption(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args.splice(at, 2)[1] ?? null : null;
}

/**
 * Options for playwright's electron.launch.
 *   exe:      a packaged CINCO ID.exe, or null for this folder
 *   port:     its own port, so it never meets the copy the owner may be running
 *   dataDir:  its own data folder
 *   print:    false adds --no-print
 *   setup:    false adds --no-setup, so the Setup window does not open by surprise
 */
export function launchOptions({ exe = null, port, dataDir = null, print = false, setup = false, args = [], env = {} }) {
  const flags = [`--port=${port}`, '--silent', '--no-tray', ...(print ? [] : ['--no-print']), ...(setup ? [] : ['--no-setup']), ...args];
  const environment = { ...process.env, ...(dataDir ? { CINCO_ID_DATA_DIR: dataDir } : {}), ...env };
  for (const [key, value] of Object.entries(environment)) if (value === undefined || value === null) delete environment[key];
  return exe
    ? { executablePath: path.resolve(exe), args: flags, env: environment }
    : { args: ['.', ...flags], cwd: root, env: environment };
}
