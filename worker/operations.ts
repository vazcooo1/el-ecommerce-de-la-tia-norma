import type { Catalog, Product } from '../shared/catalog.ts';
import { parseCatalog, PHOTO_EXTS } from '../shared/catalog.ts';
import { formatPrice } from '../shared/format.ts';

/**
 * The agent's "tools": operations Gemini proposes, validated and applied here in code.
 * Gemini never edits the catalog itself.
 */

export type OpType =
  | 'add_product'
  | 'update_product'
  | 'set_stock'
  | 'add_photos'
  | 'remove_photo'
  | 'remove_product'
  | 'cancel';

export type Operation = {
  type: OpType;
  productId?: string;
  name?: string;
  price?: number;
  inStock?: boolean;
  photoRefs?: string[];
  photoNumber?: number;
};

export type PendingPhoto = { ref: string; mediaId: string; mimeType: string; caption?: string; receivedAt: number };

/** `path` is relative to src/assets/products. */
export type PhotoAdd = { path: string; mediaId: string };

export type Plan = {
  catalog: Catalog;
  photoAdds: PhotoAdd[];
  photoDeletes: string[];
  summaryLines: string[];
  touchedExisting: string[];
};

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

export const ERR = {
  empty: 'No entendí qué cambio querés hacer. ¿Me lo decís de nuevo?',
  unknownProduct: 'No encontré ese producto. ¿Me decís el nombre de nuevo?',
  needsPhoto: 'Para agregar un producto nuevo necesito al menos una foto. Mandame la foto y después el audio.',
  lastPhoto: 'No puedo sacar esa foto: cada producto tiene que tener al menos una foto.',
  badPrice: 'El precio no me quedó claro. ¿Me lo decís de nuevo?',
  badName: 'El nombre no me quedó claro. ¿Me lo decís de nuevo?',
  badPhotoNumber: (n: number) => `Ese producto no tiene la foto número ${n}.`,
  badPhotos: 'No me quedó claro qué fotos van con qué producto. ¿Me lo explicás de nuevo?',
  conflict: 'Me pediste cosas que se contradicen para el mismo producto. ¿Me lo decís de nuevo?',
  tooManyPhotos: 'Un producto puede tener hasta 10 fotos.',
  badPhotoType: 'Esa foto no la puedo usar. Mandala como foto común, por favor.',
  noChange: 'Eso ya está así en la página 🙂',
  tooManyNewPhotos: 'Mandame hasta 10 fotos por vez, por favor.',
};

const MAX_PHOTOS = 10;
/** Keeps one publish under the Workers Free limit of 50 subrequests (3 per new photo + ~15). */
const MAX_NEW_PHOTOS = 10;

/** Exactly one operation and it is `cancel`. */
export function isCancel(ops: Operation[]): boolean {
  return ops.length === 1 && ops[0]?.type === 'cancel';
}

/** Validates the operations against the catalog and pending photos, then applies them. Never throws for bad input. */
export function planChange(
  catalog: Catalog,
  ops: Operation[],
  pending: PendingPhoto[],
  randomHex: () => string = defaultHex,
): PlanResult {
  try {
    return { ok: true, plan: build(catalog, ops, pending, randomHex) };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, error: e.message };
    throw e;
  }
}

class Reject extends Error {}

function reject(message: string): never {
  throw new Reject(message);
}

const cleanName = (name: string) => name.replace(/[*_~`\n\r]/g, '').trim();
const validName = (name: string) => name.length >= 1 && name.length <= 80;
const validPrice = (price: unknown): price is number =>
  typeof price === 'number' && Number.isInteger(price) && price >= 1 && price <= 99_999_999;
const photos = (n: number) => `${n} ${n === 1 ? 'foto' : 'fotos'}`;

function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'producto';
}

function defaultHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Checks every operation before anything is applied. */
function prevalidate(original: Map<string, Product>, ops: Operation[], pending: PendingPhoto[]): void {
  if (ops.length === 0) reject(ERR.empty);
  if (ops.some((op) => op.type === 'cancel')) reject(ERR.conflict);

  const removed = new Set(ops.filter((op) => op.type === 'remove_product').map((op) => op.productId));
  const counts = new Map<string, number>();
  const usedRefs = new Set<string>();
  const pendingRefs = new Set(pending.map((p) => p.ref));

  for (const op of ops) {
    if (op.type !== 'add_product') {
      const product = op.productId ? original.get(op.productId) : undefined;
      if (!product) reject(ERR.unknownProduct);
      if (removed.has(product.id) && op.type !== 'remove_product') reject(ERR.conflict);
      if (op.type === 'update_product' || op.type === 'set_stock' || op.type === 'remove_product') {
        const key = `${op.type}:${product.id}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (counts.get(key)! > 1) reject(ERR.conflict);
      }
      if (op.type === 'update_product' && op.name === undefined && op.price === undefined) reject(ERR.empty);
      if (op.type === 'set_stock' && typeof op.inStock !== 'boolean') reject(ERR.empty);
      if (op.type === 'remove_photo') {
        const n = op.photoNumber ?? 0;
        if (!Number.isInteger(n) || n < 1 || n > product.photos.length) reject(ERR.badPhotoNumber(n));
        const key = `photo:${product.id}:${n}`;
        if (counts.has(key)) reject(ERR.conflict);
        counts.set(key, 1);
      }
    }
    if (op.type === 'add_product' || op.type === 'add_photos') {
      const refs = op.photoRefs ?? [];
      if (refs.length === 0) reject(op.type === 'add_product' ? ERR.needsPhoto : ERR.badPhotos);
      for (const ref of refs) {
        if (!pendingRefs.has(ref) || usedRefs.has(ref)) reject(ERR.badPhotos);
        usedRefs.add(ref);
      }
    }
  }
  if (usedRefs.size > MAX_NEW_PHOTOS) reject(ERR.tooManyNewPhotos);
}

function build(catalog: Catalog, ops: Operation[], pending: PendingPhoto[], randomHex: () => string): Plan {
  const original = new Map(catalog.products.map((p) => [p.id, p]));
  prevalidate(original, ops, pending);

  const products: Product[] = structuredClone(catalog.products);
  const byId = new Map(products.map((p) => [p.id, p]));
  const pendingByRef = new Map(pending.map((p) => [p.ref, p]));
  const takenIds = new Set(byId.keys());
  const usedPaths = new Set(products.flatMap((p) => p.photos));

  const added: Product[] = [];
  const photoAdds: PhotoAdd[] = [];
  const photoDeletes: string[] = [];
  const removedPhotos = new Set<string>();
  const removedProducts = new Set<string>();
  const summaryLines: string[] = [];
  const touched: string[] = [];

  const newPhotoPath = (productId: string, ref: string): string => {
    const photo = pendingByRef.get(ref)!;
    const ext = PHOTO_EXTS[photo.mimeType as keyof typeof PHOTO_EXTS];
    if (!ext) reject(ERR.badPhotoType);
    let path: string;
    do path = `${productId}/${randomHex()}.${ext}`;
    while (usedPaths.has(path));
    usedPaths.add(path);
    photoAdds.push({ path, mediaId: photo.mediaId });
    return path;
  };

  for (const op of ops) {
    if (op.type === 'add_product') {
      const name = cleanName(op.name ?? '');
      if (!validName(name)) reject(ERR.badName);
      if (!validPrice(op.price)) reject(ERR.badPrice);
      const slug = slugify(name);
      let id = slug;
      for (let n = 2; takenIds.has(id); n++) id = `${slug}-${n}`;
      takenIds.add(id);
      const refs = op.photoRefs ?? [];
      added.push({ id, name, price: op.price, inStock: true, photos: refs.map((ref) => newPhotoPath(id, ref)) });
      summaryLines.push(`Nuevo producto: *${name}* a *${formatPrice(op.price)}* (${photos(refs.length)})`);
      continue;
    }

    const product = byId.get(op.productId!)!;
    if (!touched.includes(product.id)) touched.push(product.id);

    switch (op.type) {
      // Fields equal to the current value are skipped: no "Taza → Taza" lines, no empty commits.
      case 'update_product': {
        if (op.name !== undefined) {
          const name = cleanName(op.name);
          if (!validName(name)) reject(ERR.badName);
          if (name !== product.name) {
            summaryLines.push(`Cambiar nombre: *${product.name}* → *${name}*`);
            product.name = name;
          }
        }
        if (op.price !== undefined) {
          if (!validPrice(op.price)) reject(ERR.badPrice);
          if (op.price !== product.price) {
            summaryLines.push(
              `Cambiar precio de *${product.name}*: ${formatPrice(product.price)} → *${formatPrice(op.price)}*`,
            );
            product.price = op.price;
          }
        }
        break;
      }
      case 'set_stock':
        if (op.inStock !== product.inStock) {
          product.inStock = op.inStock!;
          summaryLines.push(
            op.inStock ? `Volver a poner *${product.name}* EN VENTA` : `Marcar *${product.name}* como ✖ SIN STOCK`,
          );
        }
        break;
      case 'add_photos': {
        const refs = op.photoRefs ?? [];
        product.photos.push(...refs.map((ref) => newPhotoPath(product.id, ref)));
        summaryLines.push(`Agregar ${photos(refs.length)} a *${product.name}*`);
        break;
      }
      case 'remove_photo': {
        const path = original.get(product.id)!.photos[op.photoNumber! - 1]!;
        removedPhotos.add(path);
        photoDeletes.push(path);
        summaryLines.push(`Sacar la foto ${op.photoNumber} de *${product.name}*`);
        break;
      }
      case 'remove_product':
        removedProducts.add(product.id);
        photoDeletes.push(...original.get(product.id)!.photos);
        summaryLines.push(`🗑️ Borrar *${product.name}* de la página`);
        break;
    }
  }

  if (summaryLines.length === 0) reject(ERR.noChange);

  const kept = products.filter((p) => !removedProducts.has(p.id));
  for (const p of kept) {
    p.photos = p.photos.filter((path) => !removedPhotos.has(path));
    if (p.photos.length === 0) reject(ERR.lastPhoto);
    if (p.photos.length > MAX_PHOTOS) reject(ERR.tooManyPhotos);
  }
  for (const p of added) if (p.photos.length > MAX_PHOTOS) reject(ERR.tooManyPhotos);

  let next: Catalog;
  try {
    next = parseCatalog({ products: [...added, ...kept] });
  } catch {
    reject(ERR.badName);
  }

  return { catalog: next, photoAdds, photoDeletes, summaryLines, touchedExisting: touched };
}
