import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * Outside tools the brain may use (WhatsApp, calendars, a swarm engine, anything that offers
 * an MCP server). Listed in harness.config.json under "mcpServers", either as
 * { "command": "...", "args": [...], "env": {...} } or { "url": "http://127.0.0.1:1234/mcp" }.
 *
 * Tools that are not marked read-only by their server need a Yes from the operator each time.
 *
 * Outside programs come and go (the shared WhatsApp connector may start after this app, or
 * restart). A server that cannot be reached is tried again quietly in the background, and a call
 * that fails because the connection dropped reconnects once and tries again. "change" is emitted
 * whenever a server comes or goes, so the screen can follow (for example the Decline button).
 *
 * The app can also add servers of its own while it runs (its own WhatsApp connector, see
 * whatsapp.js). Those may say which of their tools the brain may see (`brainTools`), get exactly
 * the environment they are given (`exactEnv`), and keep the last lines their program printed
 * (`stderr: "pipe"`), so a problem can be explained.
 */

// Waits between attempts to reach a server that is not there: soon at first, then every two minutes.
const RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
// A server that stayed connected this long starts again from the shortest wait when it drops.
const STEADY_MS = 60_000;

/** Errors that mean the connection was the problem, not the tool or what was asked of it. */
export function isConnectionProblem(error) {
  if (error instanceof McpError) return error.code === ErrorCode.ConnectionClosed;
  return true;
}

export class Connectors extends EventEmitter {
  constructor(servers = {}, { declineTool = null, onProblem = () => {}, retryMs = RETRY_MS, makeTransport = null, steadyMs = STEADY_MS } = {}) {
    super();
    this.servers = { ...servers };
    this.declineTool = declineTool; // "server/tool" from the settings (a connector run by another program)
    this.ownDeclineTool = null; // "server/tool" of the app's own WhatsApp connector, while it runs
    this.onProblem = onProblem;
    this.retryMs = retryMs;
    this.steadyMs = steadyMs;
    this.makeTransport = makeTransport;
    this.clients = new Map();
    this.serverTools = new Map(); // server name -> all of its tools
    this.allTools = [];
    this.toolList = []; // the ones the brain may see
    this.attempts = new Map();
    this.timers = new Map();
    this.connecting = new Map();
    this.connectedAt = new Map();
    this.printed = new Map(); // server name -> last lines its program printed (stderr: "pipe" only)
    this.stopped = false;
  }

  async start() {
    await Promise.all(Object.entries(this.servers).map(([name, spec]) => (spec.disabled ? null : this.connect(name, { quiet: false }))));
    return this;
  }

  transportFor(spec, name) {
    if (this.makeTransport) return this.makeTransport(spec, name);
    if (spec.url) return new StreamableHTTPClientTransport(new URL(spec.url), spec.headers ? { requestInit: { headers: spec.headers } } : undefined);
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      // exactEnv: only what is given (plus the few basics every program needs, added by the SDK).
      env: spec.exactEnv ? { ...(spec.env ?? {}) } : { ...process.env, ...(spec.env ?? {}) },
      cwd: spec.cwd,
      stderr: spec.stderr === 'pipe' ? 'pipe' : 'ignore',
    });
    if (spec.stderr === 'pipe' && transport.stderr) {
      // Always read it, or a chatty program would stop once the pipe is full.
      const lines = [];
      this.printed.set(name, lines);
      readline.createInterface({ input: transport.stderr }).on('line', line => {
        const clean = String(line).replace(/whsec_[A-Za-z0-9+/=]+/g, 'whsec_...').trim();
        if (!clean) return;
        lines.push(clean.slice(0, 400));
        if (lines.length > 20) lines.shift();
      });
    }
    return transport;
  }

  /** Connects one server (once at a time). Returns true when it is there. */
  connect(name, { quiet = true } = {}) {
    if (this.stopped) return Promise.resolve(false);
    if (this.connecting.has(name)) return this.connecting.get(name);
    const spec = this.servers[name];
    if (!spec || spec.disabled) return Promise.resolve(false);
    const attempt = (async () => {
      clearTimeout(this.timers.get(name));
      this.timers.delete(name);
      const client = new Client({ name: 'cinco-id', version: '2.5.1' });
      try {
        await client.connect(this.transportFor(spec, name));
        const { tools } = await client.listTools();
        if (this.stopped || this.servers[name] !== spec) { await client.close().catch(() => {}); return false; }
        client.onclose = () => { if (this.clients.get(name) === client) this.lost(name); };
        this.clients.set(name, client);
        this.connectedAt.set(name, Date.now());
        const trusted = spec.trusted ?? [];
        this.serverTools.set(name, tools
          .filter(tool => !spec.only || spec.only.includes(tool.name))
          .map(tool => ({
            name: `${name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
            label: `${name}: ${tool.name}`,
            server: name,
            tool: tool.name,
            description: `[${name}] ${tool.description ?? ''}`.slice(0, 1000),
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
            readOnly: tool.annotations?.readOnlyHint === true || trusted.includes(tool.name),
            forBrain: !spec.brainTools || spec.brainTools.includes(tool.name),
            run: args => this.call(name, tool.name, args),
          })));
        this.refreshTools();
        if (quiet && !spec.silent) this.emit('note', `"${name}" is connected now.`);
        this.emit('connected', name);
        return true;
      } catch (error) {
        await client.close().catch(() => {});
        if (!quiet && !spec.silent) this.onProblem(`Could not connect to "${name}": ${error.message}. Trying again in the background.`);
        this.retryLater(name, error.message);
        return false;
      } finally {
        this.connecting.delete(name);
      }
    })();
    this.connecting.set(name, attempt);
    return attempt;
  }

  retryLater(name, reason = null) {
    if (this.stopped || this.timers.has(name) || !this.servers[name]) return;
    const tries = this.attempts.get(name) ?? 0;
    this.attempts.set(name, tries + 1);
    const delay = this.retryMs[Math.min(tries, this.retryMs.length - 1)];
    const timer = setTimeout(() => { this.timers.delete(name); this.connect(name); }, delay);
    timer.unref?.();
    this.timers.set(name, timer);
    this.emit('retry', name, delay, reason);
  }

  /** A server went away: forget its tools and try again in the background. */
  lost(name) {
    const client = this.clients.get(name);
    this.clients.delete(name);
    if (client) { client.onclose = null; client.close().catch(() => {}); }
    // One that had been there for a while starts again soon; one that keeps falling over waits longer each time.
    const since = this.connectedAt.get(name);
    this.connectedAt.delete(name);
    if (since && Date.now() - since >= this.steadyMs) this.attempts.delete(name);
    if (this.serverTools.delete(name)) this.refreshTools();
    this.emit('lost', name);
    this.retryLater(name, 'it stopped');
  }

  refreshTools() {
    this.allTools = [...this.serverTools.values()].flat();
    this.toolList = this.allTools.filter(tool => tool.forBrain);
    this.emit('change');
  }

  /** The tools the brain may use. */
  tools() { return this.toolList; }

  isConnected(name) { return this.clients.has(name); }

  /** Adds a server while the app runs (for example the app's own WhatsApp connector) and connects it. */
  add(name, spec) {
    this.servers[name] = spec;
    this.attempts.delete(name);
    return this.connect(name);
  }

  /** Stops a server added with add(): its program is asked to end, and it is not tried again. */
  async remove(name) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    this.attempts.delete(name);
    delete this.servers[name];
    await this.connecting.get(name)?.catch(() => false);
    const client = this.clients.get(name);
    this.clients.delete(name);
    this.connectedAt.delete(name);
    if (this.serverTools.delete(name)) this.refreshTools();
    if (client) { client.onclose = null; await client.close().catch(() => {}); }
  }

  /** Calls a tool and returns everything it answered (text, pictures). */
  async callRaw(server, tool, args, { connect = true } = {}) {
    let client = this.clients.get(server);
    if (!client) {
      if (!connect || !(await this.connect(server))) throw new Error(`"${server}" is not connected.`);
      client = this.clients.get(server);
    }
    try {
      return await client.callTool({ name: tool, arguments: args ?? {} });
    } catch (error) {
      if (!isConnectionProblem(error) || !connect) throw error;
      // The connection dropped: connect again once and try once more.
      this.lost(server);
      if (!(await this.connect(server))) throw new Error(`"${server}" is not reachable right now (${error.message}).`);
      return this.clients.get(server).callTool({ name: tool, arguments: args ?? {} });
    }
  }

  async call(server, tool, args) {
    const result = await this.callRaw(server, tool, args);
    const text = (result.content ?? []).map(part => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n');
    if (result.isError) throw new Error(text || 'the tool reported a problem');
    return text || 'Done.';
  }

  /**
   * Checks that a server is really there (a call is about to need it, e.g. an incoming call that
   * may be declined). Marks it lost when it does not answer. Returns whether it is there.
   */
  async check(server) {
    const client = this.clients.get(server);
    if (!client) return this.connect(server);
    try {
      await client.ping({ timeout: 5_000 });
      return true;
    } catch {
      this.lost(server);
      return this.connect(server);
    }
  }

  /**
   * Who can decline a call, best first. A call is declined by the WhatsApp connection that
   * reported it ("own": the app's own connector; "manual": the one named in the settings).
   * If that one is not there right now, the other one is tried.
   */
  declineTargets(via = null) {
    const own = this.ownDeclineTool;
    const manual = this.declineTool;
    const order = via === 'own' ? [own, manual] : via === 'manual' ? [manual, own] : [manual, own];
    const found = [];
    for (const wanted of order) {
      if (!wanted) continue;
      const [server, tool] = wanted.split('/');
      const target = this.allTools.find(entry => entry.server === server && entry.tool === tool);
      if (target && !found.includes(target)) found.push(target);
    }
    return found;
  }

  /** "server/tool" from the settings, when that tool really exists (the first choice for `via`). */
  declineTarget(via = null) { return this.declineTargets(via)[0] ?? null; }

  canDeclineCalls(via = null) { return this.declineTargets(via).length > 0; }

  /** Makes sure "can decline" is true only while a decline tool's server really answers. */
  async checkDecline(via = null) {
    const servers = [this.declineTool, this.ownDeclineTool].filter(Boolean).map(wanted => wanted.split('/')[0]);
    if (!servers.length) return false;
    await Promise.all([...new Set(servers)].map(server => this.check(server).catch(() => false)));
    return this.canDeclineCalls(via);
  }

  async declineCall(callId, via = null) {
    const targets = this.declineTargets(via);
    if (!targets.length) throw new Error('declining calls is not connected');
    let problem = null;
    for (const target of targets) {
      try {
        return await this.call(target.server, target.tool, { call_id: callId });
      } catch (error) {
        // The tool answered (for example: the call already stopped ringing): that is the answer.
        if (this.clients.has(target.server)) throw error;
        problem = error;
      }
    }
    throw problem ?? new Error('declining calls is not connected');
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.clients.values()].map(client => { client.onclose = null; return client.close().catch(() => {}); }));
    this.clients.clear();
    this.serverTools.clear();
    this.allTools = [];
    this.toolList = [];
  }
}
