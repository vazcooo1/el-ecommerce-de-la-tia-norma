import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import type { IncomingMessage } from './whatsapp.ts';

const DEBOUNCE_MS = 5_000;
const DAY_MS = 86_400_000;

/** One per allowed sender. Groups messages into turns and keeps the conversation state (spec §6). */
export class SessionDO extends DurableObject<Env> {
  /** Stores a message (deduplicated by id) and (re)arms the turn alarm. */
  async enqueue(msg: IncomingMessage): Promise<void> {
    const now = Date.now();
    const storage = this.ctx.storage;
    const seen = (await storage.get<Record<string, number>>('seen')) ?? {};
    for (const [id, at] of Object.entries(seen)) if (now - at > DAY_MS) delete seen[id];
    if (seen[msg.id]) {
      console.log(`duplicate message ignored (${msg.kind})`);
      await storage.put('seen', seen);
      return;
    }
    seen[msg.id] = now;
    const queue = (await storage.get<IncomingMessage[]>('queue')) ?? [];
    queue.push(msg);
    await storage.put({ seen, queue });
    // A burst of photos + audio becomes one turn; a button tap is handled right away.
    await storage.setAlarm(now + (msg.kind === 'button' ? 0 : DEBOUNCE_MS));
  }

  async alarm(): Promise<void> {
    const queue = (await this.ctx.storage.get<IncomingMessage[]>('queue')) ?? [];
    console.log(`turn: ${queue.length} message(s)`);
  }
}
