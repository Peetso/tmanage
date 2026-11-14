import type { DisplayLocale } from '../api/display-preferences';
import type { DisplayFormat } from './display-format';

/**
 * FIX6 locale flash — the member's language and display format *for the request being rendered*,
 * as the browser-shared stores (`locale-store.ts`, `display-format.ts`) see it on the server.
 *
 * The stores are module singletons, one per server process, so they cannot hold a member's
 * locale. On the server they ask this bridge instead. The resolver is registered by the root
 * layout's server module (`server-html-attributes.ts`) and reads the current request's own
 * cookies from Next's request store each time it is called, so two requests rendered side by side
 * each see their own values; outside a per-request render (a build-time prerender) it answers
 * `undefined`. In the browser the bridge is never consulted: the stores boot from the same cookies.
 */
export interface RequestDisplay {
  readonly locale: DisplayLocale | undefined;
  readonly format: DisplayFormat;
}

type Resolver = () => RequestDisplay | undefined;

declare global {
  // One slot per server process, shared by the server-component and SSR module graphs.
  var __tmanageRequestDisplay: Resolver | undefined;
}

/** Server only: install the per-request resolver (idempotent). */
export function registerRequestDisplay(resolver: Resolver): void {
  globalThis.__tmanageRequestDisplay = resolver;
}

/** The current request's display values on the server; `undefined` in the browser or with none. */
export function requestDisplay(): RequestDisplay | undefined {
  if (typeof window !== 'undefined') return undefined;
  return globalThis.__tmanageRequestDisplay?.();
}
