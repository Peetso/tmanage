/**
 * `node:crypto`, for the browser bundle Storybook builds — and only for it.
 *
 * ## Why this file has to exist
 *
 * Every screen that shows a state list imports `@tmanage/domain`, whose barrel reaches two
 * modules that open with `import … from 'node:crypto'`:
 * `value-objects/uuid-v7.ts` (`randomFillSync`) and `realtime/ticket.ts` (`createHmac`,
 * `timingSafeEqual`). Vite resolves `node:crypto` in a browser build to its
 * `__vite-browser-external` stub, and Rollup then refuses a *named* import from that stub
 * even when nothing calls the binding — the build fails at `"randomFillSync" is not exported
 * by "__vite-browser-external"` before tree-shaking can drop it. Next.js's bundler does not
 * hit this: it drops the unreferenced modules first.
 *
 * So the alias in `main.ts` points `node:crypto` here. This is a Storybook-only build
 * concern; it changes nothing about the application, the API, or the worker, all of which
 * run on Node and get the real module.
 *
 * ## What each export does, and why it is not a lie
 *
 * `randomFillSync` is **real**. The Web Crypto `getRandomValues` is a CSPRNG with the same
 * guarantee the Node function is used for in `uuid-v7.ts` — filling 10 bytes of `rand_a` and
 * `rand_b` — so a `uuidV7()` generated inside a story is a genuine v7 identifier, not a
 * predictable stand-in. Weakening it would be worse than throwing.
 *
 * `createHmac` and `timingSafeEqual` **throw**. There is no honest synchronous browser
 * implementation: Web Crypto's HMAC is promise-based, and a hand-rolled comparison would not
 * be constant-time. More to the point, nothing in `apps/web` should ever mint or verify a
 * realtime ticket in the browser — that is the server's half of `realtime/ticket.ts`. A
 * throw with a sentence naming the reason is the correct behaviour for a call that should
 * never happen; a silent wrong answer is not.
 */

/** Fills `target` with cryptographically strong random bytes, as `node:crypto` does. */
export function randomFillSync<T extends ArrayBufferView>(target: T): T {
  globalThis.crypto.getRandomValues(target as unknown as Uint8Array);
  return target;
}

export function createHmac(): never {
  throw new Error(
    'createHmac is not available in the Storybook browser bundle. Realtime tickets are minted and verified on the server (packages/domain/src/realtime/ticket.ts); no screen should compute one.',
  );
}

export function timingSafeEqual(): never {
  throw new Error(
    'timingSafeEqual is not available in the Storybook browser bundle. Constant-time comparison belongs on the server; see packages/domain/src/realtime/ticket.ts.',
  );
}
