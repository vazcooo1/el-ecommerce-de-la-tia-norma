import type { APIRoute, GetStaticPaths } from 'astro';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCatalog } from '../../../shared/catalog.ts';
import productsData from '../../data/products.json';

/** Publishes each original photo at a stable URL: /fotos/<productId>/<file>. */
export const getStaticPaths = (() =>
  parseCatalog(productsData).products.flatMap((p) =>
    p.photos.map((path) => ({ params: { path } })),
  )) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ params }) =>
  new Response(await readFile(join(process.cwd(), 'src/assets/products', params.path!)));
