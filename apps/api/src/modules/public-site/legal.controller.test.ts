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
import { LegalController } from './legal.controller.js';
import { PUBLIC_CONTENT_SERVICE, PublicContentService } from './public-content.service.js';

/**
 * Public & trust site (module 1) — the legal documents route, proved without a database (x188).
 *
 * Two properties this route owns, and nothing else does:
 *
 * - **It is public.** The same four global guards every other controller sits behind — here the
 *   authentication guard and the capability guard, the two that would 401/403 an anonymous,
 *   capability-less request — are registered in this chain over fakes, and the `@Public()` class
 *   annotation is what makes them stand aside. If that annotation were dropped, `SessionAuthGuard`
 *   would fail these tests rather than let a login wall ship on a public legal page.
 * - **`:doc` is a closed allowlist.** `terms` and `privacy` return their stable, code-defined
 *   payload with a frozen effective date; any other segment is a 404 — the arbitrary key never
 *   indexes the content map, and a caller cannot enumerate which keys exist.
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
  controllers: [LegalController],
  providers: [
    { provide: PUBLIC_CONTENT_SERVICE, useFactory: () => new PublicContentService() },
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
const url = (doc: string) => `/v1/public/site/legal/${doc}`;

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

describe('GET /v1/public/site/legal/:doc', () => {
  for (const doc of ['terms', 'privacy'] as const) {
    it(`answers 200 with the stable ${doc} payload to an anonymous, capability-less caller`, async () => {
      const response = await app.inject({ method: 'GET', url: url(doc) });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.doc).toBe(doc);
      expect(body.title).toEqual(expect.any(String));
      // A stable YYYY-MM-DD effective date, not a per-request `new Date()`.
      expect(body.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.intro).toEqual(expect.any(String));
      expect(Array.isArray(body.sections)).toBe(true);
      expect(body.sections.length).toBeGreaterThan(0);
      for (const section of body.sections) {
        expect(section).toEqual({
          id: expect.any(String),
          heading: expect.any(String),
          body: expect.any(String),
        });
      }
    });
  }

  it('is deterministic — a second call returns the identical payload', async () => {
    const first = await app.inject({ method: 'GET', url: url('terms') });
    const second = await app.inject({ method: 'GET', url: url('terms') });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('answers 404 for a doc key outside the two-value allowlist', async () => {
    for (const doc of ['home', 'cookies', 'TERMS', 'terms.json', '__proto__']) {
      const response = await app.inject({ method: 'GET', url: url(doc) });
      expect(response.statusCode).toBe(404);
    }
  });
});
