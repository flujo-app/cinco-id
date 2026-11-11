#!/usr/bin/env node
// A stand-in for the WhatsApp connector (mcp-whatsapp-web), for tests only. It never talks to
// WhatsApp. It speaks MCP over stdio (one JSON message per line) with no packages at all, so it
// can also be "installed" from a local folder by the Install button in a test.
//
// It answers like the real connector: get_backend_status, check_auth_status, get_qr_code (a real
// small PNG), request_pairing_code, logout, reject_call, search_contacts, get_contact_by_id and
// send_message. A test steers it with files:
//   <sign-in folder>/scan      the phone "scanned the code": it becomes linked
//   <work folder>/ring.json    sends a correctly signed call.received to the address it was given
//   <work folder>/hang-up.json sends call.ended
//   <work folder>/drop         while it exists, the connection is "reconnecting"
//   <work folder>/crash        it stops at once, as if it crashed
// and it writes down what happened (stand-in-*.json) in its work folder.
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const work = process.cwd();
const session = path.resolve(process.env.BAILEYS_SESSION_DIR || path.join(work, 'baileys-sessions'));
mkdirSync(session, { recursive: true });
mkdirSync(path.join(work, 'logs'), { recursive: true });
const secret = process.env.WHATSAPP_WEBHOOK_SECRET ?? '';
const sha = text => createHash('sha256').update(String(text)).digest('hex');
const write = (name, value) => writeFileSync(path.join(work, name), JSON.stringify(value, null, 2));
const remember = (name, value) => {
  const file = path.join(work, name);
  let list = [];
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first */ }
  list.push(value);
  writeFileSync(file, JSON.stringify(list, null, 2));
};
const log = text => appendFileSync(path.join(work, 'logs', 'stand-in.log'), `${new Date().toISOString()} ${text}\n`);

const secretBytes = /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) ? Buffer.from(secret.slice(6), 'base64').length : 0;
write('stand-in-started.json', {
  pid: process.pid,
  cwd: work,
  argv: process.argv.slice(1),
  env: { ...process.env, WHATSAPP_WEBHOOK_SECRET: secret ? `sha256:${sha(secret)}` : undefined },
  secretLooksRight: secretBytes >= 24 && secretBytes <= 64,
});
// Only so a test can make sure the secret never shows up anywhere; this is a throwaway folder.
writeFileSync(path.join(work, 'stand-in-secret.txt'), secret);
log(`Stand-in started (pid ${process.pid}), sign-in folder ${session}`);

let linked = existsSync(path.join(session, 'linked'));
let qrRound = 0;

// ---------- a real small PNG (a QR-like pattern; it changes every round) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function qrPicture(round) {
  const modules = 29;
  const scale = 6;
  const margin = 4;
  const size = (modules + margin * 2) * scale;
  let seed = 0x9e3779b9 ^ round;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const dark = Array.from({ length: modules }, () => Array.from({ length: modules }, () => random() < 0.5));
  const finder = (x0, y0) => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      dark[y0 + y][x0 + x] = ring !== 2;
    }
  };
  finder(0, 0); finder(modules - 7, 0); finder(0, modules - 7);
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size + 1);
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin;
      const my = Math.floor(y / scale) - margin;
      const on = mx >= 0 && my >= 0 && mx < modules && my < modules && dark[my][mx];
      row[x + 1] = on ? 0 : 255;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

// ---------- call alerts ----------

let cursor = 0;
async function alert(name, data) {
  const url = process.env.WHATSAPP_WEBHOOK_URL;
  const wanted = String(process.env.WHATSAPP_WEBHOOK_EVENTS ?? '').split(',').map(text => text.trim());
  if (!url || !wanted.includes(name)) { remember('stand-in-alerts.json', { name, sent: false }); return; }
  const eventId = `evt_${sha(`${name}:${data.callId}`).slice(0, 32)}`;
  const body = JSON.stringify({ eventId, name, timestamp: new Date().toISOString(), cursor: String(++cursor), data });
  const seconds = Math.floor(Date.now() / 1000);
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = `v1,${createHmac('sha256', key).update(`${eventId}.${seconds}.${body}`).digest('base64')}`;
  try {
    const response = await fetch(url, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': String(seconds), 'webhook-signature': signature },
    });
    remember('stand-in-alerts.json', { name, callId: data.callId, status: response.status });
  } catch (error) {
    remember('stand-in-alerts.json', { name, callId: data.callId, error: error.message });
  }
}

function callData(given) {
  const number = String(given.number ?? '15550100123');
  return {
    callId: String(given.callId ?? `CALL-${Date.now()}`),
    chatId: `${number}@s.whatsapp.net`,
    from: `${number}@s.whatsapp.net`,
    isVideo: given.isVideo === true,
    isGroup: false,
    status: 'ringing',
    contact: { id: `${number}@s.whatsapp.net`, name: given.name ?? 'Anna Example', pushname: given.pushname ?? 'Anna', number, isMyContact: given.isMyContact ?? true },
  };
}

// ---------- the test's signals ----------

const take = file => {
  if (!existsSync(file)) return null;
  let value = {};
  try { value = JSON.parse(readFileSync(file, 'utf8') || '{}'); } catch { /* an empty signal */ }
  rmSync(file, { force: true });
  return value;
};
setInterval(() => {
  if (take(path.join(session, 'scan')) && !linked) {
    linked = true;
    writeFileSync(path.join(session, 'linked'), 'stand-in');
    log('Linked (the phone "scanned" the code).');
  }
  if (take(path.join(work, 'crash'))) { log('Crashing on purpose.'); process.exit(3); }
  const ring = take(path.join(work, 'ring.json'));
  if (ring) alert('call.received', callData(ring));
  const end = take(path.join(work, 'hang-up.json'));
  if (end) alert('call.ended', { ...callData(end), reason: end.reason ?? 'missed' });
}, 100);

// ---------- the tools ----------

const state = () => (!linked ? 'waiting_for_link' : existsSync(path.join(work, 'drop')) ? 'reconnecting' : 'linked');
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const object = properties => ({ type: 'object', properties });

const TOOLS = {
  get_backend_status: {
    description: 'Report the selected WhatsApp backend and connection status (stand-in).',
    inputSchema: object({}),
    run: () => text({ backend: 'baileys', authenticated: state() === 'linked', connection: { state: state(), summary: `Stand-in: ${state()}.`, since: new Date().toISOString(), signInFolder: session } }),
  },
  check_auth_status: {
    description: 'Check if the WhatsApp client is authenticated (stand-in).',
    inputSchema: object({}),
    run: () => text(linked ? 'You are currently authenticated with WhatsApp.' : 'You are not currently authenticated with WhatsApp. Please use the get_qr_code tool.'),
  },
  get_qr_code: {
    description: 'Get the latest WhatsApp QR code as an image (stand-in).',
    inputSchema: object({}),
    run: () => (linked ? text('You are already authenticated with WhatsApp. No QR code is needed.')
      : { content: [{ type: 'image', data: qrPicture(Math.floor(qrRound++ / 5)), mimeType: 'image/png' }] }),
  },
  request_pairing_code: {
    description: 'Request a pairing code (stand-in).',
    inputSchema: { type: 'object', properties: { phone_number: { type: 'string' } }, required: ['phone_number'] },
    run: ({ phone_number: phone }) => {
      if (linked) return text('You are already authenticated with WhatsApp. No pairing code is needed.');
      remember('stand-in-pairing.json', { phone });
      return text('Pairing code: ABCD-EF12\n\nEnter this code on the phone with the WhatsApp account.');
    },
  },
  logout: {
    description: 'Logout from WhatsApp and clear the current session (stand-in).',
    inputSchema: object({}),
    run: () => {
      linked = false;
      rmSync(path.join(session, 'linked'), { force: true });
      remember('stand-in-logouts.json', { at: new Date().toISOString() });
      log('Logged out.');
      return text('Successfully logged out of WhatsApp.');
    },
  },
  reject_call: {
    description: 'Decline an incoming WhatsApp call (stand-in).',
    inputSchema: { type: 'object', properties: { call_id: { type: 'string' } }, required: ['call_id'] },
    run: ({ call_id: callId }) => {
      remember('stand-in-rejected.json', { callId });
      return text({ success: true, callId, message: 'Call declined.' });
    },
  },
  search_contacts: {
    description: 'Search contacts by name or number (stand-in).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: ({ query }) => text([{ id: '15550100123@s.whatsapp.net', name: 'Anna Example', number: '15550100123', query }]),
  },
  get_contact_by_id: {
    description: 'Get a contact by its id (stand-in).',
    inputSchema: { type: 'object', properties: { contact_id: { type: 'string' } }, required: ['contact_id'] },
    run: ({ contact_id: id }) => text({ id, name: 'Anna Example', number: '15550100123' }),
  },
  send_message: {
    description: 'Send a WhatsApp message (stand-in; it only writes it down).',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, message: { type: 'string' } }, required: ['to', 'message'] },
    run: args => { remember('stand-in-sent.json', args); return text('Message sent (stand-in).'); },
  },
};

// ---------- MCP over stdio ----------

const reply = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (id === undefined) return; // a notification
  try {
    if (method === 'initialize') {
      return reply({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mcp-whatsapp-web', version: '1.4.2-stand-in' } } });
    }
    if (method === 'ping') return reply({ id, result: {} });
    if (method === 'tools/list') {
      return reply({ id, result: { tools: Object.entries(TOOLS).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })) } });
    }
    if (method === 'tools/call') {
      const tool = TOOLS[params?.name];
      if (!tool) return reply({ id, result: { content: [{ type: 'text', text: `Unknown tool ${params?.name}` }], isError: true } });
      return reply({ id, result: tool.run(params.arguments ?? {}) });
    }
    return reply({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    return reply({ id, error: { code: -32603, message: error.message } });
  }
});
process.stdin.on('end', () => {
  write('stand-in-stopped.json', { pid: process.pid, how: 'its input was closed', at: new Date().toISOString() });
  log('Stopped cleanly.');
  process.exit(0);
});
