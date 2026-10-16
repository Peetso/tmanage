import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import { CapabilityGuard } from '../../common/http/guards/capability.guard.js';
import { HttpExceptionFilter } from '../../common/http/http-exception.filter.js';
import { SessionNotAuthenticatedError } from '../identity/session.service.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  AUTHENTICATION_EVENT_RECORDER,
  PERSONAL_ACCESS_TOKEN_AUTHENTICATOR,
  SESSION_SERVICE,
} from '../../common/http/tokens.js';
import type { AuthenticationEventRecorder } from '../../common/http/authentication-event-recorder.js';
import { PublicContentController } from './public-content.controller.js';
import { PUBLIC_CONTENT_SERVICE, PublicContentService } from './public-content.service.js';

/**
 * Public & trust site (module 1) — the marketing home door, proved without a database.
 *
 * The one property this route owns and nothing else does is that it is **public**: the same four
 * global guards every other controller sits behind — here the authentication guard and the
 * capability guard, the two that would otherwise 401/403 an anonymous, capability-less request —
 * are registered in this test's chain over fakes, and the `@Public()` class annotation is what
 * makes them stand aside. So:
 *
 * - **No session.** A request with no cookie, which any authed route turns into a 401, reaches the
 *   handler and gets a 200. If the `@Public()` annotation were dropped, `SessionAuthGuard` would
 *   fail this test rather than let a regression ship a login wall on the landing page.
 * - **No capability.** The route declares no `@RequireCapability`, which on a tenant route is a 403
 *   from `CapabilityGuard`; here it is allowed, again because the route is public.
 * - **Deterministic payload.** The body is the frozen content, identical across calls.
 * - **Only the one read.** An unknown sub-path matches no handler and is a 404.
 */

const COOKIE_NAME = 'tm_at';

/** The real session service would reject a request with no access token; the fake mirrors that. */
const sessions = {
  authenticate: vi.fn(async (input: { accessToken: string | undefined }) => {
    if (!input.accessToken) throw new SessionNotAuthenticatedError('no_cookie');
    return { userId: 'u', sessionId: 's' };
  }),
};
const config = { cookieName: COOKIE_NAME } as unknown as ApiConfig;
const eventRecorder: AuthenticationEventRecorder = { recordGuardRefusal: () => {} };
/** `CapabilityGuard` only reaches the audit service on a refusal; a public route returns first. */
const audit = {} as unknown;

@Module({
  controllers: [PublicContentController],
  providers: [
    { provide: PUBLIC_CONTENT_SERVICE, useFactory: () => new PublicContentService() },
    { provide: SESSION_SERVICE, useValue: sessions },
    { provide: API_CONFIG, useValue: config },
    { provide: AUTHENTICATION_EVENT_RECORDER, useValue: eventRecorder },
    { provide: AUDIT_SERVICE, useValue: audit },
    // SessionAuthGuard reaches for a Bearer personal access token only when no cookie is present
    // (0202); this route is anonymous, so it is never called, but DI still needs it bound.
    { provide: PERSONAL_ACCESS_TOKEN_AUTHENTICATOR, useValue: { authenticate: vi.fn() } },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class TestModule {}

let app: NestFastifyApplication;
const HOME_URL = '/v1/public/site/home';

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

describe('GET /v1/public/site/home', () => {
  it('answers 200 with the stable payload to an anonymous, capability-less caller', async () => {
    const response = await app.inject({ method: 'GET', url: HOME_URL });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.hero.title).toEqual(expect.any(String));
    expect(body.hero.primaryCta).toEqual({ label: expect.any(String), href: '/sign-in' });
    expect(Array.isArray(body.features)).toBe(true);
    expect(body.features.length).toBeGreaterThan(0);
    for (const feature of body.features) {
      expect(feature).toEqual({ title: expect.any(String), body: expect.any(String) });
    }
  });

  it('is deterministic — a second call returns the identical payload', async () => {
    const first = await app.inject({ method: 'GET', url: HOME_URL });
    const second = await app.inject({ method: 'GET', url: HOME_URL });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('does not require CSRF for the read even though no session is present', async () => {
    // A safe method on a public route: the session guard did not run, so there is no session id to
    // bind a CSRF token to, and none is demanded.
    const response = await app.inject({ method: 'GET', url: HOME_URL });
    expect(response.statusCode).toBe(200);
  });
});

describe('the module exposes exactly the one read', () => {
  it('answers 404 for an unknown sub-path under /v1/public/site', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/public/site/pricing' });
    expect(response.statusCode).toBe(404);
  });
});
