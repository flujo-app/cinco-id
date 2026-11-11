import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Where things live.
 *
 * The app folder holds the code, the helper scripts and the bundled demo project. An installed
 * copy never writes there. The data folder holds everything that belongs to the person using it:
 * the settings file, the computer's memory (.local), printouts, the voice cache and their projects.
 *
 * Started from a clone (npm start, npm run serve), both are the project folder, exactly as before.
 * The installed app uses the per-user app data folder. CINCO_ID_DATA_DIR (or --data-dir=) picks
 * any other folder, which the tests use to keep a copy apart from the real one.
 */
export function resolveDataDir({ appDir, packaged = false, userData = null, env = process.env, option = null } = {}) {
  const chosen = option || env.CINCO_ID_DATA_DIR;
  if (chosen) return path.resolve(chosen);
  if (packaged && userData) return userData;
  return appDir;
}

const HEX_ID = /^[0-9a-f]{1,16}$/;

async function projectFolders(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && HEX_ID.test(entry.name)).map(entry => entry.name);
  } catch {
    return [];
  }
}

/**
 * Copies the bundled demo project(s) into the data folder, but only when the data folder has no
 * projects yet, so people can add and change their own without the app touching them again.
 * Returns the ids that were copied.
 */
export async function seedProjects(from, to) {
  if (path.resolve(from) === path.resolve(to)) return [];
  if ((await projectFolders(to)).length) return [];
  const bundled = await projectFolders(from);
  for (const id of bundled) {
    await fs.cp(path.join(from, id), path.join(to, id), { recursive: true, errorOnExist: false, force: false });
  }
  return bundled;
}
