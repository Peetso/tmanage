import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

interface FormParseCapable {
  hasContentTypeParser(contentType: string): boolean;
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'string' },
    handler: (
      request: unknown,
      body: string,
      done: (error: Error | null, value?: unknown) => void,
    ) => void,
  ): void;
}

/**
 * The OAuth token and revoke endpoints take `application/x-www-form-urlencoded` bodies (RFC 6749
 * §4.1.3, RFC 7009 §2.1). Fastify parses only JSON and text/plain by default, so this registers a
 * urlencoded parser at boot — the only place the app accepts form bodies, which is why it lives
 * with the module that needs it rather than in the shared adapter. Idempotent: a second module
 * init (as tests do) finds the parser already present and leaves it.
 */
@Injectable()
export class OAuthFormBodyParser implements OnApplicationBootstrap {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    const instance = this.adapterHost.httpAdapter.getInstance<FormParseCapable>();
    if (instance.hasContentTypeParser(FORM_CONTENT_TYPE)) return;
    instance.addContentTypeParser(
      FORM_CONTENT_TYPE,
      { parseAs: 'string' },
      (_request, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body)));
        } catch (error) {
          done(error instanceof Error ? error : new Error('Invalid form body'));
        }
      },
    );
  }
}
