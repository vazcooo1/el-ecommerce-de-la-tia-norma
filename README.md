# El ecommerce de la tía Norma

Un ecommerce para las Norma de la vida.

Norma tiene más de setenta años y vende la cerámica que hace en su taller. Sus clientes tienen más
o menos su edad. Esta tienda está pensada para los dos lados: **quien compra** la usa sin ayuda
desde el teléfono, y **Norma** la mantiene al día sin tocar una computadora, solo con audios y
fotos por WhatsApp.

> **Prueba de concepto.** Los 10 productos de ejemplo son fotos de piezas de museo con licencia
> CC0 ([créditos](src/assets/products/CREDITS.md)), no cerámicas de Norma. Hay que sacarlos antes
> de compartir la página ([SETUP.md §6](SETUP.md#6-before-sharing-the-page-remove-the-sample-products)).

## Cómo se usa

### Quien compra

- Una sola página que se recorre scrolleando. No hay menús, carrito, cuentas ni formularios.
- Cada pieza muestra nombre, fotos y precio, y tiene un botón verde grande: **COMPRAR POR WHATSAPP**.
- El botón abre un chat con Norma con el mensaje ya escrito: *"Hola, me interesa Taza gatito, mi
  nombre es: "*. La venta se arregla ahí, como siempre.
- Lo que no hay en stock va al final, con un cartel rojo **✖ SIN STOCK** y sin botón de compra.

### Norma

Norma le habla a un número de WhatsApp aparte, el del bot. Los clientes nunca lo ven: el botón de
compra los manda al número de siempre de Norma.

1. Manda un audio: *"la taza gatito ahora sale 9000"*.
2. El bot le contesta qué entendió, y espera:

   ```
   1. Cambiar precio de Taza gatito: $ 9.500 → $ 9.000

   ¿Está bien?
            [ ✅ Sí ]   [ ❌ No ]
   ```

3. Toca **Sí**. El bot contesta *"✅ Listo. En unos minutos aparece en la página."*, y así es.

De la misma forma puede agregar un producto (fotos y un audio con el nombre y el precio), sumar o
sacar fotos, cambiar nombres o precios, marcar algo sin stock o volver a ponerlo en venta, y borrar
productos. Puede pedir varias cosas en el mismo audio.

## Cómo funciona

```
Norma (WhatsApp)
  │  audios, fotos, toques en los botones
  ▼
WhatsApp Cloud API (Meta)
  │  POST /webhook, firmado por Meta
  ▼
Worker de Cloudflare "tienda-norma"
  ├─ verifica la firma y que el número esté en la lista de permitidos
  └─ Durable Object, uno por número
       ├─ junta lo que llega en 5 segundos en un solo "turno"
       ├─ Gemini: audio + catálogo actual → lista de cambios en JSON
       ├─ código: valida los cambios y arma el resumen en castellano
       ├─ WhatsApp: "¿Está bien?"  [Sí] [No]
       └─ con el Sí → un commit en GitHub (products.json + fotos)
                          │
                          ▼
              Workers Builds: astro build → wrangler deploy
                          │
                          ▼
              página estática, servida por el mismo Worker
```

El catálogo vive en este repo: `src/data/products.json`, y las fotos en
`src/assets/products/<producto>/`. La página se arma a partir de ahí en cada build. Antes de
armarla se valida el catálogo: si algo está mal, el build falla y la versión anterior de la página
sigue online.

## Decisiones, y por qué

### WhatsApp, porque Norma usa WhatsApp

La primera idea fue un bot de Telegram: su API es gratis, abierta y fácil de programar. Pero Norma
solo usa WhatsApp, y pedirle que aprenda otra app iba contra todo el objetivo. No hay un puente
gratuito y legal de WhatsApp a Telegram. Las librerías no oficiales (tipo Baileys) necesitan un
servidor prendido todo el tiempo, violan los términos de WhatsApp y arriesgan que bloqueen el
número.

Por eso usamos la **API oficial (WhatsApp Cloud API) con el número de prueba que da Meta**: es
gratis, se configura en un rato y entrega cada mensaje directo a un webhook. Ese número solo puede
hablar con números verificados a mano, que es justo lo que queríamos: **el bot solo atiende a los
números de una lista**, por número de teléfono y no por IDs internos. A cualquier otro lo ignora en
silencio.

### Git como base de datos

El catálogo es un archivo JSON en este repo, y cada cambio confirmado es un commit. Workers Builds
ve el commit, arma la página de nuevo y la publica.

- **La página es 100 % estática:** rápida, gratis y sin nada que se pueda caer en el medio. Si el
  bot se rompe, la tienda sigue andando.
- **Historial y "deshacer" gratis:** cada cambio de Norma queda en `git log` y se revierte con
  `git revert`.
- **Ningún servicio extra:** ni base de datos ni almacenamiento de imágenes.

El costo es que un cambio tarda unos minutos en verse. La alternativa era guardar el catálogo en
un almacenamiento de Cloudflare y armar la página en cada visita: los cambios se verían al
instante, pero a cambio de más piezas móviles. Para una tienda de cerámica hecha a mano, unos
minutos no son urgentes.

### La IA propone, el código decide

Gemini no edita archivos. Recibe el audio, el catálogo actual y lo que se viene hablando, y
devuelve una lista de operaciones en JSON con un esquema fijo: agregar producto, cambiar nombre o
precio, cambiar el stock, sumar o sacar fotos, borrar producto, cancelar. Después, código común y
corriente:

- valida cada operación: que el producto exista, que el precio tenga sentido, que haya al menos una
  foto, que no se pidan cosas contradictorias;
- la aplica sobre una copia del catálogo;
- arma el resumen que ve Norma.

Si algo no cierra, Norma recibe un mensaje claro (*"No encontré ese producto. ¿Me decís el nombre
de nuevo?"*) y no cambia nada. Así un error de la IA nunca llega a la página sin pasar por el
código y por Norma.

### Nada se publica sin un "Sí"

La IA puede entender mal, así que cada cambio vuelve como un resumen numerado con dos botones,
✅ Sí y ❌ No, y recién con el Sí se hace el commit. Tocar un botón es más fácil que escribir, y no
deja lugar a dudas. Un botón viejo, de un cambio que ya no está pendiente, no publica nada.

Si Norma manda otro audio mientras hay un cambio esperando, **ese cambio no se descarta**: la IA
analiza el audio nuevo junto con el pendiente. Muchas veces el segundo audio aclara el primero
(*"no, la azul, no la verde"*), y tirar el primero dejaría al segundo sin sentido.

### Un Durable Object por número

WhatsApp manda cada foto como un mensaje separado, y a veces repite mensajes. Cada número tiene su
propio Durable Object, que:

- procesa los mensajes en orden, de a uno, así dos fotos no se pisan;
- espera 5 segundos de silencio y junta todo en un solo turno: cinco fotos y un audio dan una sola
  propuesta;
- ignora los mensajes repetidos;
- guarda el cambio pendiente hasta que Norma conteste.

KV no servía para esto: es eventualmente consistente y permite una sola escritura por segundo por
clave.

### Gemini 3.5 Flash-Lite

Tiene el free tier más generoso y entiende audio directamente, sin transcribir aparte. El modelo es
una variable (`GEMINI_MODEL`): si 3.5 no entiende bien a Norma, pasar a Gemini 3.8 Flash es cambiar
una línea, sin tocar código.

### Astro estático, diseñado para personas mayores

Astro genera HTML puro. El único JavaScript es un script chico para la galería de fotos. Las fotos
se optimizan al armar la página (WebP y JPG en varios tamaños), así que el Worker nunca procesa
imágenes.

La interfaz es lo más importante del proyecto:

- **Letra grande,** de 20 a 24 px según el teléfono, en **Atkinson Hyperlegible Next**, una
  tipografía pensada para personas con baja visión.
- **Contraste muy alto:** casi negro sobre crema.
- **El color nunca va solo:** verde es **COMPRAR**, rojo es **✖ SIN STOCK**, y siempre con texto.
- **Botones grandes,** de 64 px de alto, y una sola acción por producto.
- **Fotos enteras,** sin recortar, para que un florero alto no pierda la boca.
- **Lo que no hay en stock va al final.**

En Lighthouse para celulares da 100 en accesibilidad.

### Todo en planes gratuitos

| Servicio | Límite gratis | Uso esperado |
|---|---|---|
| Cloudflare Workers | 100.000 pedidos por día, 10 ms de CPU y 50 llamadas salientes por pedido | Ver la página no ejecuta código. El bot casi no calcula: más que nada espera respuestas. |
| Durable Objects | 100.000 pedidos por día | Unos pocos por audio. |
| Workers Builds | 3.000 minutos de build por mes | Un build por cambio confirmado. |
| WhatsApp Cloud API | 1.000 mensajes de servicio por mes. Sin tarjeta cargada, al pasarse simplemente deja de enviar. | Unas decenas por mes. |
| Gemini (AI Studio) | Límites del free tier | Un puñado de llamadas por día. |

Dos consecuencias de estos límites:

- **Hasta 10 fotos nuevas por cambio,** para no pasar las 50 llamadas salientes al publicar.
- **El bot nunca escribe primero.** WhatsApp solo deja responder gratis dentro de las 24 horas del
  último mensaje del usuario. Por eso no hay alertas: los errores quedan en los logs del Worker.

### Tests: solo donde vale la pena

Hay un solo archivo de test, `test/crud.test.ts`, sin framework, porque Node ejecuta TypeScript
directamente. Pasa cada tipo de cambio por la misma función que usa el bot (`planChange`). Así
sabemos que cada "herramienta" de la IA deja un catálogo válido, los archivos de fotos correctos y
el texto de confirmación correcto. Lo demás (el webhook, la conversación, Gemini y los commits) se
prueba a mano, con conversaciones reales. Fue una decisión explícita: tests solo donde son
sencillos.

### Seguridad y privacidad

- El webhook solo acepta mensajes con la firma de Meta.
- Solo responden los números de la lista. Al resto se lo ignora sin contestar.
- Ni las claves ni los números de teléfono están en el repo: son secrets del Worker o variables de
  build.
- La IA solo devuelve datos. Nunca escribe archivos.

## Lo que todavía falta

Cosas conocidas que quedaron para después de la prueba:

- Una foto con texto al pie se toma como foto sola, y el bot pide el audio igual.
- Si GitHub no responde, Norma recibe *"No entendí bien el audio"*, que confunde.
- Tocar Sí de nuevo después de un error poco claro al guardar podría aplicar el cambio dos veces.
- Si Cloudflare reinicia el Durable Object en medio de un turno, ese turno se pierde sin respuesta.
- Los usuarios de WhatsApp que solo se identifican con nombre de usuario no se pueden agregar a la
  lista en la práctica.

Quedan afuera a propósito: pagos, carrito, descripciones, categorías, búsqueda, panel de
administración y dominio propio (este se puede agregar después sin tocar código).

## Estructura del repo

```
src/data/products.json        el catálogo (lo edita el bot)
src/data/site.json            nombre y lema de la tienda
src/assets/products/<id>/     las fotos de cada producto
src/pages/index.astro         la página
src/components/               tarjeta de producto, galería, "cómo comprar", pie
shared/catalog.ts             las reglas del catálogo, que usan la página y el bot
worker/index.ts               el webhook: firma, lista de números, reparto
worker/session.ts             el Durable Object: turnos, confirmación, publicación
worker/agent.ts               Gemini: el pedido, el esquema y las instrucciones
worker/operations.ts          las "herramientas" de la IA, validadas en código
worker/whatsapp.ts            mandar mensajes y bajar fotos de WhatsApp
worker/github.ts              leer el catálogo y hacer el commit
scripts/try-agent.ts          probar a Gemini sin WhatsApp
test/crud.test.ts             el test de los cambios de producto
```

## Probarlo

Hace falta Node 22.23 o más nuevo y pnpm 11.

```bash
pnpm install
PUBLIC_WHATSAPP_NUMBER=5491112345678 pnpm dev   # la página en http://localhost:4321; cualquier número sirve para mirar
pnpm test                                       # el test de los cambios de producto
```

Para probar a Gemini sin WhatsApp, con la clave en `.dev.vars`:

```bash
node --env-file=.dev.vars scripts/try-agent.ts "la taza gatito ahora sale 9000"
```

Para conectar WhatsApp, Gemini, GitHub y Cloudflare, seguí [SETUP.md](SETUP.md) (en inglés).

## Licencia

El código es GPL-3.0-or-later ([LICENSE](LICENSE)). Las fotos de ejemplo son CC0, de Wikimedia
Commons ([créditos](src/assets/products/CREDITS.md)).
