import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Outside tools the brain may use (WhatsApp, calendars, a swarm engine, anything that offers
 * an MCP server). Listed in harness.config.json under "mcpServers", either as
 * { "command": "...", "args": [...], "env": {...} } or { "url": "http://127.0.0.1:1234/mcp" }.
 *
 * Tools that are not marked read-only by their server need a Yes from the operator each time.
 */
export class Connectors {
  constructor(servers = {}, { declineTool = null, onProblem = () => {} } = {}) {
    this.servers = servers;
    this.declineTool = declineTool;
    this.onProblem = onProblem;
    this.clients = new Map();
    this.toolList = [];
  }

  async start() {
    await Promise.all(Object.entries(this.servers).map(async ([name, spec]) => {
      if (spec.disabled) return;
      try {
        const client = new Client({ name: 'beta-sequence', version: '0.1.0' });
        const transport = spec.url
          ? new StreamableHTTPClientTransport(new URL(spec.url), spec.headers ? { requestInit: { headers: spec.headers } } : undefined)
          : new StdioClientTransport({ command: spec.command, args: spec.args ?? [], env: { ...process.env, ...(spec.env ?? {}) }, cwd: spec.cwd, stderr: 'ignore' });
        await client.connect(transport);
        const { tools } = await client.listTools();
        this.clients.set(name, client);
        for (const tool of tools) {
          if (spec.only && !spec.only.includes(tool.name)) continue;
          this.toolList.push({
            name: `${name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
            label: `${name}: ${tool.name}`,
            server: name,
            tool: tool.name,
            description: `[${name}] ${tool.description ?? ''}`.slice(0, 1000),
            parameters: tool.inputSchema ?? { type: 'object', properties: {} },
            readOnly: tool.annotations?.readOnlyHint === true || (spec.trusted ?? []).includes(tool.name),
            run: args => this.call(name, tool.name, args),
          });
        }
      } catch (error) {
        this.onProblem(`Could not connect to "${name}": ${error.message}`);
      }
    }));
    return this;
  }

  tools() { return this.toolList; }

  async call(server, tool, args) {
    const client = this.clients.get(server);
    if (!client) throw new Error(`"${server}" is not connected.`);
    const result = await client.callTool({ name: tool, arguments: args ?? {} });
    const text = (result.content ?? []).map(part => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n');
    if (result.isError) throw new Error(text || 'the tool reported a problem');
    return text || 'Done.';
  }

  /** "server/tool" from the settings, when that tool really exists. */
  declineTarget() {
    if (!this.declineTool) return null;
    const [server, tool] = this.declineTool.split('/');
    return this.toolList.find(entry => entry.server === server && entry.tool === tool) ?? null;
  }

  canDeclineCalls() { return Boolean(this.declineTarget()); }

  async declineCall(callId) {
    const target = this.declineTarget();
    if (!target) throw new Error('declining calls is not connected');
    return this.call(target.server, target.tool, { call_id: callId });
  }

  async stop() {
    await Promise.all([...this.clients.values()].map(client => client.close().catch(() => {})));
    this.clients.clear();
    this.toolList = [];
  }
}
