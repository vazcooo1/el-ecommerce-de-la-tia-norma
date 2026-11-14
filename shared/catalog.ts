import { z } from 'zod';

/** Catalog rules. Shared by the Astro build and the Worker. */

export const PHOTO_EXTS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

export const ProductSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(80),
  price: z.number().int().min(1).max(99_999_999),
  inStock: z.boolean(),
  photos: z
    .array(z.string().regex(/^[a-z0-9-]+\/[0-9a-f]{4,}\.(jpg|png|webp)$/))
    .min(1)
    .max(10),
});

export const CatalogSchema = z
  .object({ products: z.array(ProductSchema) })
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    for (const p of catalog.products) {
      if (seen.has(p.id)) ctx.addIssue({ code: 'custom', message: `id repetido: ${p.id}` });
      seen.add(p.id);
    }
  });

export type Product = z.infer<typeof ProductSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

/** Throws an Error with a readable message when the data breaks the catalog rules. */
export function parseCatalog(data: unknown): Catalog {
  const result = CatalogSchema.safeParse(data);
  if (!result.success) throw new Error(`Catálogo inválido:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** In-stock products first, then out-of-stock; catalog order kept within each group. */
export function pageOrder(products: Product[]): Product[] {
  return [...products.filter((p) => p.inStock), ...products.filter((p) => !p.inStock)];
}
