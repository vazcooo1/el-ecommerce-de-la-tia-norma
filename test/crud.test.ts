import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChange, isCancel, ERR } from '../worker/operations.ts';
import type { Operation, PendingPhoto, Plan } from '../worker/operations.ts';
import { parseCatalog } from '../shared/catalog.ts';
import { formatPrice, buyLink } from '../shared/format.ts';

const base = () => parseCatalog({ products: [
  { id: 'taza-azul', name: 'Taza azul', price: 8000, inStock: true, photos: ['taza-azul/aaaa.jpg', 'taza-azul/bbbb.jpg'] },
  { id: 'plato-hondo', name: 'Plato hondo', price: 7500, inStock: true, photos: ['plato-hondo/cccc.jpg'] },
] });
const photo = (ref: string, mimeType = 'image/jpeg'): PendingPhoto => ({ ref, mediaId: `m-${ref}`, mimeType, receivedAt: 0 });
const seq = () => { let n = 0; return () => (++n).toString(16).padStart(4, '0'); };

function ok(ops: Operation[], pending: PendingPhoto[] = [], catalog = base()): Plan {
  const r = planChange(catalog, ops, pending, seq());
  if (!r.ok) assert.fail(r.error);
  parseCatalog(r.plan.catalog);
  return r.plan;
}
function fails(ops: Operation[], error: string, pending: PendingPhoto[] = []) {
  const r = planChange(base(), ops, pending, seq());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, error);
}

test('add_product with two photos goes on top and its buy link keeps special characters', () => {
  const plan = ok([{ type: 'add_product', name: 'Jarra verde', price: 12000, photoRefs: ['p1', 'p2'] }], [photo('p1'), photo('p2', 'image/png')]);
  assert.deepEqual(plan.catalog.products[0], { id: 'jarra-verde', name: 'Jarra verde', price: 12000, inStock: true, photos: ['jarra-verde/0001.jpg', 'jarra-verde/0002.png'] });
  assert.equal(plan.catalog.products.length, 3);
  assert.deepEqual(plan.photoAdds, [{ path: 'jarra-verde/0001.jpg', mediaId: 'm-p1' }, { path: 'jarra-verde/0002.png', mediaId: 'm-p2' }]);
  assert.deepEqual(plan.summaryLines, [`Nuevo producto: *Jarra verde* a *${formatPrice(12000)}* (2 fotos)`]);
  assert.deepEqual(plan.touchedExisting, []);
  const text = new URL(buyLink('5491100000000', 'Jarra & ñandú? 🏺')).searchParams.get('text');
  assert.equal(text, 'Hola, me interesa Jarra & ñandú? 🏺, mi nombre es: ');
});

test('names are cleaned and slugs avoid collisions', () => {
  const plan = ok([{ type: 'add_product', name: '  *Taza_ azúl*  ', price: 5000, photoRefs: ['p1'] }], [photo('p1')]);
  assert.equal(plan.catalog.products[0].name, 'Taza azúl');
  assert.equal(plan.catalog.products[0].id, 'taza-azul-2');
});

test('update_product renames and keeps the id', () => {
  const plan = ok([{ type: 'update_product', productId: 'taza-azul', name: 'Taza azul grande' }]);
  assert.equal(plan.catalog.products[0].id, 'taza-azul');
  assert.equal(plan.catalog.products[0].name, 'Taza azul grande');
  assert.deepEqual(plan.summaryLines, ['Cambiar nombre: *Taza azul* → *Taza azul grande*']);
  assert.deepEqual(plan.touchedExisting, ['taza-azul']);
});

test('update_product changes the price', () => {
  const plan = ok([{ type: 'update_product', productId: 'taza-azul', price: 9000 }]);
  assert.equal(plan.catalog.products[0].price, 9000);
  assert.deepEqual(plan.summaryLines, [`Cambiar precio de *Taza azul*: ${formatPrice(8000)} → *${formatPrice(9000)}*`]);
});

test('set_stock marks sold out and back in stock', () => {
  const out = ok([{ type: 'set_stock', productId: 'plato-hondo', inStock: false }]);
  assert.equal(out.catalog.products[1].inStock, false);
  assert.deepEqual(out.summaryLines, ['Marcar *Plato hondo* como ✖ SIN STOCK']);
  const back = ok([{ type: 'set_stock', productId: 'plato-hondo', inStock: true }], [], out.catalog);
  assert.equal(back.catalog.products[1].inStock, true);
  assert.deepEqual(back.summaryLines, ['Volver a poner *Plato hondo* EN VENTA']);
});

test('add_photos appends to the gallery', () => {
  const plan = ok([{ type: 'add_photos', productId: 'plato-hondo', photoRefs: ['p1'] }], [photo('p1')]);
  assert.deepEqual(plan.catalog.products[1].photos, ['plato-hondo/cccc.jpg', 'plato-hondo/0001.jpg']);
  assert.deepEqual(plan.photoAdds, [{ path: 'plato-hondo/0001.jpg', mediaId: 'm-p1' }]);
  assert.deepEqual(plan.summaryLines, ['Agregar 1 foto a *Plato hondo*']);
});

test('remove_photo deletes the file', () => {
  const plan = ok([{ type: 'remove_photo', productId: 'taza-azul', photoNumber: 2 }]);
  assert.deepEqual(plan.catalog.products[0].photos, ['taza-azul/aaaa.jpg']);
  assert.deepEqual(plan.photoDeletes, ['taza-azul/bbbb.jpg']);
  assert.deepEqual(plan.summaryLines, ['Sacar la foto 2 de *Taza azul*']);
});

test('remove_photo cannot leave a product without photos', () => {
  fails([{ type: 'remove_photo', productId: 'plato-hondo', photoNumber: 1 }], ERR.lastPhoto);
  fails([{ type: 'remove_photo', productId: 'plato-hondo', photoNumber: 3 }], ERR.badPhotoNumber(3));
});

test('remove_product deletes the product and its photos', () => {
  const plan = ok([{ type: 'remove_product', productId: 'taza-azul' }]);
  assert.deepEqual(plan.catalog.products.map(p => p.id), ['plato-hondo']);
  assert.deepEqual(plan.photoDeletes, ['taza-azul/aaaa.jpg', 'taza-azul/bbbb.jpg']);
  assert.deepEqual(plan.summaryLines, ['🗑️ Borrar *Taza azul* de la página']);
});

test('rejects bad input', () => {
  fails([], ERR.empty);
  fails([{ type: 'update_product', productId: 'nope', price: 100 }], ERR.unknownProduct);
  fails([{ type: 'add_product', name: 'Jarra', price: 100, photoRefs: [] }], ERR.needsPhoto);
  fails([{ type: 'add_product', name: 'Jarra', price: 100, photoRefs: ['p9'] }], ERR.badPhotos, [photo('p1')]);
  fails([{ type: 'add_product', name: 'Jarra', price: 100, photoRefs: ['p1'] }], ERR.badPhotoType, [photo('p1', 'image/gif')]);
  for (const price of [0, -1, 9.5]) fails([{ type: 'update_product', productId: 'taza-azul', price }], ERR.badPrice);
  fails([{ type: 'update_product', productId: 'taza-azul', name: ' ** ' }], ERR.badName);
  fails([{ type: 'remove_product', productId: 'taza-azul' }, { type: 'set_stock', productId: 'taza-azul', inStock: false }], ERR.conflict);
});

test('unchanged values are skipped and a change that changes nothing is rejected', () => {
  const plan = ok([{ type: 'update_product', productId: 'taza-azul', name: 'Taza azul', price: 9000 }]);
  assert.deepEqual(plan.summaryLines, [`Cambiar precio de *Taza azul*: ${formatPrice(8000)} → *${formatPrice(9000)}*`]);
  fails([{ type: 'update_product', productId: 'taza-azul', price: 8000 }], ERR.noChange);
  fails([{ type: 'set_stock', productId: 'plato-hondo', inStock: true }], ERR.noChange);
});

test('at most 10 new photos per change', () => {
  const pending = Array.from({ length: 11 }, (_, i) => photo(`p${i + 1}`));
  fails([
    { type: 'add_product', name: 'Jarra', price: 100, photoRefs: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] },
    { type: 'add_product', name: 'Vaso', price: 100, photoRefs: ['p7', 'p8', 'p9', 'p10', 'p11'] },
  ], ERR.tooManyNewPhotos, pending);
});

test('cancel', () => {
  assert.equal(isCancel([{ type: 'cancel' }]), true);
  assert.equal(isCancel([{ type: 'cancel' }, { type: 'remove_product', productId: 'taza-azul' }]), false);
});
