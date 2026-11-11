import { EventEmitter } from 'node:events';
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
 */

// Waits between attempts to reach a server that is not there: soon at first, then every two minutes.
const RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

/** Errors that mean the connection was the problem, not the tool or what was asked of it. */
export function isConnectionProblem(error) {
  if (error instanceof McpError) return error.code === ErrorCode.ConnectionClosed;
  return true;
}

export class Connectors extends EventEmitter {
  constructor(servers = {}, { declineTool = null, onProblem = () => {}, retryMs = RETRY_MS, makeTransport = null } = {}) {
    super();
    this.servers = servers;
    this.declineTool = declineTool;
    this.onProblem = onProblem;
    this.retryMs = retryMs;
    this.makeTransport = makeTransport;
    this.clients = new Map();
    this.serverTools = new Map(); // server name -> its tools
    this.toolList = [];
    this.attempts = new Map();
    this.timers = new Map();
    this.connecting = new Map();
    this.stopped = false;
  }

  async start() {
    await Promise.all(Object.entries(this.servers).map(([name, spec]) => (spec.disabled ? null : this.connect(name, { quiet: false }))));
    return this;
  }

  transportFor(spec) {
    if (this.makeTransport) return this.makeTransport(spec);
    return spec.url
      ? new StreamableHTTPClientTransport(new URL(spec.url), spec.headers ? { requestInit: { headers: spec.headers } } : undefined)
      : new StdioClientTransport({ command: spec.command, args: spec.args ?? [], env: { ...process.env, ...(spec.env ?? {}) }, cwd: spec.cwd, stderr: 'ignore' });
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
      const client = new Client({ name: 'cinco-id', version: '2.5.0' });
      try {
        await client.connect(this.transportFor(spec));
        const { tools } = await client.listTools();
        if (this.stopped) { await client.close().catch(() => {}); return false; }
        client.onclose = () => { if (this.clients.get(name) === client) this.lost(name); };
        this.clients.set(name, client);
        this.serverTools.set(name, tools
          .filter(tool => !spec.only || spec.only.includes(tool.name))
          .map(tool => ({
            name: `${name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
            label: `${name}: ${tool.name}`,
            server: name,
            tool: tool.name,
            description: `[${name}] ${tool.description ?? ''}`.slice(0, 1000),
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
            readOnly: tool.annotations?.readOnlyHint === true || (spec.trusted ?? []).includes(tool.name),
            run: args => this.call(name, tool.name, args),
          })));
        this.attempts.delete(name);
        this.refreshTools();
        if (quiet) this.emit('note', `"${name}" is connected now.`);
        return true;
      } catch (error) {
        await client.close().catch(() => {});
        if (!quiet) this.onProblem(`Could not connect to "${name}": ${error.message}. Trying again in the background.`);
        this.retryLater(name);
        return false;
      } finally {
        this.connecting.delete(name);
      }
    })();
    this.connecting.set(name, attempt);
    return attempt;
  }

  retryLater(name) {
    if (this.stopped || this.timers.has(name)) return;
    const tries = this.attempts.get(name) ?? 0;
    this.attempts.set(name, tries + 1);
    const timer = setTimeout(() => { this.timers.delete(name); this.connect(name); }, this.retryMs[Math.min(tries, this.retryMs.length - 1)]);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  /** A server went away: forget its tools and try again in the background. */
  lost(name) {
    const client = this.clients.get(name);
    this.clients.delete(name);
    if (client) { client.onclose = null; client.close().catch(() => {}); }
    if (this.serverTools.delete(name)) this.refreshTools();
    this.retryLater(name);
  }

  refreshTools() {
    this.toolList = [...this.serverTools.values()].flat();
    this.emit('change');
  }

  tools() { return this.toolList; }

  async call(server, tool, args) {
    let client = this.clients.get(server);
    if (!client && !(await this.connect(server))) throw new Error(`"${server}" is not connected.`);
    client = this.clients.get(server);
    let result;
    try {
      result = await client.callTool({ name: tool, arguments: args ?? {} });
    } catch (error) {
      if (!isConnectionProblem(error)) throw error;
      // The connection dropped: connect again once and try once more.
      this.lost(server);
      if (!(await this.connect(server))) throw new Error(`"${server}" is not reachable right now (${error.message}).`);
      result = await this.clients.get(server).callTool({ name: tool, arguments: args ?? {} });
    }
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

  /** "server/tool" from the settings, when that tool really exists. */
  declineTarget() {
    if (!this.declineTool) return null;
    const [server, tool] = this.declineTool.split('/');
    return this.toolList.find(entry => entry.server === server && entry.tool === tool) ?? null;
  }

  canDeclineCalls() { return Boolean(this.declineTarget()); }

  /** Makes sure "can decline" is true only while the decline tool's server really answers. */
  async checkDecline() {
    if (!this.declineTool) return false;
    await this.check(this.declineTool.split('/')[0]);
    return this.canDeclineCalls();
  }

  async declineCall(callId) {
    const target = this.declineTarget();
    if (!target) throw new Error('declining calls is not connected');
    return this.call(target.server, target.tool, { call_id: callId });
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.clients.values()].map(client => { client.onclose = null; return client.close().catch(() => {}); }));
    this.clients.clear();
    this.serverTools.clear();
    this.toolList = [];
  }
}
