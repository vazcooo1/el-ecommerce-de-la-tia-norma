# Setup

Everything runs on free tiers: Cloudflare Workers, Google AI Studio and the WhatsApp Cloud API
test number. Do these steps once. Design: `docs/superpowers/specs/2026-11-13-tienda-norma-design.md`.

You will end up with these values:

| Name | Where it goes | Where it comes from |
|---|---|---|
| `GEMINI_API_KEY` | Worker secret + `.dev.vars` | §1 AI Studio |
| `WHATSAPP_PHONE_NUMBER_ID` | `wrangler.jsonc` → `vars` | §2 Meta, API Setup |
| `WHATSAPP_TOKEN` | Worker secret | §2 Meta, system user token |
| `WHATSAPP_APP_SECRET` | Worker secret | §2 Meta, App settings → Basic |
| `WHATSAPP_VERIFY_TOKEN` | Worker secret + Meta webhook form | §2 you invent it |
| `ALLOWED_NUMBERS` | Worker secret | §2 Norma's and your numbers |
| `GITHUB_TOKEN` | Worker secret | §3 GitHub |
| `SITE_URL` | `wrangler.jsonc` → `vars` | §4 first deploy |
| `PUBLIC_WHATSAPP_NUMBER`, `PUBLIC_SITE_URL` | Workers Builds build variables | §5 |

Never commit secrets or phone numbers. `.dev.vars` is gitignored; copy it from `.dev.vars.example`.

## 0. Prerequisites

- Node ≥ 22.23.4 and pnpm 11. Then run `pnpm install`.
- A Cloudflare account, then `npx wrangler login`.

## 1. Google AI Studio (Gemini)

1. In https://aistudio.google.com, open **Get API key** and create a key.
2. Put it in `.dev.vars` as `GEMINI_API_KEY=…`.
3. Try the agent without WhatsApp:
   ```bash
   node --env-file=.dev.vars scripts/try-agent.ts "la taza gatito ahora sale 9000"
   node --env-file=.dev.vars scripts/try-agent.ts --photos 2 "producto nuevo, jarra verde, 12000"
   node --env-file=.dev.vars scripts/try-agent.ts --audio /path/to/nota.ogg
   ```
   The model is `GEMINI_MODEL`. The default is `gemini-3.5-flash-lite`; use `gemini-3.8-flash` to compare.

## 2. Meta: WhatsApp Cloud API test number

1. **Create the app.** In https://developers.facebook.com, go to **My Apps → Create app**, choose
   the business type, then add the **WhatsApp** product. Meta creates a **test phone number** for you.
2. **Phone Number ID.** In **WhatsApp → API Setup**, copy the **Phone number ID** (not the WhatsApp
   Business Account ID) into `wrangler.jsonc` → `vars.WHATSAPP_PHONE_NUMBER_ID`.
3. **Allowed recipients.** Still in API Setup, in the **To** field, add and verify Norma's number and
   yours. Each one gets a code on WhatsApp. These are the only numbers the test number can talk to.
4. **Permanent token.** The token on API Setup expires within a day, so make a permanent one:
   1. In https://business.facebook.com/settings, go to **Users → System users → Add**, with the Admin role.
   2. Under **Assign assets**, give it the app with *Manage app* (full control) and the WhatsApp
      account with *Manage WhatsApp Business accounts* (full control).
   3. **Generate token** for the app with the permissions `whatsapp_business_messaging`,
      `whatsapp_business_management` and `business_management`, and choose never expires.
   4. This is `WHATSAPP_TOKEN`.
5. **App secret.** In **App settings → Basic → App secret**, click Show. This is `WHATSAPP_APP_SECRET`.
6. **Verify token.** Invent any long random string, e.g. `openssl rand -hex 16`. This is
   `WHATSAPP_VERIFY_TOKEN`.
7. **Allowlist.** `ALLOWED_NUMBERS` is digits only, comma-separated, as WhatsApp sends them. For an
   Argentine mobile that is `549` + area code + number, e.g. `5491112345678,5491187654321`.
8. The webhook comes after the first deploy (§4).

> **Argentine numbers:** WhatsApp reports Argentine mobiles with a `9` after `54`. If replies fail
> with error **131030** ("recipient not in allowed list"), check how the number was written in the
> **To** list in step 3, and try it there with and without the `9`.

## 3. GitHub token (the bot commits catalog changes)

1. Go to https://github.com/settings/personal-access-tokens/new and create a **fine-grained token**.
2. Under **Repository access**, choose *Only select repositories* and pick this repo.
3. Under **Permissions → Contents**, choose *Read and write*. Metadata read-only is added automatically.
4. This is `GITHUB_TOKEN`.

## 4. First deploy and the webhook

```bash
pnpm build && npx wrangler deploy        # prints https://tienda-norma.<you>.workers.dev
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put WHATSAPP_TOKEN
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put ALLOWED_NUMBERS
npx wrangler secret put GITHUB_TOKEN
```

1. Put the printed URL in `wrangler.jsonc` → `vars.SITE_URL`, then run `npx wrangler deploy` again.
2. In Meta, go to **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `https://tienda-norma.<you>.workers.dev/webhook`
   - Verify token: your `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and save**, then under **Webhook fields** subscribe to **messages**.
3. Watch it live: `npx wrangler tail`.

`vars.GITHUB_BRANCH` is the branch the bot reads and commits to. It is `feat/tienda-poc` while
testing and `main` once live.

## 5. Automatic deploys (Workers Builds)

1. In the Cloudflare dashboard, go to **Workers & Pages → tienda-norma → Settings → Builds → Connect**,
   and pick this GitHub repo with branch `main`.
2. Build command: `pnpm build`. Deploy command: `npx wrangler deploy`.
3. **Build variables:**
   - `PUBLIC_WHATSAPP_NUMBER`: Norma's **sales** number, where customers' "Comprar" goes. Digits only, e.g. `549…`.
   - `PUBLIC_SITE_URL`: the workers.dev URL, used for link previews.
4. Each commit the bot makes to `main` now rebuilds the page, which takes a few minutes.

## 6. Norma

1. Save the test number as a contact, e.g. **"Mi Tienda 🏺"**.
2. Send it **"hola"** once. Replies are free only within 24 h of her last message, so the bot never
   writes first.
3. She sends audios and photos. Each change comes back with **✅ Sí** / **❌ No** buttons, and nothing
   is published until she taps Sí. She can ask *"¿qué tengo publicado?"* or *"ayuda"*.
