import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60;

/** Standard Webhooks signature over `id.timestamp.body`. */
export function sign(secret, id, timestampSeconds, body) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestampSeconds}.${body}`).digest('base64')}`;
}

/** True only when the request was really signed with our secret, recently. */
export function verify({ secret, headers, body, now = Date.now() }) {
  const id = headers['webhook-id'];
  const timestamp = Number(headers['webhook-timestamp']);
  const given = String(headers['webhook-signature'] ?? '');
  if (!secret || !id || !Number.isFinite(timestamp) || !given) return false;
  if (Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(sign(secret, id, timestamp, body));
  return given.split(' ').some(candidate => {
    const buffer = Buffer.from(candidate);
    return buffer.length === expected.length && timingSafeEqual(buffer, expected);
  });
}

function numberFromJid(jid) {
  const digits = String(jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits || null;
}

/**
 * Turns a WhatsApp event (from mcp-whatsapp-web) into something happening on screen.
 * Message text is never handed to the brain: outside text must not be able to give orders.
 * `via` says which WhatsApp connection sent it ("own": CINCO ID's own link, "manual": a
 * connector run by another program); a call is declined through the same one.
 */
export function routeWhatsApp(event, computer, settings = {}, { via = 'manual' } = {}) {
  const data = event?.data ?? {};
  if (event?.name === 'call.received') {
    const contact = data.contact ?? {};
    computer.incomingCall({
      via,
      callId: data.callId,
      chatId: data.chatId ?? data.from,
      isVideo: data.isVideo === true,
      isGroup: data.isGroup === true,
      contact: {
        name: contact.name ?? null,
        pushname: contact.pushname ?? '',
        number: contact.number || numberFromJid(data.from) || '',
        isMyContact: contact.isMyContact === true,
      },
    });
    return 'call shown';
  }
  if (event?.name === 'call.ended') {
    computer.callEnded({ callId: data.callId, reason: data.reason ?? 'ended' });
    return 'call closed';
  }
  if (event?.name === 'message.received') {
    const mode = settings.messages ?? 'off';
    if (mode === 'off' || data.fromMe) return 'ignored';
    const sender = data.senderName || data.pushname || (numberFromJid(data.from) ? `+${numberFromJid(data.from)}` : 'someone');
    const preview = mode === 'preview' && data.body ? `\n\n${String(data.body).slice(0, 280)}` : '';
    computer.notify({ title: 'New message', text: `${sender}${preview}`, speak: computer.fill(computer.phrases.message, { caller: sender }) });
    return 'message shown';
  }
  return 'ignored';
}
