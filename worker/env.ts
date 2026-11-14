import type { SessionDO } from './session.ts';

/** Bindings, vars (wrangler.jsonc) and secrets (wrangler secret put). */
export interface Env {
  SESSIONS: DurableObjectNamespace<SessionDO>;
  /** The deployed dist/: used to check a photo is live before using it as a WhatsApp header. */
  ASSETS: Fetcher;
  // vars
  GEMINI_MODEL: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  SITE_URL: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  // secrets
  ALLOWED_NUMBERS: string;
  WHATSAPP_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_VERIFY_TOKEN: string;
  GEMINI_API_KEY: string;
  GITHUB_TOKEN: string;
}
