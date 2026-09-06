/**
 * The API's CORS policy, as one value `main.ts` hands to `enableCors` — a value so that a
 * test can hold it against a real preflight, which `main.ts` (listen, exit code) cannot be.
 *
 * Credentials are sent cross-origin, so the origin list is exact: `packages/config` rejects
 * a wildcard outright, and `credentials: true` with `origin: '*'` is refused by browsers
 * anyway. `X-CSRF-Token` has to be allowed explicitly or the preflight fails and every
 * mutation from the web app breaks. `ETag` is exposed because the browser collects one per
 * uploaded part and hands them all to `complete` (FILE-001b) — a header the browser cannot
 * read is a completion it cannot make.
 *
 * `methods` is listed in full (review finding D20, 2026-09-06). `@fastify/cors` 11 defaults
 * to `GET,HEAD,POST` — not the `cors` package's six — and this application had been relying
 * on the default without saying so. The e2e stack, the only split-origin deployment that ever
 * sent a `DELETE` from a page, was refused: `Method DELETE is not allowed by
 * Access-Control-Allow-Methods`. The two `DELETE` routes are the sign-out and the removal of
 * a second factor; `PUT` and `PATCH` were refused the same way. Without this line a browser
 * on a sibling origin can do none of them. Same-origin deployments (the recommended topology,
 * `apps/web/README.md`) never preflight, which is how it stayed unseen. `OPTIONS` itself is
 * not a method the browser asks about, and is not listed.
 */
export const CORS_ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const CORS_ALLOWED_HEADERS = ['content-type', 'x-csrf-token', 'x-correlation-id'] as const;

export const CORS_EXPOSED_HEADERS = ['x-correlation-id', 'etag'] as const;

/**
 * The shape `@fastify/cors` accepts, spelled here rather than imported: the plugin is
 * `@nestjs/platform-fastify`'s dependency, not this package's, and Nest's own `CorsOptions`
 * (written for `cors`) is not assignable to it under `exactOptionalPropertyTypes`.
 */
export interface CorsPolicy {
  origin: string[];
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
}

export function corsOptions(allowedOrigins: readonly string[]): CorsPolicy {
  return {
    origin: [...allowedOrigins],
    credentials: true,
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
  };
}
