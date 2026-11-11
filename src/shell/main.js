// The desktop shell: starts the computer and shows its screen, either as a normal window with
// its own Win95 desktop, or as a see-through layer on top of your real desktop ("overlay").
import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, screen, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(here, '..', '..');
const flag = name => process.argv.includes(`--${name}`);
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

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
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  };
  window = overlay
    ? new BrowserWindow({
      ...common, ...area, transparent: true, frame: false, resizable: false, movable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: true,
    })
    : new BrowserWindow({
      ...common, width: Math.min(1360, area.width), height: Math.min(860, area.height),
      title: 'Beta Sequence', autoHideMenuBar: true,
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
  tray.setToolTip('Beta Sequence');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: overlay ? 'Show as a window' : 'Show on top of my desktop', click: switchMode },
    { label: 'Talk (Ctrl+Alt+Space)', click: () => window?.webContents.send('toggle-listen') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

app.whenReady().then(async () => {
  const port = option('port');
  harness = await createApp({ rootDir, overrides: port ? { port: Number(port) } : {} });
  await harness.listen();
  for (const note of harness.notes) console.log(`Note: ${note}`);

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
