/**
 * Try the Gemini agent by hand, without WhatsApp.
 *
 *   node --env-file=.dev.vars scripts/try-agent.ts "la taza gatito ahora sale 9000"
 *   node --env-file=.dev.vars scripts/try-agent.ts --audio nota.ogg
 *   node --env-file=.dev.vars scripts/try-agent.ts --photos 2 "producto nuevo, jarra verde, 12000"
 *
 * Reads GEMINI_API_KEY and GEMINI_MODEL (default gemini-3.5-flash-lite) from the environment.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseCatalog } from '../shared/catalog.ts';
import { runAgent } from '../worker/agent.ts';
import { Failure } from '../worker/failures.ts';
import type { PendingPhoto } from '../worker/operations.ts';

const AUDIO_TYPES: Record<string, string> = {
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mp3',
  '.m4a': 'audio/m4a',
  '.wav': 'audio/wav',
};

const args = process.argv.slice(2);
const audios: { bytes: Uint8Array; mimeType: string }[] = [];
const texts: string[] = [];
const pending: PendingPhoto[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--audio') {
    const file = args[++i]!;
    audios.push({ bytes: await readFile(file), mimeType: AUDIO_TYPES[extname(file).toLowerCase()] ?? 'audio/ogg' });
  } else if (arg === '--photos') {
    const n = Number(args[++i]);
    for (let p = 1; p <= n; p++) pending.push({ ref: `p${p}`, mediaId: `fake-${p}`, mimeType: 'image/jpeg', receivedAt: Date.now() });
  } else {
    texts.push(arg);
  }
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('Falta GEMINI_API_KEY (poné la clave en .dev.vars)');
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const catalog = parseCatalog(JSON.parse(await readFile('src/data/products.json', 'utf8')));
const started = Date.now();
try {
  const result = await runAgent({ apiKey, model }, { catalog, pending, proposal: null, history: [], audios, texts });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  if (!(e instanceof Failure)) throw e;
  // The kind decides what Norma would hear: see failureReply in worker/session.ts.
  console.error(`Failure (${e.kind}): ${e.message}`);
  process.exitCode = 1;
}
console.error(`(${model}, ${Date.now() - started} ms)`);
