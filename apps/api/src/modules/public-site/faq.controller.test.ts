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
  SESSION_SERVICE,
} from '../../common/http/tokens.js';
import type { AuthenticationEventRecorder } from '../../common/http/authentication-event-recorder.js';
import { FaqContentController } from './faq.controller.js';
import { PUBLIC_FAQ_SERVICE, FaqContentService } from './faq.service.js';

/**
 * Public & trust site (module 1) — the FAQ door, proved without a database (x186).
 *
 * The one property this route owns and nothing else does is that it is **public**: the same four
 * global guards every other controller sits behind — here the authentication guard and the
 * capability guard, the two that would otherwise 401/403 an anonymous, capability-less request —
 * are registered in this test's chain over fakes, and the `@Public()` class-level annotation is
 * what makes them stand aside. So the test proves:
 *
 * - **No session, no capability.** A request with no cookie, which any authed route turns into a
 *   401 and any capability-gated route into a 403, reaches the handler and gets a 200.
 * - **Stable grouped payload.** The body is the frozen content, grouped question/answer entries,
 *   identical across calls.
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
  controllers: [FaqContentController],
  providers: [
    { provide: PUBLIC_FAQ_SERVICE, useFactory: () => new FaqContentService() },
    { provide: SESSION_SERVICE, useValue: sessions },
    { provide: API_CONFIG, useValue: config },
    { provide: AUTHENTICATION_EVENT_RECORDER, useValue: eventRecorder },
    { provide: AUDIT_SERVICE, useValue: audit },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class TestModule {}

let app: NestFastifyApplication;
const FAQ_URL = '/v1/public/site/faq';

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

describe('GET /v1/public/site/faq', () => {
  it('answers 200 with a stable grouped payload to an anonymous, capability-less caller', async () => {
    const response = await app.inject({ method: 'GET', url: FAQ_URL });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.groups.length).toBeGreaterThan(0);
    for (const group of body.groups) {
      expect(group.id).toEqual(expect.any(String));
      expect(group.title).toEqual(expect.any(String));
      expect(Array.isArray(group.items)).toBe(true);
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item).toEqual({
          id: expect.any(String),
          question: expect.any(String),
          answer: expect.any(String),
        });
      }
    }
  });

  it('is deterministic — a second call returns the identical payload', async () => {
    const first = await app.inject({ method: 'GET', url: FAQ_URL });
    const second = await app.inject({ method: 'GET', url: FAQ_URL });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });
});

describe('the module exposes exactly the one read', () => {
  it('answers 404 for an unknown sub-path under /v1/public/site', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/public/site/unknown' });
    expect(response.statusCode).toBe(404);
  });
});
