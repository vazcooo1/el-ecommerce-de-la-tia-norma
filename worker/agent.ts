import { Buffer } from 'node:buffer';
import type { Catalog } from '../shared/catalog.ts';
import { Failure, errorText, guard, statusKind } from './failures.ts';
import type { Operation, OpType, PendingPhoto } from './operations.ts';

/** One Gemini call per turn: audio + context in, structured operations out. */

export type HistoryEntry = { heard: string; replied: string };

export type AgentInput = {
  catalog: Catalog;
  pending: PendingPhoto[];
  proposal: Operation[] | null;
  history: HistoryEntry[];
  audios: { bytes: Uint8Array; mimeType: string }[];
  texts: string[];
};

export type AgentResult = {
  heard: string;
  kind: 'proposal' | 'question' | 'info';
  operations: Operation[];
  reply: string;
};

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

const OP_TYPES: OpType[] = [
  'add_product',
  'update_product',
  'set_stock',
  'add_photos',
  'remove_photo',
  'remove_product',
  'cancel',
];

export const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['heard', 'kind', 'operations', 'reply'],
  properties: {
    heard: { type: 'string' },
    kind: { type: 'string', enum: ['proposal', 'question', 'info'] },
    reply: { type: 'string' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', enum: OP_TYPES },
          productId: { type: 'string' },
          name: { type: 'string' },
          price: { type: 'integer' },
          inStock: { type: 'boolean' },
          photoRefs: { type: 'array', items: { type: 'string' } },
          photoNumber: { type: 'integer' },
        },
      },
    },
  },
};

export const SYSTEM_PROMPT = `Sos el asistente de la tienda online de Norma, una señora que hace cerámica artesanal. Norma te habla por audios, mensajes y fotos de WhatsApp para cambiar los productos de su página. Respondé siempre en español rioplatense, corto, cálido y muy simple.

Podés proponer estas operaciones:
- add_product: producto nuevo. Necesita name, price (pesos, número entero) y photoRefs con al menos una foto pendiente (p1, p2…).
- update_product: cambiar name y/o price de un producto existente (productId).
- set_stock: inStock=false para "sin stock / se vendió / no hay más"; inStock=true para "volvió a haber / hay de nuevo".
- add_photos: agregar fotos pendientes (photoRefs) a un producto existente.
- remove_photo: sacar una foto; photoNumber empieza en 1 ("la primera foto" = 1).
- remove_product: sacar el producto de la página.
- cancel: Norma no quiere el cambio pendiente ("no, dejá", "olvidate").

Reglas:
- Usá solo productId del CATÁLOGO ACTUAL. Si no está claro de qué producto habla, kind="question" y preguntá mostrando las opciones numeradas por nombre.
- Nunca inventes precios ni nombres. Si falta un dato, kind="question".
- Si hay un CAMBIO PENDIENTE, el mensaje nuevo puede corregirlo, completarlo o cancelarlo: devolvé SIEMPRE la propuesta completa actualizada (incluyendo lo pendiente que siga valiendo).
- Los precios se dicen como "nueve mil", "9.000", "9 lucas": convertilos a número entero (9000).
- Fotos pendientes: si Norma no dice para qué son y no se deduce, preguntá.
- Un mensaje que empieza con "(foto p3)" es lo que Norma escribió al pie de esa foto: tomalo como un pedido sobre esa foto (por ejemplo, "(foto p3) jarra verde 12000" es un producto nuevo con la foto p3).
- Si Norma pregunta qué tiene publicado, kind="info" y en reply listá cada producto con su precio y si está sin stock.
- Si Norma pide ayuda o no sabe qué decir, kind="info" y en reply explicá con ejemplos: "La taza azul ahora sale 9000", "El plato hondo se vendió", "Producto nuevo: jarra verde, 12000 (con las fotos)", "Sacá la segunda foto de la taza azul", "Borrá el plato hondo", "¿Qué tengo publicado?".
- En cada operación incluí solo los campos que cambian; no mandes campos vacíos ni en cero.
- En "heard" escribí lo que entendiste que dijo Norma. En kind="proposal", reply puede ir vacío.`;

/** The text part of the request: current state, one JSON block per heading. */
export function buildContext(input: AgentInput): string {
  const block = (title: string, value: unknown) => `${title}\n${JSON.stringify(value)}`;
  return [
    block(
      'CATÁLOGO ACTUAL:',
      input.catalog.products.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        inStock: p.inStock,
        fotos: p.photos.length,
      })),
    ),
    block(
      'FOTOS PENDIENTES:',
      input.pending.map((p) => ({ ref: p.ref, caption: p.caption ?? '' })),
    ),
    input.proposal ? block('CAMBIO PENDIENTE (sin confirmar):', input.proposal) : 'CAMBIO PENDIENTE (sin confirmar):\nninguno',
    block(
      'CONVERSACIÓN RECIENTE:',
      input.history.map((h) => ({ norma: h.heard, bot: h.replied })),
    ),
    block('MENSAJES DE TEXTO:', input.texts),
    input.audios.length > 0 ? 'Los audios adjuntos son lo que Norma pide ahora.' : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** An HTTP error from Gemini. A 429 says which free quota ran out: per minute (temporary) or per day. */
async function geminiFailure(res: Response): Promise<Failure> {
  const detail = await res.text().catch(() => '');
  const kind = res.status === 429 && /PerDay/i.test(detail) ? 'daily-limit' : statusKind(res.status);
  return new Failure(kind, `Gemini HTTP ${res.status}: ${detail.slice(0, 500)}`);
}

/**
 * Calls Gemini. One more try after an unusable answer, or 2 s after a temporary failure. Throws a
 * Failure: not-understood, temporary, daily-limit or needs-helper (bad key, unknown model).
 */
export async function runAgent(
  cfg: { apiKey: string; model: string; fetchFn?: typeof fetch },
  input: AgentInput,
): Promise<AgentResult> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          { text: buildContext(input) },
          ...input.audios.map((a) => ({
            // WhatsApp sends "audio/ogg; codecs=opus"; Gemini lists the bare type.
            inline_data: { mime_type: a.mimeType.split(';')[0]!.trim(), data: Buffer.from(a.bytes).toString('base64') },
          })),
        ],
      },
    ],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: RESPONSE_SCHEMA },
  });

  type Answer = { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
  let last: Failure | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (last?.kind === 'temporary') await new Promise((resolve) => setTimeout(resolve, 2_000));
    try {
      const res = await guard('Gemini', () =>
        fetchFn(`${GEMINI}/models/${cfg.model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
          body,
          signal: AbortSignal.timeout(30_000),
        }),
      );
      if (!res.ok) throw await geminiFailure(res);
      const data = await guard('Gemini', () => res.json() as Promise<Answer>);
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought)
        .map((p) => p.text ?? '')
        .join('');
      return parseResult(text);
    } catch (e) {
      last = e instanceof Failure ? e : new Failure('not-understood', errorText(e));
      // Trying again right away cannot fix a bad key or an empty daily quota.
      if (last.kind === 'needs-helper' || last.kind === 'daily-limit') throw last;
    }
  }
  throw last!;
}

/** Gemini's answer text, checked against the response schema. Anything off is not-understood. */
function parseResult(text: string): AgentResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Failure('not-understood', `Gemini no devolvió JSON: ${text.slice(0, 300)}`);
  }
  const r = raw as Partial<AgentResult> | null;
  if (
    !r ||
    typeof r.heard !== 'string' ||
    !['proposal', 'question', 'info'].includes(r.kind as string) ||
    !Array.isArray(r.operations) ||
    typeof r.reply !== 'string'
  ) {
    throw new Failure('not-understood', `Respuesta inválida de Gemini: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  // Models often fill optional fields with "" or 0. Treat those as "not mentioned", so a price
  // change with name:"" is not rejected as a bad name. (A real 0 price is never valid anyway.)
  const given = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== 0;
  const operations: Operation[] = r.operations
    .filter((op) => op && OP_TYPES.includes(op.type))
    .map((op) => ({
      type: op.type,
      ...(given(op.productId) && { productId: op.productId }),
      ...(given(op.name) && { name: op.name }),
      ...(given(op.price) && { price: op.price }),
      ...(typeof op.inStock === 'boolean' && { inStock: op.inStock }),
      ...(Array.isArray(op.photoRefs) && { photoRefs: op.photoRefs }),
      ...(given(op.photoNumber) && { photoNumber: op.photoNumber }),
    }));
  return { heard: r.heard, kind: r.kind as AgentResult['kind'], operations, reply: r.reply };
}
