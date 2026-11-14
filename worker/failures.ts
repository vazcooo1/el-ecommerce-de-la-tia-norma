/**
 * What went wrong, from Norma's point of view. Every failure ends as one of these kinds, and each
 * kind has one message that tells her exactly what to do (see `failureReply` in session.ts).
 *
 * - temporary: a service did not answer, was too slow, failed on its side or asked us to slow
 *   down. Tried again when Norma writes again.
 * - daily-limit: Gemini's free quota for the day is used up. Tried again when Norma writes again.
 * - needs-helper: only a person can fix it (expired token, wrong key, catalog broken by hand, a bug).
 * - not-understood: Gemini answered, but twice with something unusable.
 * - audio-gone / photo-gone: WhatsApp no longer has the file, or it is not a usable photo.
 */
export type FailureKind = 'temporary' | 'daily-limit' | 'needs-helper' | 'not-understood' | 'audio-gone' | 'photo-gone';

export class Failure extends Error {
  readonly kind: FailureKind;
  // A plain field, not a constructor parameter property: Node's type stripping (try-agent) rejects those.
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = 'Failure';
    this.kind = kind;
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What an HTTP error status usually means: try again later, or a person has to fix something. */
export function statusKind(status: number): FailureKind {
  return status === 408 || status === 429 || status >= 500 ? 'temporary' : 'needs-helper';
}

/**
 * Runs one network step of a call to an outside service (the fetch, or reading the body). Anything
 * it throws that is not already a Failure (no connection, a timeout, a cut or garbled response)
 * means the service failed us, not our code: temporary.
 */
export async function guard<T>(service: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    throw e instanceof Failure ? e : new Failure('temporary', `${service}: ${errorText(e)}`);
  }
}

/**
 * Any error that reaches the turn handler. Cloudflare marks its own passing errors (a storage
 * hiccup, an overloaded object) as retryable or overloaded. Anything else that is not a Failure is
 * a bug or broken data, which only a person can fix.
 */
export function toFailure(e: unknown): Failure {
  if (e instanceof Failure) return e;
  const flags = e as { retryable?: boolean; overloaded?: boolean } | null;
  if (flags?.retryable || flags?.overloaded) return new Failure('temporary', `Cloudflare: ${errorText(e)}`);
  return new Failure('needs-helper', errorText(e));
}
