import { Inject, Injectable, UnsupportedMediaTypeException } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/**
 * F43 (wave 9). The only routes that take a form body. Everywhere else a form post gets the 415
 * Fastify gave before this parser existed - so a cross-site HTML form (a CORS "simple" request,
 * never preflighted) can no longer deliver `email`/`password` to the sign-in routes.
 */
export const FORM_BODY_ROUTES: ReadonlySet<string> = new Set(['/oauth/token', '/oauth/revoke']);

/** The path of a request URL, without its query or fragment. */
export function formBodyAllowed(url: string | undefined): boolean {
  if (typeof url !== 'string') return false;
  const end = url.search(/[?#]/);
  return FORM_BODY_ROUTES.has(end === -1 ? url : url.slice(0, end));
}

interface FormParseCapable {
  hasContentTypeParser(contentType: string): boolean;
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'string' },
    handler: (
      request: { readonly url?: string; readonly is404?: boolean },
      body: string,
      done: (error: Error | null, value?: unknown) => void,
    ) => void,
  ): void;
}

/**
 * The OAuth token and revoke endpoints take `application/x-www-form-urlencoded` bodies (RFC 6749
 * §4.1.3, RFC 7009 §2.1). Fastify parses only JSON and text/plain by default, so this registers a
 * urlencoded parser at boot, scoped to those two paths (415 everywhere else, F43) — the only place
 * the app accepts form bodies, which is why it lives
 * with the module that needs it rather than in the shared adapter. Idempotent: a second module
 * init (as tests do) finds the parser already present and leaves it. A standalone application
 * context (the `--once` jobs) has no HTTP adapter, and the hook then does nothing.
 */
@Injectable()
export class OAuthFormBodyParser implements OnApplicationBootstrap {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    // The cron jobs (`verify.ts`, `sweep.ts`, `reconcile.ts`, `cleanup.ts`) compose the same module
    // graph as a standalone application context, which has no HTTP adapter and takes no request
    // bodies — so there is nothing to register. Nest types the getter as always present; it is not.
    const adapter = this.adapterHost.httpAdapter as
      HttpAdapterHost['httpAdapter'] | null | undefined;
    if (adapter == null) return;
    const instance = adapter.getInstance<FormParseCapable>();
    if (instance.hasContentTypeParser(FORM_CONTENT_TYPE)) return;
    instance.addContentTypeParser(
      FORM_CONTENT_TYPE,
      { parseAs: 'string' },
      (request, body, done) => {
        if (request.is404 === true) {
          // No route at all: the not-found handler answers as it always did.
          done(null, {});
          return;
        }
        if (!formBodyAllowed(request.url)) {
          done(new UnsupportedMediaTypeException());
          return;
        }
        try {
          done(null, Object.fromEntries(new URLSearchParams(body)));
        } catch (error) {
          done(error instanceof Error ? error : new Error('Invalid form body'));
        }
      },
    );
  }
}
