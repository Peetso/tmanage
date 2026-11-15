/**
 * The request header `src/proxy.ts` puts the page's path on, for the server components that
 * need it (`[orgSlug]/layout.tsx`, through `workspace-gate.ts`). The proxy always overwrites it,
 * so a value a client sent never reaches a page the proxy matched.
 */
export const REQUEST_PATH_HEADER = 'x-tmanage-path';
