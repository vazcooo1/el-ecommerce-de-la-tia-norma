import { DurableObject } from 'cloudflare:workers';
import type { Catalog } from '../shared/catalog.ts';
import type { Env } from './env.ts';
import type { HistoryEntry } from './agent.ts';
import { AgentError, runAgent } from './agent.ts';
import type { FileChange, GitHubConfig } from './github.ts';
import { CATALOG_PATH, PHOTOS_DIR, commitFiles, readCatalog, uploadBlob } from './github.ts';
import type { Operation, PendingPhoto } from './operations.ts';
import { isCancel, planChange } from './operations.ts';
import type { IncomingMessage, WaConfig } from './whatsapp.ts';
import { downloadMedia, sendConfirmation, sendText, sniffImage } from './whatsapp.ts';

const DEBOUNCE_MS = 5_000;
const DAY_MS = 86_400_000;
const HISTORY_SIZE = 6;

type Proposal = { id: string; ops: Operation[] };

/** Everything the bot says that is not built from operations (spec §6, §10). */
const MSG = {
  unsupported: 'Por ahora entiendo audios, textos y fotos 🙂',
  stale: 'Ese mensaje era viejo, esto es lo que tengo ahora:\n',
  noPending: 'No tengo ningún cambio pendiente.',
  no: '👍 No cambié nada. Mandame otro audio cuando quieras.',
  cancelled: '👍 No cambié nada.',
  done: '✅ Listo. En unos minutos aparece en la página.',
  saveFailed: '⚠️ No pude guardar el cambio, probá tocar Sí de nuevo en un rato.',
  agentFailed: '😕 No entendí bien el audio, ¿me lo mandás de nuevo?',
  mediaFailed: 'No pude bajar la foto, ¿me la mandás de nuevo?',
  photosOnly: (n: number) =>
    `📷 Recibí ${n} ${n === 1 ? 'foto' : 'fotos'}. Mandame un audio diciendo de qué producto son, o si es un producto nuevo, con el nombre y el precio.`,
};

const confirmBody = (lines: string[]) => `${lines.map((line, i) => `${i + 1}. ${line}`).join('\n')}\n\n¿Está bien?`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One per allowed sender. Groups messages into turns and keeps the conversation state (spec §6).
 * Storage keys: queue, seen, pending, nextRef, proposal, closed (last finished proposal id), history.
 */
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

  /** Handles one turn. Never throws: Norma always gets a plain message, details go to the logs. */
  async alarm(): Promise<void> {
    const storage = this.ctx.storage;
    const queue = (await storage.get<IncomingMessage[]>('queue')) ?? [];
    await storage.put('queue', []);
    if (queue.length > 0) {
      const to = queue[queue.length - 1]!.replyTo;
      console.log(`turn: ${queue.map((m) => m.kind).join(', ')}`);
      try {
        await this.turn(queue, to);
      } catch (e) {
        console.error('turn failed:', errorText(e));
        await this.say(to, MSG.agentFailed).catch(() => {});
      }
    }
    // Messages that arrived while this turn ran get their own turn.
    const left = (await storage.get<IncomingMessage[]>('queue')) ?? [];
    if (left.length > 0 && (await storage.getAlarm()) === null) await storage.setAlarm(Date.now() + DEBOUNCE_MS);
  }

  private get wa(): WaConfig {
    return { token: this.env.WHATSAPP_TOKEN, phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID };
  }

  private get gh(): GitHubConfig {
    return { token: this.env.GITHUB_TOKEN, repo: this.env.GITHUB_REPO, branch: this.env.GITHUB_BRANCH || 'main' };
  }

  private say(to: string, text: string): Promise<void> {
    return sendText(this.wa, to, text);
  }

  private async pending(): Promise<PendingPhoto[]> {
    return (await this.ctx.storage.get<PendingPhoto[]>('pending')) ?? [];
  }

  private async turn(queue: IncomingMessage[], to: string): Promise<void> {
    const storage = this.ctx.storage;
    const now = Date.now();

    // Photos older than 24 h are dropped. A proposal that refers to one can no longer be
    // confirmed as shown, so it goes too (its buttons then answer "no tengo cambios pendientes").
    const stored = await this.pending();
    const pending = stored.filter((p) => now - p.receivedAt < DAY_MS);
    const expired = new Set(stored.filter((p) => !pending.includes(p)).map((p) => p.ref));
    if (expired.size > 0) {
      const proposal = (await storage.get<Proposal | null>('proposal')) ?? null;
      if (proposal?.ops.some((op) => op.photoRefs?.some((ref) => expired.has(ref)))) await storage.put('proposal', null);
    }

    // Refs are never reused: "p3" always means the same photo, even in an old proposal.
    let nextRef = (await storage.get<number>('nextRef')) ?? 1;
    const images = queue.filter((m) => m.kind === 'image');
    for (const m of images) {
      pending.push({
        ref: `p${nextRef++}`,
        mediaId: m.mediaId!,
        mimeType: m.mimeType ?? 'image/jpeg',
        ...(m.caption && { caption: m.caption }),
        receivedAt: now,
      });
    }
    await storage.put({ pending, nextRef });

    const audios = queue.filter((m) => m.kind === 'audio');
    const texts = queue.filter((m) => m.kind === 'text' && m.text?.trim()).map((m) => m.text!);
    const buttons = queue.filter((m) => m.kind === 'button');

    // A tap that shares a turn with an audio (tap, then talk within 5 s) is handled first.
    if (buttons.length > 0) await this.button(to, buttons[buttons.length - 1]!.buttonId!);
    if (audios.length > 0 || texts.length > 0) return this.converse(to, audios, texts);
    if (buttons.length > 0) return;
    if (images.length > 0) return this.say(to, MSG.photosOnly(images.length));
    return this.say(to, MSG.unsupported);
  }

  /** Audio and/or text: ask Gemini, then propose, ask back, or inform. */
  private async converse(to: string, audioMsgs: IncomingMessage[], texts: string[]) {
    const storage = this.ctx.storage;
    const proposal = (await storage.get<Proposal | null>('proposal')) ?? null;
    const history = (await storage.get<HistoryEntry[]>('history')) ?? [];
    const pending = await this.pending();

    let audios: { bytes: Uint8Array; mimeType: string }[];
    try {
      audios = await Promise.all(audioMsgs.map((m) => downloadMedia(this.wa, m.mediaId!)));
    } catch (e) {
      console.error('audio download failed:', errorText(e));
      return this.say(to, MSG.agentFailed);
    }

    const { catalog } = await readCatalog(this.gh);
    let result;
    try {
      result = await runAgent(
        { apiKey: this.env.GEMINI_API_KEY, model: this.env.GEMINI_MODEL },
        { catalog, pending, proposal: proposal?.ops ?? null, history, audios, texts },
      );
    } catch (e) {
      if (!(e instanceof AgentError)) throw e;
      console.error('agent failed:', e.message);
      return this.say(to, MSG.agentFailed);
    }
    console.log(`agent: kind=${result.kind} ops=${result.operations.map((o) => o.type).join(',') || '-'}`);

    let replied: string;
    if (result.kind === 'proposal' && isCancel(result.operations)) {
      await storage.put('proposal', null);
      replied = MSG.cancelled;
      await this.say(to, replied);
    } else if (result.kind === 'proposal') {
      replied = await this.propose(to, { id: crypto.randomUUID().slice(0, 8), ops: result.operations }, catalog);
    } else {
      replied = result.reply.trim() || MSG.agentFailed;
      await this.say(to, replied);
    }

    history.push({ heard: result.heard, replied });
    await storage.put('history', history.slice(-HISTORY_SIZE));
  }

  /**
   * Validates a proposal and sends its confirmation. An invalid one is explained and NOT stored,
   * so any older pending proposal stays. Returns what was said.
   */
  private async propose(to: string, proposal: Proposal, catalog: Catalog, prefix = ''): Promise<string> {
    const result = planChange(catalog, proposal.ops, await this.pending());
    if (!result.ok) {
      await this.say(to, result.error);
      return result.error;
    }
    const { plan } = result;
    await this.ctx.storage.put('proposal', proposal);

    // WhatsApp fetches the header from the live site. A photo the bot added minutes ago may not be
    // deployed yet, and a header that 404s makes the whole confirmation fail to arrive.
    let header: string | undefined;
    const onlyExisting = !proposal.ops.some((op) => op.type === 'add_product');
    if (plan.touchedExisting.length === 1 && onlyExisting && this.env.SITE_URL) {
      const cover = catalog.products.find((p) => p.id === plan.touchedExisting[0])?.photos[0];
      if (cover && (await this.isLive(`/fotos/${cover}`))) {
        header = `${this.env.SITE_URL.replace(/\/$/, '')}/fotos/${cover}`;
      }
    }
    const body = prefix + confirmBody(plan.summaryLines);
    await sendConfirmation(this.wa, to, body, proposal.id, header);
    return body;
  }

  /** Whether a path exists in the currently deployed static assets. */
  private async isLive(path: string): Promise<boolean> {
    try {
      const res = await this.env.ASSETS.fetch(new Request(`https://assets.local${path}`, { method: 'HEAD' }));
      return res.ok;
    } catch {
      return false;
    }
  }

  /** ✅ / ❌ taps. Only the current proposal's buttons count. */
  private async button(to: string, buttonId: string) {
    const storage = this.ctx.storage;
    const [answer, proposalId] = buttonId.split(':');
    const proposal = (await storage.get<Proposal | null>('proposal')) ?? null;

    if (proposal && proposal.id === proposalId) {
      if (answer === 'no') {
        await storage.put({ proposal: null, closed: proposal.id });
        return this.say(to, MSG.no);
      }
      if (answer === 'yes') return this.publish(to, proposal);
      return;
    }
    // A second tap on a proposal that was just published or declined: already answered.
    if (proposalId === (await storage.get<string>('closed'))) {
      console.log('repeated tap ignored');
      return;
    }
    if (!proposal) return this.say(to, MSG.noPending);
    const { catalog } = await readCatalog(this.gh);
    await this.propose(to, proposal, catalog, MSG.stale);
  }

  /** Applies the proposal to the fresh catalog and commits it; one retry if the branch moved. */
  private async publish(to: string, proposal: Proposal) {
    const storage = this.ctx.storage;
    const pending = await this.pending();
    let published = false;
    try {
      let snapshot = await readCatalog(this.gh);
      const first = planChange(snapshot.catalog, proposal.ops, pending);
      if (!first.ok) {
        await storage.put('proposal', null);
        return this.say(to, first.error);
      }

      // Photos are downloaded, checked and uploaded once; a retry reuses the blobs. This keeps a
      // publish with 10 new photos at ~45 subrequests, under the Workers Free limit of 50.
      const blobs = new Map<string, string>();
      for (const add of first.plan.photoAdds) {
        let media;
        try {
          media = await downloadMedia(this.wa, add.mediaId);
        } catch (e) {
          console.error('photo download failed:', errorText(e));
          return this.say(to, MSG.mediaFailed);
        }
        // A non-image committed as a photo would break every later build.
        if (!sniffImage(media.bytes)) {
          console.error(`downloaded media is not an image (${media.mimeType})`);
          return this.say(to, MSG.mediaFailed);
        }
        blobs.set(add.mediaId, await uploadBlob(this.gh, media.bytes));
      }

      for (let attempt = 0; attempt < 2 && !published; attempt++) {
        if (attempt > 0) snapshot = await readCatalog(this.gh);
        const result = attempt === 0 ? first : planChange(snapshot.catalog, proposal.ops, pending);
        if (!result.ok) {
          await storage.put('proposal', null);
          return this.say(to, result.error);
        }
        const { plan } = result;
        const changes: FileChange[] = [
          { path: CATALOG_PATH, content: `${JSON.stringify(plan.catalog, null, 2)}\n` },
          ...plan.photoAdds.map((a) => ({ path: `${PHOTOS_DIR}/${a.path}`, blobSha: blobs.get(a.mediaId)! })),
          ...plan.photoDeletes.map((p) => ({ path: `${PHOTOS_DIR}/${p}`, delete: true as const })),
        ];
        const message = `Norma: ${plan.summaryLines.join('; ')}`.replaceAll('*', '');
        if ((await commitFiles(this.gh, snapshot.headSha, changes, message)) === 'ok') {
          const used = new Set(proposal.ops.flatMap((op) => op.photoRefs ?? []));
          await storage.put({ proposal: null, closed: proposal.id, pending: pending.filter((p) => !used.has(p.ref)) });
          console.log(`published: ${plan.summaryLines.length} change(s)`);
          published = true;
        } else {
          console.log('commit conflict, retrying');
        }
      }
    } catch (e) {
      console.error('publish failed:', errorText(e));
    }
    // Outside the try: if sending "Listo" fails, Norma must not be told the save failed.
    return this.say(to, published ? MSG.done : MSG.saveFailed);
  }
}
