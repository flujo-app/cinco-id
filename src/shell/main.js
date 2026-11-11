// The desktop shell: starts the computer and shows its screen, either as a normal window with
// its own Win95 desktop, or as a see-through layer on top of your real desktop ("overlay").
import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, safeStorage, screen, session, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { resolveDataDir } from '../server/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(here, '..', '..');
const flag = name => process.argv.includes(`--${name}`);
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

// Started from a clone, settings and projects stay in the project folder as always. The installed
// app keeps them in the per-user app data folder. A chosen folder (--data-dir= or
// CINCO_ID_DATA_DIR) also holds the window's own browser data, so a test copy leaves no trace.
const chosenDataDir = option('data-dir') || process.env.CINCO_ID_DATA_DIR || null;
if (chosenDataDir) app.setPath('userData', path.resolve(chosenDataDir));
const dataDir = resolveDataDir({ appDir: rootDir, packaged: app.isPackaged, userData: app.getPath('userData'), option: chosenDataDir });

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let harness = null;
let window = null;
let tray = null;
let overlay = flag('overlay');

function trayIcon() {
  // A tiny navy square with a teal middle, drawn here so no picture file is needed.
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inner = x > 3 && x < 12 && y > 3 && y < 12;
      const [r, g, b] = inner ? [0, 128, 128] : [0, 0, 128];
      pixels.set([b, g, r, 255], (y * size + x) * 4);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const common = {
    show: false,
    backgroundColor: overlay ? '#00000000' : '#008080',
    icon: path.join(here, 'icon.png'),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  };
  window = overlay
    ? new BrowserWindow({
      ...common, ...area, transparent: true, frame: false, resizable: false, movable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: true,
    })
    : new BrowserWindow({
      ...common, width: Math.min(1360, area.width), height: Math.min(860, area.height),
      title: 'Cinco Identity Generator 2.5', autoHideMenuBar: true,
    });
  if (overlay) {
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true, { forward: true });
  }
  const query = [overlay ? 'overlay=1' : null, flag('silent') ? 'silent=1' : null].filter(Boolean).join('&');
  window.loadURL(`http://127.0.0.1:${harness.port}/${query ? `?${query}` : ''}`);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
}

function switchMode() {
  overlay = !overlay;
  const old = window;
  createWindow();
  old?.destroy();
  buildTray();
}

function buildTray() {
  tray ??= new Tray(trayIcon());
  tray.setToolTip('Cinco Identity Generator 2.5');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: overlay ? 'Show as a window' : 'Show on top of my desktop', click: switchMode },
    { label: 'Talk (Ctrl+Alt+Space)', click: () => window?.webContents.send('toggle-listen') },
    { label: 'Setup...', click: () => window?.webContents.send('open-setup') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

/**
 * Sends one printout through the Windows print system. By default it goes straight to the
 * PDF printer (Windows then asks where to save the file); "dialog" shows the print window.
 */
async function printPage({ url, settings }) {
  // The sheet gets its own small, visible window. Windows attaches the printer's "save as"
  // window to whatever is in front, and switches that window off for clicks while it is open.
  // With a hidden window that would be some other program's window; this way it is ours.
  const page = new BrowserWindow({
    width: 300, height: 400, show: false, title: 'Printing', resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true },
  });
  try {
    await page.loadURL(url);
    page.show();
    page.focus();
    const printers = await page.webContents.getPrintersAsync();
    const wanted = printers.find(printer => printer.name === settings.printer);
    const silent = settings.print !== 'dialog' && Boolean(wanted);
    return await new Promise(resolve => {
      page.webContents.print(
        { silent, deviceName: wanted?.name, printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } },
        (success, reason) => resolve({ success, reason: reason || null, printer: silent ? wanted.name : 'the printer you chose' }),
      );
    });
  } finally {
    page.destroy();
  }
}

app.whenReady().then(async () => {
  const port = option('port');
  harness = await createApp({
    rootDir,
    dataDir,
    overrides: {
      ...(port ? { port: Number(port) } : {}),
      // For tests: the Setup window must not open by surprise.
      ...(flag('no-setup') ? { setup: { onFirstStart: false } } : {}),
    },
    // Keys typed into the Setup window are encrypted with the Windows sign-in (safeStorage).
    parts: { secretCipher: safeStorage, ...(flag('no-print') ? {} : { printer: printPage }) },
  });
  await harness.listen();
  for (const note of harness.notes) console.log(`Note: ${note}`);

  // The Start menu on the screen can open the projects and printouts folders. Only these fixed
  // folders: the screen names one, it never hands over a path.
  ipcMain.handle('open-folder', async (_event, which) => {
    const folders = { projects: harness?.config.projectsDir, printouts: harness?.config.printouts.dir, data: harness?.config.dataDir };
    const folder = folders[which];
    if (!folder) return 'There is no such folder.';
    await fs.mkdir(folder, { recursive: true });
    return (await shell.openPath(folder)) || null;
  });
  // "Restart now" in the Setup window, for settings that only take effect on a fresh start.
  ipcMain.handle('restart', () => {
    app.relaunch();
    app.quit();
  });

  // The screen may use the microphone; nothing else gets asked for.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, allow) => allow(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'media');

  ipcMain.on('ignore-mouse', (_event, ignore) => {
    if (overlay && window) window.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  });

  createWindow();
  if (!flag('no-tray')) buildTray();
  globalShortcut.register('Control+Alt+Space', () => window?.webContents.send('toggle-listen'));
  globalShortcut.register('Control+Alt+O', switchMode);
  globalShortcut.register('Control+Alt+Q', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', async event => {
  globalShortcut.unregisterAll();
  if (!harness) return;
  event.preventDefault();
  const closing = harness;
  harness = null;
  await closing.close().catch(() => {});
  app.exit(0);
});
