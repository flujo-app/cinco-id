// Tries the real installer once, without touching anything it does not own:
//   1. installs silently, for this Windows user only, into a temporary folder,
//   2. checks the program, the Start menu entry, the desktop shortcut and the entry in Windows' app list,
//   3. starts the installed app with the full play-through (its own port and data folder),
//   4. uninstalls silently and checks that the folder, the shortcuts and the app list entry are gone.
// It stops and reports anything it would leave behind.
// Usage: node test/ui/install-check.mjs [dist/CINCO-ID-Setup-2.5.1.exe]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root } from './launch.mjs';

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const installer = path.resolve(process.argv[2] ?? path.join(root, 'dist', `CINCO-ID-Setup-${pkg.version}.exe`));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cinco-id-install-'));
const target = path.join(temp, 'app');
const problems = [];

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
}
const folder = name => powershell(`[Environment]::GetFolderPath('${name}')`);
const startMenu = path.join(folder('Programs'), 'CINCO ID.lnk');
const desktop = path.join(folder('Desktop'), 'CINCO ID.lnk');
const appListEntries = () => powershell(`Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DisplayName -eq 'CINCO ID') { $_.PSChildName + '|' + $p.InstallLocation + '|' + $p.UninstallString } }`)
  .split(/\r?\n/).filter(Boolean);
const running = () => powershell(`@(Get-Process -Name 'CINCO ID' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${target.replace(/'/g, "''")}*' }).Count`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Nothing of ours may be there before we start, or we could not tell what we left behind.
const updater = path.join(process.env.LOCALAPPDATA ?? '', 'cinco-id-updater');
const before = { startMenu: existsSync(startMenu), desktop: existsSync(desktop), entries: appListEntries(), updater: existsSync(updater) };
if (before.startMenu || before.desktop || before.entries.length || before.updater) {
  console.error(`CINCO ID already seems to be installed for this user (${JSON.stringify(before)}); stopping without changing anything.`);
  process.exit(1);
}

try {
  console.log(`Installer: ${installer} (${((await fs.stat(installer)).size / 1024 / 1024).toFixed(1)} MB)`);
  const install = spawnSync(installer, ['/S', `/D=${target}`], { stdio: 'inherit' });
  if (install.status !== 0) throw new Error(`The installer stopped with code ${install.status}.`);
  const exe = path.join(target, 'CINCO ID.exe');
  for (let i = 0; i < 20 && !existsSync(exe); i++) await wait(500);
  if (!existsSync(exe)) throw new Error('The program is not in the install folder.');
  console.log(`Installed into ${target}`);
  if (!existsSync(path.join(target, 'resources', 'app', 'src', 'server', 'voice', 'tts_windows.ps1'))) problems.push('The voice helper script is not a real file in the installed app.');
  if (!existsSync(path.join(target, 'resources', 'app', 'tools', 'media', 'generate.py'))) problems.push('The dancer tools are missing from the installed app.');
  if (!existsSync(startMenu)) problems.push('No Start menu entry.');
  if (!existsSync(desktop)) problems.push('No desktop shortcut.');
  const entries = appListEntries();
  if (entries.length !== 1) problems.push(`Expected one entry in Windows' app list, found ${entries.length}.`);
  else console.log(`App list entry: ${entries[0].split('|').slice(1).join(' | ')}`);
  await wait(1500);
  if (running() !== '0') problems.push('The installer started the app by itself in silent mode.');

  console.log('Starting the installed app with the play-through...');
  const play = spawnSync(process.execPath, [path.join(root, 'test', 'ui', 'run.mjs'), '--exe', exe], { stdio: 'inherit' });
  if (play.status !== 0) problems.push('The play-through failed in the installed app.');

  const uninstaller = path.join(target, 'Uninstall CINCO ID.exe');
  if (!existsSync(uninstaller)) throw new Error('No uninstaller in the install folder.');
  const uninstall = spawnSync(uninstaller, ['/S'], { stdio: 'inherit' });
  if (uninstall.status !== 0) problems.push(`The uninstaller stopped with code ${uninstall.status}.`);
  // The uninstaller hands over to a copy of itself and finishes in the background.
  for (let i = 0; i < 60 && (existsSync(exe) || appListEntries().length); i++) await wait(1000);
  await wait(2000);
  if (existsSync(target) && (await fs.readdir(target)).length) problems.push(`Files were left in ${target}: ${(await fs.readdir(target)).join(', ')}`);
  if (existsSync(startMenu)) problems.push('The Start menu entry was left behind.');
  if (existsSync(desktop)) problems.push('The desktop shortcut was left behind.');
  if (appListEntries().length) problems.push('The entry in Windows\' app list was left behind.');
  if (existsSync(updater) && !before.updater) problems.push(`The installer's own copy was left in ${updater}.`);
  console.log('Uninstalled.');
} catch (error) {
  problems.push(error.message);
} finally {
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
for (const problem of problems) console.error(`Problem: ${problem}`);
console.log(problems.length ? 'Install check FAILED.' : 'Install check passed: installed, played, uninstalled, nothing left behind.');
process.exitCode = problems.length ? 1 : 0;
