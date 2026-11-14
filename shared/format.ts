const priceFormat = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
});

/** Whole pesos → "$ 9.000". */
export function formatPrice(pesos: number): string {
  return priceFormat.format(pesos);
}

function waLink(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

/** Opens WhatsApp with Norma, buy message pre-filled. */
export function buyLink(number: string, productName: string): string {
  return waLink(number, `Hola, me interesa ${productName}, mi nombre es: `);
}

/** Opens WhatsApp with Norma, general question pre-filled. */
export function contactLink(number: string): string {
  return waLink(number, 'Hola Norma, tengo una consulta');
}
