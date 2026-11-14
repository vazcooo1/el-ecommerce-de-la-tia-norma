import { DurableObject } from 'cloudflare:workers';
import type { Catalog } from '../shared/catalog.ts';
import type { Env } from './env.ts';
import type { HistoryEntry } from './agent.ts';
import { AgentError, runAgent } from './agent.ts';
import type { FileChange, GitHubConfig } from './github.ts';
import { CATALOG_PATH, PHOTOS_DIR, commitFiles, readCatalog } from './github.ts';
import type { Operation, PendingPhoto } from './operations.ts';
import { isCancel, planChange } from './operations.ts';
import type { IncomingMessage, WaConfig } from './whatsapp.ts';
import { downloadMedia, sendConfirmation, sendText } from './whatsapp.ts';

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
        console.error('turn failed:', e instanceof Error ? e.message : e);
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

  private async turn(queue: IncomingMessage[], to: string): Promise<void> {
    const storage = this.ctx.storage;
    const now = Date.now();
    const pending = ((await storage.get<PendingPhoto[]>('pending')) ?? []).filter((p) => now - p.receivedAt < DAY_MS);
    let nextRef = pending.length === 0 ? 1 : ((await storage.get<number>('nextRef')) ?? 1);
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

    if (audios.length > 0 || texts.length > 0) return this.converse(to, audios, texts, pending);
    if (buttons.length > 0) return this.button(to, buttons[buttons.length - 1]!.buttonId!, pending);
    if (images.length > 0) return this.say(to, MSG.photosOnly(images.length));
    return this.say(to, MSG.unsupported);
  }

  /** Audio and/or text: ask Gemini, then propose, ask back, or inform. */
  private async converse(to: string, audioMsgs: IncomingMessage[], texts: string[], pending: PendingPhoto[]) {
    const storage = this.ctx.storage;
    const proposal = (await storage.get<Proposal | null>('proposal')) ?? null;
    const history = (await storage.get<HistoryEntry[]>('history')) ?? [];

    let audios: { bytes: Uint8Array; mimeType: string }[];
    try {
      audios = await Promise.all(audioMsgs.map((m) => downloadMedia(this.wa, m.mediaId!)));
    } catch (e) {
      console.error('audio download failed:', e instanceof Error ? e.message : e);
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
      replied = await this.propose(to, { id: crypto.randomUUID().slice(0, 8), ops: result.operations }, pending, catalog);
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
  private async propose(
    to: string,
    proposal: Proposal,
    pending: PendingPhoto[],
    catalog: Catalog,
    prefix = '',
  ): Promise<string> {
    const result = planChange(catalog, proposal.ops, pending);
    if (!result.ok) {
      await this.say(to, result.error);
      return result.error;
    }
    const { plan } = result;
    await this.ctx.storage.put('proposal', proposal);

    let header: string | undefined;
    const onlyExisting = !proposal.ops.some((op) => op.type === 'add_product');
    if (plan.touchedExisting.length === 1 && onlyExisting && this.env.SITE_URL) {
      const cover = catalog.products.find((p) => p.id === plan.touchedExisting[0])?.photos[0];
      if (cover) header = `${this.env.SITE_URL.replace(/\/$/, '')}/fotos/${cover}`;
    }
    const body = prefix + confirmBody(plan.summaryLines);
    await sendConfirmation(this.wa, to, body, proposal.id, header);
    return body;
  }

  /** ✅ / ❌ taps. Only the current proposal's buttons count. */
  private async button(to: string, buttonId: string, pending: PendingPhoto[]) {
    const storage = this.ctx.storage;
    const [answer, proposalId] = buttonId.split(':');
    const proposal = (await storage.get<Proposal | null>('proposal')) ?? null;

    if (!proposal) return this.say(to, MSG.noPending);
    if (proposal.id !== proposalId) {
      const { catalog } = await readCatalog(this.gh);
      await this.propose(to, proposal, pending, catalog, MSG.stale);
      return;
    }
    if (answer === 'no') {
      await storage.put('proposal', null);
      return this.say(to, MSG.no);
    }
    if (answer === 'yes') return this.publish(to, proposal, pending);
  }

  /** Applies the proposal to the fresh catalog and commits it; one retry if the branch moved. */
  private async publish(to: string, proposal: Proposal, pending: PendingPhoto[]) {
    const storage = this.ctx.storage;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { headSha, catalog } = await readCatalog(this.gh);
        const result = planChange(catalog, proposal.ops, pending);
        if (!result.ok) {
          await storage.put('proposal', null);
          return this.say(to, result.error);
        }
        const { plan } = result;

        const changes: FileChange[] = [{ path: CATALOG_PATH, content: `${JSON.stringify(plan.catalog, null, 2)}\n` }];
        for (const add of plan.photoAdds) {
          let media;
          try {
            media = await downloadMedia(this.wa, add.mediaId);
          } catch (e) {
            console.error('photo download failed:', e instanceof Error ? e.message : e);
            return this.say(to, MSG.mediaFailed);
          }
          changes.push({ path: `${PHOTOS_DIR}/${add.path}`, content: media.bytes });
        }
        for (const path of plan.photoDeletes) changes.push({ path: `${PHOTOS_DIR}/${path}`, delete: true });

        const message = `Norma: ${plan.summaryLines.join('; ')}`.replaceAll('*', '');
        if ((await commitFiles(this.gh, headSha, changes, message)) === 'ok') {
          const used = new Set(proposal.ops.flatMap((op) => op.photoRefs ?? []));
          await storage.put({ proposal: null, pending: pending.filter((p) => !used.has(p.ref)) });
          console.log(`published: ${plan.summaryLines.length} change(s)`);
          return this.say(to, MSG.done);
        }
        console.log('commit conflict, retrying');
      }
    } catch (e) {
      console.error('publish failed:', e instanceof Error ? e.message : e);
    }
    return this.say(to, MSG.saveFailed);
  }
}
