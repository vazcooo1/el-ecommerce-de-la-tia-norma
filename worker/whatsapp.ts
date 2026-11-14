/** WhatsApp Cloud API: webhook parsing and verification, replies, media download. */

const GRAPH = 'https://graph.facebook.com/v27.0';

export type WaConfig = { token: string; phoneNumberId: string; fetchFn?: typeof fetch };

async function send(cfg: WaConfig, payload: Record<string, unknown>): Promise<void> {
  const res = await (cfg.fetchFn ?? fetch)(`${GRAPH}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
  });
  if (!res.ok) throw new Error(`WhatsApp send: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export async function sendText(cfg: WaConfig, to: string, body: string): Promise<void> {
  await send(cfg, { to, type: 'text', text: { preview_url: false, body: body.slice(0, 4096) } });
}

/** ✅ Sí / ❌ No buttons tied to one proposal. Bodies over 1024 chars go first as plain text. */
export async function sendConfirmation(
  cfg: WaConfig,
  to: string,
  body: string,
  proposalId: string,
  headerImageUrl?: string,
): Promise<void> {
  let text = body;
  if (text.length > 1024) {
    await sendText(cfg, to, body);
    text = '¿Está bien?';
  }
  await send(cfg, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(headerImageUrl && { header: { type: 'image', image: { link: headerImageUrl } } }),
      body: { text },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `yes:${proposalId}`, title: '✅ Sí' } },
          { type: 'reply', reply: { id: `no:${proposalId}`, title: '❌ No' } },
        ],
      },
    },
  });
}

/** Media IDs from webhooks last 7 days; the download URL only 5 minutes, so it is fetched right before use. */
export async function downloadMedia(cfg: WaConfig, mediaId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const auth = { authorization: `Bearer ${cfg.token}` };
  const metaRes = await fetchFn(`${GRAPH}/${mediaId}`, { headers: auth });
  if (!metaRes.ok) throw new Error(`WhatsApp media lookup: HTTP ${metaRes.status}`);
  const meta = (await metaRes.json()) as { url: string; mime_type: string };
  const fileRes = await fetchFn(meta.url, { headers: auth });
  if (!fileRes.ok) throw new Error(`WhatsApp media download: HTTP ${fileRes.status}`);
  return { bytes: new Uint8Array(await fileRes.arrayBuffer()), mimeType: meta.mime_type };
}

export type IncomingMessage = {
  id: string;
  /** `from` (phone number) or, when missing, `from_user_id`. Names the sender's Durable Object. */
  sender: string;
  fromUserId?: string;
  /** Where replies go: `from` exactly as received (falls back to `from_user_id`). */
  replyTo: string;
  timestamp: number;
  kind: 'text' | 'audio' | 'image' | 'button' | 'unsupported';
  text?: string;
  mediaId?: string;
  mimeType?: string;
  caption?: string;
  buttonId?: string;
};

type WaMessage = {
  from?: string;
  from_user_id?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  interactive?: { type?: string; button_reply?: { id?: string } };
};

type WaWebhook = { entry?: { changes?: { value?: { messages?: WaMessage[] } }[] }[] };

/** Flattens a webhook payload into messages. Status updates (`value.statuses`) are ignored. */
export function parseWebhook(body: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const entry of (body as WaWebhook)?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        const sender = m.from ?? m.from_user_id;
        if (!sender || !m.id) continue;
        const base = {
          id: m.id,
          sender,
          ...(m.from_user_id && { fromUserId: m.from_user_id }),
          replyTo: sender,
          timestamp: Number(m.timestamp) || 0,
        };
        if (m.type === 'text') {
          out.push({ ...base, kind: 'text', text: m.text?.body ?? '' });
        } else if (m.type === 'audio' && m.audio?.id) {
          out.push({ ...base, kind: 'audio', mediaId: m.audio.id, mimeType: m.audio.mime_type ?? 'audio/ogg' });
        } else if (m.type === 'image' && m.image?.id) {
          out.push({
            ...base,
            kind: 'image',
            mediaId: m.image.id,
            mimeType: m.image.mime_type ?? 'image/jpeg',
            ...(m.image.caption && { caption: m.image.caption }),
          });
        } else if (m.type === 'interactive' && m.interactive?.type === 'button_reply' && m.interactive.button_reply?.id) {
          out.push({ ...base, kind: 'button', buttonId: m.interactive.button_reply.id });
        } else {
          out.push({ ...base, kind: 'unsupported' });
        }
      }
    }
  }
  return out;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Checks `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(raw body, app secret), in constant time. */
export async function verifySignature(rawBody: ArrayBuffer, header: string | null, appSecret: string): Promise<boolean> {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new TextEncoder().encode(hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody))));
  const given = new TextEncoder().encode(header.slice('sha256='.length).toLowerCase());
  // timingSafeEqual throws on unequal lengths.
  if (expected.byteLength !== given.byteLength) return false;
  return crypto.subtle.timingSafeEqual(expected, given);
}

/** `allowed` is a comma-separated list; spaces and "+" are ignored. Matches `sender` or `fromUserId`. */
export function isAllowed(msg: { sender: string; fromUserId?: string }, allowed: string): boolean {
  const list = allowed
    .split(',')
    .map((s) => s.replace(/[\s+]/g, ''))
    .filter(Boolean);
  return list.includes(msg.sender) || (!!msg.fromUserId && list.includes(msg.fromUserId));
}
