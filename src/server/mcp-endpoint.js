import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { controlTools, summarise } from './brain.js';

/**
 * Lets other programs operate the screen: the computer's own brain when it runs through the
 * Claude command-line tool, and any outside agent you connect (FLUJO, Claude Code, Codex, a
 * swarm). It speaks MCP over local HTTP at /mcp and needs the access token.
 *
 * `scope` "brain" gets the screen tools plus the connected outside tools (which still ask the
 * operator for a Yes). `scope` "guest" gets the screen tools plus `command` and `say`.
 */
function toolsFor(computer, scope) {
  const tools = [...controlTools(computer)];
  if (scope === 'brain') return [...tools, ...(computer.connectors?.tools() ?? [])];
  tools.push(
    {
      name: 'command', readOnly: true,
      description: 'Say something to the computer exactly as the operator would, for example "load up Celery Man", "kick up the 4d3d3d3", "can I get a hat wobble". Returns what the computer answered.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: async ({ text }) => {
        const before = computer.log.length;
        await computer.hear(String(text), { source: 'agent' });
        return computer.log.slice(before).filter(line => line.who === 'computer').map(line => line.text).join(' ') || 'Done.';
      },
    },
    {
      name: 'say', readOnly: true,
      description: 'Make the computer say one short sentence aloud in its own voice.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: async ({ text }) => { computer.say(String(text).slice(0, 300)); return 'Said.'; },
    },
  );
  return tools;
}

export async function handleMcp(request, response, body, { computer, scope }) {
  const tools = toolsFor(computer, scope);
  const server = new Server({ name: 'cinco-id', version: '2.5.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters ?? { type: 'object', properties: {} },
      annotations: { readOnlyHint: tool.readOnly === true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async call => {
    const tool = tools.find(candidate => candidate.name === call.params.name);
    try {
      if (!tool) throw new Error(`There is no tool called ${call.params.name}.`);
      const args = call.params.arguments ?? {};
      if (!tool.readOnly && !(await computer.confirm(`${tool.label ?? tool.name}\n\n${summarise(args)}`))) {
        return { content: [{ type: 'text', text: 'The operator said no. Do not try again.' }] };
      }
      return { content: [{ type: 'text', text: String(await tool.run(args)).slice(0, 12_000) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `That did not work: ${error.message}` }], isError: true };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
