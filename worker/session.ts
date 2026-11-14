import { DurableObject } from 'cloudflare:workers';
import type { Catalog } from '../shared/catalog.ts';
import type { Env } from './env.ts';
import type { HistoryEntry } from './agent.ts';
import { runAgent } from './agent.ts';
import type { FailureKind } from './failures.ts';
import { Failure, errorText, toFailure } from './failures.ts';
import type { FileChange, GitHubConfig } from './github.ts';
import { CATALOG_PATH, PHOTOS_DIR, commitFiles, readCatalog, recentMessages, uploadBlob } from './github.ts';
import type { Operation, PendingPhoto } from './operations.ts';
import { isCancel, planChange } from './operations.ts';
import type { IncomingMessage, WaConfig } from './whatsapp.ts';
import { downloadMedia, sendConfirmation, sendText, showTyping, sniffImage } from './whatsapp.ts';

const DEBOUNCE_MS = 5_000;
const DAY_MS = 86_400_000;
const HISTORY_SIZE = 6;
/** A turn that gets cut off (the Worker restarted or hit a limit) is picked up again by this alarm. */
const WATCHDOG_MS = 3 * 60_000;
/** Failed messages are kept this long, so "escribime mañana" still finds them. */
const RETRY_TTL_MS = 2 * DAY_MS;
/** Tries per batch of failed messages before asking for the helper. */
const MAX_ATTEMPTS = 3;

type Proposal = { id: string; ops: Operation[] };
/** The last proposal Norma answered, so another tap on it gets the same answer again. */
type Closed = { id: string; published: boolean };
/**
 * Messages whose turn failed or was cut off. They are tried again together with Norma's next
 * message, so she never has to repeat herself. `running` is true while a try is in progress; if it
 * is still true when the next alarm fires, that try was cut off.
 */
type Retry = { msgs: IncomingMessage[]; attempts: number; since: number; running: boolean };

/** Everything the bot says that is not built from operations or failures. */
const MSG = {
  unsupported: 'Por ahora entiendo audios, textos y fotos 🙂',
  stale: 'Ese mensaje era viejo, esto es lo que tengo ahora:\n',
  noPending: 'No tengo ningún cambio pendiente.',
  no: '👍 No cambié nada. Mandame otro audio cuando quieras.',
  cancelled: '👍 No cambié nada.',
  done: '✅ Listo. En unos minutos aparece en la página.',
  expired: 'Lo que me mandaste hace unos días ya no lo puedo usar. ¿Me lo mandás de nuevo?',
  photosOnly: (n: number) =>
    `📷 Recibí ${n} ${n === 1 ? 'foto' : 'fotos'}. Mandame un audio o un mensaje diciendo de qué producto son, o si es un producto nuevo, con el nombre y el precio.`,
};

/** One message per kind of failure, each with one thing for Norma to do. */
function failureReply(kind: FailureKind, helper: string): string {
  switch (kind) {
    case 'temporary':
      return 'La internet está andando mal, te pido que me escribas en un rato para que pruebe de vuelta.';
    case 'daily-limit':
      return 'Por hoy ya no puedo entender más mensajes. Escribime mañana para que pruebe de vuelta.';
    case 'needs-helper':
      return `⚠️ La tienda tiene un problema que no se arregla solo. Avisale a ${helper} para que lo arregle. La página sigue funcionando.`;
    case 'not-understood':
      return '😕 No te entendí bien, ¿me lo mandás de nuevo?';
    case 'audio-gone':
      return 'No pude abrir el audio, ¿me lo mandás de nuevo?';
    case 'photo-gone':
      return 'No pude abrir una de las fotos, ¿me la mandás de nuevo?';
  }
}

const confirmBody = (lines: string[]) => `${lines.map((line, i) => `${i + 1}. ${line}`).join('\n')}\n\n¿Está bien?`;

/**
 * One per allowed sender. Groups messages into turns and keeps the conversation state.
 * Storage keys: queue, seen, retry, pending, nextRef, proposal, closed, history.
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

  /**
   * True while a turn runs in this instance. A restart clears it: that is how a turn that is still
   * running (an alarm that fires during a long turn just waits) is told apart from one cut off.
   */
  private busy = false;

  /**
   * Handles one turn. Never throws: every failure ends in a message that tells Norma what to do,
   * and the details go to the logs. Messages whose turn failed are kept and tried again.
   */
  async alarm(): Promise<void> {
    if (this.busy) {
      await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
      return;
    }
    this.busy = true;
    try {
      await this.runTurn();
    } finally {
      this.busy = false;
    }
  }

  private async runTurn(): Promise<void> {
    const storage = this.ctx.storage;
    const now = Date.now();
    const queue = (await storage.get<IncomingMessage[]>('queue')) ?? [];
    let retry = (await storage.get<Retry>('retry')) ?? null;
    const to = (queue.at(-1) ?? retry?.msgs.at(-1))?.replyTo;
    if (!to) return;
    if (queue.length > 0) await showTyping(this.wa, queue.at(-1)!.id);

    if (retry?.running) console.error(`the last try was cut off (try ${retry.attempts})`);
    if (retry && now - retry.since > RETRY_TTL_MS) {
      await this.dropRetry(to, MSG.expired);
      retry = null;
    } else if (retry && retry.attempts >= MAX_ATTEMPTS) {
      await this.dropRetry(to, this.failureText('needs-helper'));
      retry = null;
    } else if (retry?.running && retry.attempts >= 2 && queue.length === 0) {
      // Cut off twice in a row: stop retrying on our own and tell Norma. Her next message tries once more.
      await storage.put('retry', { ...retry, running: false });
      return this.afterTurn(await this.tell(to, this.failureText('temporary')), true);
    }
    const msgs = [...(retry?.msgs ?? []), ...queue];
    if (msgs.length === 0) return this.afterTurn(true, false);

    const attempt: Retry = { msgs, attempts: (retry?.attempts ?? 0) + 1, since: retry?.since ?? now, running: true };
    await storage.put({ queue: [], retry: attempt });
    await storage.setAlarm(now + WATCHDOG_MS);
    console.log(`turn (try ${attempt.attempts}): ${msgs.map((m) => m.kind).join(', ')}`);

    let failure: Failure | null = null;
    try {
      await this.turn(msgs, to);
    } catch (e) {
      failure = toFailure(e);
      console.error(`turn failed (${failure.kind}):`, failure.message);
    }
    const retryable = failure?.kind === 'temporary' || failure?.kind === 'daily-limit';
    if (retryable) await storage.put('retry', { ...attempt, running: false });
    else await storage.delete('retry');
    const told = !failure || (await this.tell(to, this.failureText(failure.kind)));
    await this.afterTurn(told, retryable);
  }

  /** What runs next: new messages get their own turn; a failure Norma could not be told about is retried by us. */
  private async afterTurn(told: boolean, retryable: boolean): Promise<void> {
    const storage = this.ctx.storage;
    const queue = (await storage.get<IncomingMessage[]>('queue')) ?? [];
    if (queue.length > 0) await storage.setAlarm(Date.now() + DEBOUNCE_MS);
    else if (!told && retryable) await storage.setAlarm(Date.now() + WATCHDOG_MS);
    else await storage.deleteAlarm();
  }

  private async dropRetry(to: string, text: string): Promise<void> {
    console.error('failed messages dropped');
    await this.ctx.storage.delete('retry');
    await this.tell(to, text);
  }

  private get wa(): WaConfig {
    return { token: this.env.WHATSAPP_TOKEN, phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID };
  }

  private get gh(): GitHubConfig {
    return { token: this.env.GITHUB_TOKEN, repo: this.env.GITHUB_REPO, branch: this.env.GITHUB_BRANCH || 'main' };
  }

  private failureText(kind: FailureKind): string {
    return failureReply(kind, this.env.HELPER_NAME?.trim() || 'quien te ayuda con la página');
  }

  private say(to: string, text: string): Promise<void> {
    return sendText(this.wa, to, text);
  }

  /** Sends a message outside a turn. Returns false (and logs why) if WhatsApp did not take it. */
  private async tell(to: string, text: string): Promise<boolean> {
    try {
      await this.say(to, text);
      return true;
    } catch (e) {
      console.error('could not reach Norma:', errorText(e));
      return false;
    }
  }

  private async pending(): Promise<PendingPhoto[]> {
    return (await this.ctx.storage.get<PendingPhoto[]>('pending')) ?? [];
  }

  private async turn(msgs: IncomingMessage[], to: string): Promise<void> {
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

    // Refs are never reused: "p3" always means the same photo, even in an old proposal. A photo
    // that is already pending (its turn is being tried again) keeps its ref.
    let nextRef = (await storage.get<number>('nextRef')) ?? 1;
    const images = msgs.filter((m) => m.kind === 'image');
    const refs = new Map<string, string>();
    for (const m of images) {
      const known = pending.find((p) => p.mediaId === m.mediaId);
      if (known) {
        refs.set(m.mediaId!, known.ref);
        continue;
      }
      const ref = `p${nextRef++}`;
      refs.set(m.mediaId!, ref);
      pending.push({
        ref,
        mediaId: m.mediaId!,
        mimeType: m.mimeType ?? 'image/jpeg',
        ...(m.caption && { caption: m.caption }),
        receivedAt: now,
      });
    }
    await storage.put({ pending, nextRef });

    const audios = msgs.filter((m) => m.kind === 'audio');
    // A caption is a message about its photo: "(foto p3) jarra verde 12000".
    const captions = images
      .filter((m) => m.caption?.trim())
      .map((m) => `(foto ${refs.get(m.mediaId!)}) ${m.caption!.trim()}`);
    const texts = [...msgs.filter((m) => m.kind === 'text' && m.text?.trim()).map((m) => m.text!), ...captions];
    const buttons = msgs.filter((m) => m.kind === 'button');

    // A tap that shares a turn with an audio (tap, then talk within 5 s) is handled first.
    if (buttons.length > 0) await this.button(to, buttons[buttons.length - 1]!.buttonId!);
    if (audios.length > 0 || texts.length > 0) return this.converse(to, audios, texts);
    if (buttons.length > 0) return;
    if (images.length > 0) return this.say(to, MSG.photosOnly(images.length));
    return this.say(to, MSG.unsupported);
  }

  /** Audio and/or text: ask Gemini, then propose, ask back, or inform. Failures go up to alarm(). */
  private async converse(to: string, audioMsgs: IncomingMessage[], texts: string[]) {
    const storage = this.ctx.storage;
    const proposal = (await storage.get<Proposal | null>('proposal')) ?? null;
    const history = (await storage.get<HistoryEntry[]>('history')) ?? [];
    const pending = await this.pending();

    const audios = await Promise.all(audioMsgs.map((m) => downloadMedia(this.wa, m.mediaId!, 'audio')));
    const { catalog } = await readCatalog(this.gh);
    const result = await runAgent(
      { apiKey: this.env.GEMINI_API_KEY, model: this.env.GEMINI_MODEL },
      { catalog, pending, proposal: proposal?.ops ?? null, history, audios, texts },
    );
    console.log(`agent: kind=${result.kind} ops=${result.operations.map((o) => o.type).join(',') || '-'}`);

    let replied: string;
    if (result.kind === 'proposal' && isCancel(result.operations)) {
      await storage.put('proposal', null);
      replied = MSG.cancelled;
      await this.say(to, replied);
    } else if (result.kind === 'proposal') {
      replied = await this.propose(to, { id: crypto.randomUUID().slice(0, 8), ops: result.operations }, catalog);
    } else {
      replied = result.reply.trim() || this.failureText('not-understood');
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

  /** ✅ / ❌ taps. Only the current proposal's buttons change anything. */
  private async button(to: string, buttonId: string) {
    const storage = this.ctx.storage;
    const [answer, proposalId] = buttonId.split(':');
    const proposal = (await storage.get<Proposal | null>('proposal')) ?? null;

    if (proposal && proposal.id === proposalId) {
      if (answer === 'no') {
        await storage.put({ proposal: null, closed: { id: proposal.id, published: false } satisfies Closed });
        return this.say(to, MSG.no);
      }
      if (answer === 'yes') return this.publish(to, proposal);
      return;
    }
    // A proposal already answered (a second tap, or a turn tried again): the same answer again.
    const closed = (await storage.get<Closed>('closed')) ?? null;
    if (closed?.id === proposalId) return this.say(to, closed.published ? MSG.done : MSG.cancelled);
    if (!proposal) return this.say(to, MSG.noPending);
    const { catalog } = await readCatalog(this.gh);
    await this.propose(to, proposal, catalog, MSG.stale);
  }

  /**
   * Applies the proposal to the fresh catalog and commits it; one retry if the branch moved.
   * Safe to run twice: the commit message carries the proposal id, so a proposal that is already
   * on the branch (GitHub saved it but the answer never arrived) is only marked done.
   */
  private async publish(to: string, proposal: Proposal) {
    const storage = this.ctx.storage;
    const pending = await this.pending();
    const marker = `[cambio ${proposal.id}]`;
    const done = async () => {
      const used = new Set(proposal.ops.flatMap((op) => op.photoRefs ?? []));
      await storage.put({
        proposal: null,
        closed: { id: proposal.id, published: true } satisfies Closed,
        pending: pending.filter((p) => !used.has(p.ref)),
      });
      await this.say(to, MSG.done);
    };

    let snapshot = await readCatalog(this.gh);
    if ((await recentMessages(this.gh, snapshot.headSha)).some((m) => m.includes(marker))) {
      console.log('already published');
      return done();
    }
    const first = planChange(snapshot.catalog, proposal.ops, pending);
    if (!first.ok) {
      await storage.put('proposal', null);
      return this.say(to, first.error);
    }

    // Photos are downloaded, checked and uploaded once; a retry reuses the blobs. This keeps a
    // publish with 10 new photos at ~47 subrequests, under the Workers Free limit of 50.
    const blobs = new Map<string, string>();
    for (const add of first.plan.photoAdds) {
      const media = await downloadMedia(this.wa, add.mediaId, 'photo');
      // A non-image committed as a photo would break every later build.
      if (!sniffImage(media.bytes)) throw new Failure('photo-gone', `downloaded media is not an image (${media.mimeType})`);
      blobs.set(add.mediaId, await uploadBlob(this.gh, media.bytes));
    }

    for (let attempt = 0; attempt < 2; attempt++) {
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
      const message = `Norma: ${plan.summaryLines.join('; ')}`.replaceAll('*', '') + ` ${marker}`;
      if ((await commitFiles(this.gh, snapshot.headSha, changes, message)) === 'ok') {
        console.log(`published: ${plan.summaryLines.length} change(s)`);
        return done();
      }
      console.log('commit conflict, retrying');
    }
    // The branch moved twice while saving. Nothing was saved, so trying again later is safe.
    throw new Failure('temporary', 'GitHub: the branch kept moving');
  }
}
