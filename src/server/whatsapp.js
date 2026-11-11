import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findOnPath, runProgram } from './setup.js';

/**
 * CINCO ID's own WhatsApp link. When it is switched on ("Link WhatsApp" in Setup), the app runs
 * its own copy of the WhatsApp connector (mcp-whatsapp-web) as a child program and becomes one
 * more linked device on the person's WhatsApp:
 *
 *   - its sign-in lives in <data>/whatsapp/session, never in the connector's per-user default, so
 *     it cannot collide with another program that runs the same connector;
 *   - it runs in <data>/whatsapp, so the connector's own log lands in <data>/whatsapp/logs;
 *   - the call alerts are set up by the app: its real local address and port, a private secret it
 *     made once and keeps encrypted (never shown), and only the two call events;
 *   - the brain may only look up contacts from it (search_contacts, get_contact_by_id) unless the
 *     settings say otherwise; message text from events never reaches the brain.
 *
 * The connector program comes from, in this order: the folder named in the settings
 * (whatsapp.connectorDir), the copy installed by Setup (<data>/whatsapp/connector), or a
 * mcp-whatsapp-web folder next to the app folder that has been built. It must be 1.4.2 or newer
 * and runs with the Node.js found on the PC (22 or newer).
 *
 * The Install button fetches exactly the pinned version with fixed commands only: git clone,
 * git checkout of the pinned commit, npm ci (which also builds it). Nothing typed on the screen
 * ever becomes part of a command.
 */

export const CONNECTOR = {
  name: 'mcp-whatsapp-web',
  repo: 'https://github.com/mario-andreschak/mcp-whatsapp-web.git',
  commit: '4be9e22771863c8ccb47085b21cdb6c625a08bc2',
  version: '1.4.2',
  minVersion: '1.4.2',
  minNode: 22,
};

export const CALL_EVENTS = 'call.received,call.ended';
export const SAFE_TOOLS = ['search_contacts', 'get_contact_by_id'];
// Linking and unlinking stay with the Setup window, and calls with the Decline button.
const NEVER_FOR_BRAIN = new Set(['logout', 'request_pairing_code', 'get_qr_code', 'reject_call', 'check_auth_status', 'get_backend_status']);

const POLL_WAITING_MS = 3_000;
const POLL_LINKED_MS = 15_000;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** -1, 0 or 1, comparing "1.4.2"-style versions. */
export function compareVersions(a, b) {
  const left = String(a ?? '').split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
  const right = String(b ?? '').split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length, 3); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/** What is in a folder that should hold the WhatsApp connector, in plain words. */
export async function readConnectorFolder(dir, { minVersion = CONNECTOR.minVersion } = {}) {
  let info;
  try {
    info = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return { dir, found: false, ok: false, version: null, message: `There is no WhatsApp connector in ${dir}.` };
  }
  if (info?.name !== CONNECTOR.name) {
    return { dir, found: true, ok: false, version: null, message: `The folder ${dir} does not hold the WhatsApp connector (mcp-whatsapp-web).` };
  }
  const version = typeof info.version === 'string' ? info.version : '?';
  if (compareVersions(version, minVersion) < 0) {
    return {
      dir, found: true, ok: false, version, tooOld: true,
      message: `The WhatsApp connector in ${dir} is version ${version}, which is too old. CINCO ID needs version ${minVersion} or newer. Press Install to get the right version, or update that copy.`,
    };
  }
  if (!(await exists(path.join(dir, 'dist', 'index.js')))) {
    return { dir, found: true, ok: false, version, message: `The WhatsApp connector in ${dir} has not been built yet (dist\\index.js is missing). Press Install, or build that copy with "npm ci".` };
  }
  return { dir, found: true, ok: true, version, message: `WhatsApp connector ${version} found.` };
}

/** The address and commit Install uses. Tests may point it elsewhere through the environment only. */
export function installSource(env = process.env) {
  const from = String(env.CINCO_ID_WHATSAPP_INSTALL_FROM ?? '').trim();
  const commit = String(env.CINCO_ID_WHATSAPP_COMMIT ?? '').trim().toLowerCase();
  return {
    repo: from && (/^https:\/\/[\w.-]+\/[\w./-]+$/.test(from) || path.isAbsolute(from)) ? from : CONNECTOR.repo,
    commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : CONNECTOR.commit,
  };
}

export class WhatsAppLink extends EventEmitter {
  /**
   * config      the app's settings (reads config.whatsapp, config.dataDir, config.appDir)
   * connectors  the outside tools (the connector is added there while it runs)
   * secrets     the encrypted key store (keeps the call-alert secret)
   * getPort     () => the port the app really listens on
   * save        changes => writes them into the settings file (or does nothing without one)
   * probe       for tests: { findCommand(name), run(command, args, options), spawn, env }
   */
  constructor({ config, connectors, secrets = null, getPort, save = async () => {}, probe = {}, pollMs = null, dropNoticeMs = 20_000 }) {
    super();
    this.config = config;
    this.connectors = connectors;
    this.secrets = secrets;
    this.getPort = getPort;
    this.save = save;
    this.env = probe.env ?? process.env;
    this.findCommand = probe.findCommand ?? (name => findOnPath(name, { env: this.env }));
    this.run = probe.run ?? runProgram;
    this.spawn = probe.spawn ?? nodeSpawn;
    this.pollMs = pollMs ?? { waiting: POLL_WAITING_MS, linked: POLL_LINKED_MS };
    this.name = config.mcpServers?.whatsapp ? 'linked-whatsapp' : 'whatsapp';
    this.dropNoticeMs = dropNoticeMs;
    this.running = false;
    this.state = 'off';
    this.stateSince = Date.now();
    this.toldDropped = false;
    this.unlinking = false;
    this.summary = '';
    this.problemText = null;
    this.wasLinked = false;
    this.everConnected = false;
    this.memorySecret = null;
    this.timer = null;
    this.task = null;
    this.nodeCache = null;
    this.program = null;

    connectors?.on?.('connected', name => { if (name === this.name && this.running) { this.everConnected = true; this.refresh(); } });
    connectors?.on?.('retry', (name, delay) => { if (name === this.name && this.running) this.restarting(delay); });
  }

  get folder() { return path.join(this.config.dataDir, 'whatsapp'); }
  get sessionDir() { return path.join(this.folder, 'session'); }
  get installDir() { return path.join(this.folder, 'connector'); }
  get enabled() { return this.config.whatsapp?.enabled === true; }

  // ---------- what is on this PC ----------

  /** The connector program to use, following the order above. */
  async locate() {
    const settings = this.config.whatsapp ?? {};
    const candidates = [];
    if (settings.connectorDir) candidates.push({ dir: path.resolve(String(settings.connectorDir)), source: 'settings' });
    candidates.push({ dir: this.installDir, source: 'installed' });
    if (settings.lookNextDoor !== false) candidates.push({ dir: path.resolve(this.config.appDir, '..', CONNECTOR.name), source: 'next to the app' });
    let first = null;
    for (const candidate of candidates) {
      const found = { ...(await readConnectorFolder(candidate.dir)), source: candidate.source };
      if (found.ok) return found;
      if (found.found || candidate.source === 'settings') first ??= found;
    }
    return first ?? { found: false, ok: false, dir: null, version: null, source: null, message: 'The WhatsApp connector is not on this PC yet. Press Install to get it.' };
  }

  /** The Node.js on this PC, and whether it is new enough (22 or newer). */
  async findNode({ fresh = false } = {}) {
    if (!fresh && this.nodeCache && Date.now() - this.nodeCache.at < 30_000) return this.nodeCache.result;
    const where = await this.findCommand('node');
    let result;
    if (!where) {
      result = { found: false, ok: false, path: null, version: null, message: `Node.js is not on this PC. Install Node.js ${CONNECTOR.minNode} or newer from nodejs.org, then press Check again.` };
    } else {
      const answer = await this.run(where, ['--version'], { env: this.env, timeoutMs: 15_000 });
      const version = /v?(\d+\.\d+\.\d+)/.exec(answer.stdout)?.[1] ?? null;
      const major = Number.parseInt(version ?? '0', 10);
      result = version && major >= CONNECTOR.minNode
        ? { found: true, ok: true, path: where, version, message: `Node.js ${version} found.` }
        : { found: true, ok: false, path: where, version, message: `The Node.js on this PC is ${version ? `version ${version}` : 'not answering'}. The WhatsApp connector needs Node.js ${CONNECTOR.minNode} or newer from nodejs.org.` };
    }
    this.nodeCache = { at: Date.now(), result };
    return result;
  }

  /** npm comes with Node.js; it is started through Node.js itself, never through a command shell. */
  async findNpm(nodePath) {
    const candidates = [path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
    const npm = await this.findCommand('npm');
    if (npm) candidates.push(path.join(path.dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    for (const candidate of candidates) if (await exists(candidate)) return candidate;
    return null;
  }

  // ---------- the secret for call alerts ----------

  /** The private secret the connector signs call alerts with. Made once, kept encrypted, never shown. */
  async webhookSecret() {
    const kept = this.secrets?.get('whatsapp');
    if (kept && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(kept)) return kept;
    const made = `whsec_${randomBytes(32).toString('base64')}`;
    if (this.secrets?.canStore) {
      try { await this.secrets.set('whatsapp', made); return made; } catch { /* fall back to one for this run */ }
    }
    // Without the desktop app's encryption (plain server mode) it lives for this run only;
    // the connector is given it again on every start, so nothing breaks.
    this.memorySecret ??= made;
    return this.memorySecret;
  }

  /** For checking incoming alerts only. */
  secretForCheck() {
    return this.secrets?.get('whatsapp') || this.memorySecret || null;
  }

  // ---------- running the connector ----------

  /** The exact way the connector is started. The secret is in it, so it is never shown or logged. */
  async spec(program, node) {
    const allowed = (Array.isArray(this.config.whatsapp?.brainTools) ? this.config.whatsapp.brainTools : SAFE_TOOLS)
      .map(String).filter(name => !NEVER_FOR_BRAIN.has(name));
    return {
      command: node.path,
      args: ['--no-deprecation', path.join(program.dir, 'dist', 'index.js')],
      cwd: this.folder,
      exactEnv: true,
      stderr: 'pipe',
      silent: true,
      env: {
        WHATSAPP_BACKEND: 'baileys',
        BAILEYS_SESSION_DIR: this.sessionDir,
        WHATSAPP_WEBHOOK_URL: `http://127.0.0.1:${this.getPort()}/hooks/whatsapp`,
        WHATSAPP_WEBHOOK_SECRET: await this.webhookSecret(),
        WHATSAPP_WEBHOOK_EVENTS: CALL_EVENTS,
      },
      brainTools: allowed,
      trusted: SAFE_TOOLS,
    };
  }

  /** Starts the connector (if it can) and keeps it running. */
  async start() {
    if (this.running) return this.view();
    if (typeof this.connectors?.add !== 'function') return this.problem('WhatsApp cannot be linked in this copy.');
    const [program, node] = await Promise.all([this.locate(), this.findNode({ fresh: true })]);
    if (!program.ok) return this.problem(program.message);
    if (!node.ok) return this.problem(node.message);
    await fs.mkdir(this.sessionDir, { recursive: true });
    const spec = await this.spec(program, node);
    if (this.running) return this.view();
    this.running = true;
    this.program = program;
    this.everConnected = false;
    this.problemText = null;
    this.setState('starting');
    this.connectors.ownDeclineTool = `${this.name}/reject_call`;
    await this.connectors.add(this.name, spec);
    this.schedule(0);
    return this.view();
  }

  /** Stops the connector. With `disable`, it also stays off at the next start. */
  async stop({ disable = false } = {}) {
    const wasRunning = this.running;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.connectors) {
      if (this.connectors.ownDeclineTool === `${this.name}/reject_call`) this.connectors.ownDeclineTool = null;
      if (wasRunning) await this.connectors.remove?.(this.name);
    }
    this.problemText = null;
    this.setState('off');
    if (disable) await this.setEnabled(false);
    return this.view();
  }

  async setEnabled(on) {
    this.config.whatsapp = { ...(this.config.whatsapp ?? {}), enabled: on };
    await this.save({ whatsapp: { enabled: on } }).catch(() => {});
  }

  /** "Link WhatsApp": switch it on (also for the next start) and start the connector. */
  async link() {
    await this.setEnabled(true);
    return this.start();
  }

  problem(text) {
    this.problemText = text;
    this.setState('problem', text);
    return this.view();
  }

  /** The connector stopped or could not start; Connectors starts it again after `delay`. */
  restarting(delay) {
    const seconds = Math.max(1, Math.round(delay / 1000));
    const printed = this.connectors.printed?.get(this.name)?.at(-1) ?? null;
    if (this.everConnected) {
      this.everConnected = false;
      if (this.wasLinked) this.toldDropped = true;
      this.emit('note', `The WhatsApp helper stopped. It is started again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`);
    }
    this.problemText = printed;
    this.setState('restarting');
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      await this.refresh();
      this.schedule(this.state === 'linked' ? this.pollMs.linked : this.pollMs.waiting);
    }, ms);
    this.timer.unref?.();
  }

  /** Asks the connector how the link is doing. */
  refresh() {
    if (!this.running || !this.connectors.isConnected?.(this.name)) return Promise.resolve(this.view());
    this.refreshing ??= (async () => {
      try {
        const result = await this.connectors.callRaw(this.name, 'get_backend_status', {}, { connect: false });
        const text = (result.content ?? []).find(part => part.type === 'text')?.text ?? '{}';
        const status = JSON.parse(text);
        const state = status.connection?.state ?? (status.authenticated ? 'linked' : 'connecting');
        this.problemText = null;
        this.setState(state, typeof status.connection?.summary === 'string' ? status.connection.summary : '');
      } catch { /* it answers next time, or Connectors notices that it is gone */ }
      return this.view();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * Follows the link; says something in the console only when it really changes. A short drop
   * (WhatsApp often reconnects once right after linking) says nothing; one that lasts says so.
   */
  setState(state, detail = '') {
    const before = this.state;
    this.state = state;
    this.summary = detail;
    if (before !== state) this.stateSince = Date.now();
    if (state === 'reconnecting' && this.wasLinked && !this.toldDropped && Date.now() - this.stateSince >= this.dropNoticeMs) {
      this.toldDropped = true;
      this.emit('note', 'WhatsApp lost its connection. It is reconnecting by itself; nothing needs to be scanned.');
    }
    if (before === state) return;
    if (state === 'linked') {
      if (!this.wasLinked) this.emit('note', 'WhatsApp is linked. Incoming calls show up here.');
      else if (this.toldDropped) this.emit('note', 'WhatsApp is connected again.');
      this.wasLinked = true;
      this.toldDropped = false;
    } else if (state === 'waiting_for_link' && this.wasLinked && !this.unlinking) {
      this.wasLinked = false;
      this.emit('note', 'WhatsApp is no longer linked. Say "link whatsapp" to link it again.');
    } else if (state === 'waiting_for_other_program') {
      this.emit('note', 'Another program is using CINCO ID\'s WhatsApp sign-in, so WhatsApp waits until it closes.');
    }
    if (state === 'off') { this.wasLinked = false; this.toldDropped = false; }
    this.emit('change', this.view());
  }

  /** The state in plain words for the Setup window and the console. */
  describe() {
    switch (this.state) {
      case 'off': return 'WhatsApp is not linked.';
      case 'starting': return 'Starting the WhatsApp helper...';
      case 'connecting': return 'Connecting to WhatsApp...';
      case 'waiting_for_link': return 'Waiting for your phone to scan the code.';
      case 'linked': return 'Linked. CINCO ID is one of the linked devices on your WhatsApp.';
      case 'reconnecting': return 'The connection to WhatsApp dropped. It is reconnecting by itself; nothing needs to be scanned.';
      case 'waiting_for_other_program': return 'Another program is using this sign-in. WhatsApp waits until it closes.';
      case 'restarting': return `The WhatsApp helper stopped and is started again shortly.${this.problemText ? ` (It said: ${this.problemText})` : ''}`;
      case 'problem': return this.problemText ?? 'Something is wrong with the WhatsApp link.';
      default: return this.summary || 'Not connected to WhatsApp right now.';
    }
  }

  view() {
    return {
      enabled: this.enabled,
      running: this.running,
      connected: Boolean(this.running && this.connectors?.isConnected?.(this.name)),
      state: this.state,
      linked: this.state === 'linked',
      text: this.describe(),
      signInFolder: this.sessionDir,
    };
  }

  /** Everything the WhatsApp page in Setup shows. */
  async overview() {
    const [program, node, git] = await Promise.all([this.locate(), this.findNode(), this.findCommand('git')]);
    return {
      ...this.view(),
      program: { found: program.found, ok: program.ok, dir: program.dir, source: program.source, version: program.version, tooOld: Boolean(program.tooOld), message: program.message },
      node: { found: node.found, ok: node.ok, version: node.version, message: node.message },
      git: { found: Boolean(git) },
      install: this.installStatus(),
      wanted: { version: CONNECTOR.version, minVersion: CONNECTOR.minVersion, minNode: CONNECTOR.minNode },
    };
  }

  /** The QR code as a picture while it waits to be linked, or null. */
  qr() {
    if (!this.running || this.state === 'linked' || !this.connectors.isConnected?.(this.name)) return Promise.resolve(null);
    this.qrPending ??= this.connectors.callRaw(this.name, 'get_qr_code', {}, { connect: false })
      .then(result => {
        const image = (result.content ?? []).find(part => part.type === 'image' && part.mimeType === 'image/png' && /^[A-Za-z0-9+/]+={0,2}$/.test(part.data ?? ''));
        return image ? `data:image/png;base64,${image.data}` : null;
      })
      .catch(() => null)
      .finally(() => { this.qrPending = null; });
    return this.qrPending;
  }

  /** The second way: a code to type on the phone. Only digits are passed on. */
  async pairingCode(phone) {
    const digits = String(phone ?? '').replace(/[\s()+.-]/g, '');
    if (!/^\d{7,15}$/.test(digits)) throw Object.assign(new Error('Type the phone number with the country code, digits only, for example 4915112345678.'), { status: 400, field: 'whatsappPhone' });
    if (!this.running || !this.connectors.isConnected?.(this.name)) throw Object.assign(new Error('Press "Link WhatsApp" first.'), { status: 409 });
    const result = await this.connectors.callRaw(this.name, 'request_pairing_code', { phone_number: digits }, { connect: false });
    const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (/already authenticated/i.test(text)) return { code: null, message: 'WhatsApp is already linked.' };
    const code = /Pairing code:\s*([A-Z0-9-]{4,12})/i.exec(text)?.[1] ?? null;
    if (result.isError || !code) throw Object.assign(new Error(`No code came back. ${text.split('\n')[0].slice(0, 200)}`.trim()), { status: 502 });
    return { code: code.toUpperCase(), message: 'On your phone, open WhatsApp, Settings, Linked devices, Link a device, then "Link with phone number instead", and type this code.' };
  }

  /** "Unlink": the connector signs out of WhatsApp, then it is stopped and stays off. */
  async unlink() {
    this.unlinking = true;
    try {
      if (this.running && this.connectors.isConnected?.(this.name)) {
        const result = await this.connectors.callRaw(this.name, 'logout', {}, { connect: false });
        if (result.isError) {
          const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join(' ');
          throw Object.assign(new Error(`WhatsApp could not be unlinked: ${text.slice(0, 200)}`), { status: 502 });
        }
      }
      await this.stop({ disable: true });
    } finally { this.unlinking = false; }
    this.emit('note', 'WhatsApp was unlinked.');
    return this.view();
  }

  // ---------- Install ----------

  installStatus() {
    if (!this.task) return { running: false, ok: null, message: '', step: 0, steps: 3, lines: [] };
    const { child, timer, ...visible } = this.task;
    return visible;
  }

  /**
   * Fetches exactly the pinned version of the connector into <data>/whatsapp/connector and builds
   * it, only when the person pressed Install. Needs Git and Node.js (with npm) on the PC.
   */
  async install() {
    if (this.task?.running) throw Object.assign(new Error('Install is already running.'), { status: 409 });
    const node = await this.findNode({ fresh: true });
    if (!node.ok) throw Object.assign(new Error(node.message), { status: 409 });
    const git = await this.findCommand('git');
    if (!git) throw Object.assign(new Error('Git is not on this PC. Install Git for Windows from git-scm.com, then press Install again.'), { status: 409 });
    const npmCli = await this.findNpm(node.path);
    if (!npmCli) throw Object.assign(new Error('npm was not found next to Node.js. Install Node.js again from nodejs.org, then press Install again.'), { status: 409 });
    const { repo, commit } = installSource(this.env);
    const task = { running: true, ok: null, step: 1, steps: 3, message: 'Downloading the WhatsApp connector (step 1 of 3)...', lines: [], startedAt: Date.now() };
    this.task = task;
    this.installing = (async () => {
      const part = `${this.installDir}.part`;
      try {
        // The running connector may be using the installed copy; it is started again afterwards.
        const restart = this.running && this.program?.dir === this.installDir;
        if (restart) await this.stop();
        await fs.mkdir(this.folder, { recursive: true });
        await fs.rm(part, { recursive: true, force: true });
        const gitEnv = { ...this.cleanEnv(), GIT_TERMINAL_PROMPT: '0' };
        await this.step(task, git, ['clone', '--quiet', '--no-checkout', repo, part], { cwd: this.folder, env: gitEnv, timeoutMs: 10 * 60_000 }, 'The download did not work');
        Object.assign(task, { step: 2, message: `Picking version ${CONNECTOR.version} (step 2 of 3)...` });
        await this.step(task, git, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit], { cwd: part, env: gitEnv, timeoutMs: 120_000 }, 'The right version could not be picked');
        const head = await this.run(git, ['rev-parse', 'HEAD'], { env: gitEnv, timeoutMs: 30_000, cwd: part });
        if (!head.stdout.trim().toLowerCase().startsWith(commit)) throw new Error('The downloaded copy is not the expected version, so it was not used.');
        Object.assign(task, { step: 3, message: 'Installing its parts and building it. This takes a few minutes (step 3 of 3)...' });
        await this.step(task, node.path, [npmCli, 'ci', '--no-audit', '--no-fund', '--loglevel=error'], {
          cwd: part, env: { ...this.cleanEnv(), PUPPETEER_SKIP_DOWNLOAD: '1', npm_config_update_notifier: 'false' }, timeoutMs: 30 * 60_000,
        }, 'Installing its parts did not work');
        const ready = await readConnectorFolder(part);
        if (!ready.ok) throw new Error(ready.message.replace(part, 'the new copy'));
        await fs.rm(this.installDir, { recursive: true, force: true });
        await fs.rename(part, this.installDir);
        Object.assign(task, { running: false, ok: true, message: `The WhatsApp connector ${ready.version} is installed.`, finishedAt: Date.now() });
        if (restart || this.enabled) await this.start();
      } catch (error) {
        await fs.rm(part, { recursive: true, force: true }).catch(() => {});
        Object.assign(task, { running: false, ok: false, message: error.message, finishedAt: Date.now() });
      }
    })();
    return this.installStatus();
  }

  /** The environment for Install's programs, without anything an enclosing npm run put there. */
  cleanEnv() {
    return Object.fromEntries(Object.entries(this.env).filter(([key]) => !/^npm_/i.test(key)));
  }

  /** Runs one fixed program for Install and keeps its last lines. */
  step(task, command, args, { cwd, env, timeoutMs }, failure) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { reject(new Error(`${failure}: ${error.message}`)); return; }
      task.child = child;
      const note = line => {
        const clean = String(line).replace(ANSI, '').trim();
        if (!clean) return;
        task.lines.push(clean.slice(0, 300));
        task.lines = task.lines.slice(-6);
      };
      if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', note);
      if (child.stderr) readline.createInterface({ input: child.stderr }).on('line', note);
      task.timer = setTimeout(() => { task.timedOut = true; child.kill(); }, timeoutMs);
      task.timer.unref?.();
      child.on('error', error => { clearTimeout(task.timer); reject(new Error(`${failure}: ${error.message}`)); });
      child.on('exit', code => {
        clearTimeout(task.timer);
        task.child = null;
        if (code === 0) resolve();
        else reject(new Error(task.timedOut ? `${failure}: it took too long and was stopped.` : `${failure} (code ${code}). ${task.lines.at(-1) ?? ''}`.trim()));
      });
    });
  }

  /** When the app quits. */
  async close() {
    if (this.task?.running) { clearTimeout(this.task.timer); this.task.child?.kill(); }
    await this.stop();
  }
}
