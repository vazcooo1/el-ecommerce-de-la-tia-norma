import type { Env } from './env.ts';
import { failedStatuses, isAllowed, parseWebhook, verifySignature } from './whatsapp.ts';

export { SessionDO } from './session.ts';

/**
 * Only runs for paths with no static asset: the page and photos are served from dist/ directly.
 * GET /webhook  → Meta's verification handshake.
 * POST /webhook → signed WhatsApp events; allowed messages go to the sender's SessionDO.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/webhook') return new Response('No encontrado', { status: 404 });

    if (request.method === 'GET') {
      const ok =
        url.searchParams.get('hub.mode') === 'subscribe' &&
        !!env.WHATSAPP_VERIFY_TOKEN &&
        url.searchParams.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get('hub.challenge') ?? '') : new Response('Prohibido', { status: 403 });
    }

    if (request.method === 'POST') {
      const raw = await request.arrayBuffer();
      const signature = request.headers.get('x-hub-signature-256');
      if (!(await verifySignature(raw, signature, env.WHATSAPP_APP_SECRET))) {
        return new Response('Firma inválida', { status: 401 });
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return new Response('ok');
      }
      // A reply WhatsApp could not deliver (e.g. a header image it could not fetch) only shows up here.
      for (const failure of failedStatuses(body)) console.error(`WhatsApp delivery failed: ${failure}`);
      for (const msg of parseWebhook(body)) {
        // Unknown senders are ignored silently (no reply, still 200 so Meta does not retry).
        if (!isAllowed(msg, env.ALLOWED_NUMBERS ?? '')) {
          console.log('message from a sender outside the allowlist ignored');
          continue;
        }
        await env.SESSIONS.getByName(msg.sender).enqueue(msg);
      }
      return new Response('ok');
    }

    return new Response('Método no permitido', { status: 405 });
  },
} satisfies ExportedHandler<Env>;
