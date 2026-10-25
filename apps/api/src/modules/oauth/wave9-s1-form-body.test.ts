import 'reflect-metadata';
import type { HttpAdapterHost } from '@nestjs/core';
import { UnsupportedMediaTypeException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { formBodyAllowed, OAuthFormBodyParser } from './form-body.parser.js';

/**
 * Wave 9, lane S1, F43: the urlencoded parser used to be instance-wide, so a cross-site HTML form
 * (a CORS simple request, never preflighted) could post `email`/`password` to the sign-in route.
 * It now parses only on `/oauth/token` and `/oauth/revoke` and answers 415 everywhere else.
 */

type Handler = (
  request: { url?: string; is404?: boolean },
  body: string,
  done: (error: Error | null, value?: unknown) => void,
) => void;

function parser(): Handler {
  const handlers = new Map<string, Handler>();
  const instance = {
    hasContentTypeParser: (type: string) => handlers.has(type),
    addContentTypeParser: (type: string, _options: unknown, handler: Handler) => {
      handlers.set(type, handler);
    },
  };
  new OAuthFormBodyParser({
    httpAdapter: { getInstance: () => instance },
  } as unknown as HttpAdapterHost).onApplicationBootstrap();
  return handlers.get('application/x-www-form-urlencoded')!;
}

describe('F43: form bodies only on the OAuth token and revoke routes', () => {
  it('answers 415 to a form post to POST /v1/auth/password, without parsing it', () => {
    const done = vi.fn();
    parser()({ url: '/v1/auth/password' }, 'email=attacker%40example.test&password=x', done);
    const [error, value] = done.mock.calls[0] as [Error, unknown];
    expect(error).toBeInstanceOf(UnsupportedMediaTypeException);
    expect((error as UnsupportedMediaTypeException).getStatus()).toBe(415);
    expect(value).toBeUndefined();
  });

  it('answers 415 on the other session-establishing routes too', () => {
    for (const url of ['/v1/auth/mfa', '/v1/public/sign-up', '/v1/invitations/registrations']) {
      const done = vi.fn();
      parser()({ url }, 'a=b', done);
      expect(done.mock.calls[0]?.[0]).toBeInstanceOf(UnsupportedMediaTypeException);
    }
  });

  it('still parses /oauth/token and /oauth/revoke (with a query string)', () => {
    const handler = parser();
    const done = vi.fn();
    handler({ url: '/oauth/token' }, 'grant_type=refresh_token&refresh_token=r', done);
    expect(done).toHaveBeenCalledWith(null, { grant_type: 'refresh_token', refresh_token: 'r' });
    const revoked = vi.fn();
    handler({ url: '/oauth/revoke?x=1' }, 'token=t', revoked);
    expect(revoked).toHaveBeenCalledWith(null, { token: 't' });
  });

  it('matches the path exactly', () => {
    expect(formBodyAllowed('/oauth/token')).toBe(true);
    expect(formBodyAllowed('/oauth/tokenx')).toBe(false);
    expect(formBodyAllowed('/v1/oauth/token')).toBe(false);
    expect(formBodyAllowed(undefined)).toBe(false);
  });
});
