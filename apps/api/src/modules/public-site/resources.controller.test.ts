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
import { PublicResourcesController } from './resources.controller.js';
import { PUBLIC_CONTENT_SERVICE, PublicContentService } from './public-content.service.js';

/**
 * Public & trust site (module 1) — the resources/guides doors (x187), proved without a database.
 *
 * The property these routes own and nothing else does is that they are **public**: the two global
 * guards that would otherwise 401/403 an anonymous, capability-less request — the authentication
 * guard and the capability guard — are registered in this chain over fakes, and the `@Public()`
 * class annotation is what makes them stand aside. So the acceptance:
 *
 * - **List returns a stable payload** to a caller with no session and no capability.
 * - **A known slug returns the article body**, again with no session/cap.
 * - **An unknown slug is a 404** — the slug is a membership test against the frozen catalog, so a
 *   value the catalog does not name (unknown or traversal-shaped) can only miss.
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
  controllers: [PublicResourcesController],
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
const LIST_URL = '/v1/public/site/resources';

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

describe('GET /v1/public/site/resources', () => {
  it('answers 200 with the stable index to an anonymous, capability-less caller', async () => {
    const response = await app.inject({ method: 'GET', url: LIST_URL });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.resources)).toBe(true);
    expect(body.resources.length).toBeGreaterThan(0);
    for (const entry of body.resources) {
      expect(entry).toEqual({
        slug: expect.any(String),
        title: expect.any(String),
        summary: expect.any(String),
        category: expect.any(String),
      });
      // The index omits the article body — that is fetched per slug.
      expect(entry).not.toHaveProperty('body');
    }
  });

  it('is deterministic — a second call returns the identical index', async () => {
    const first = await app.inject({ method: 'GET', url: LIST_URL });
    const second = await app.inject({ method: 'GET', url: LIST_URL });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });
});

describe('GET /v1/public/site/resources/:slug', () => {
  it('returns the article body for a known slug, with no session or capability', async () => {
    const list = (await app.inject({ method: 'GET', url: LIST_URL })).json();
    const slug = list.resources[0].slug as string;

    const response = await app.inject({ method: 'GET', url: `${LIST_URL}/${slug}` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.slug).toBe(slug);
    expect(body.body).toEqual(expect.any(String));
    expect(body.body.length).toBeGreaterThan(0);
    expect(body.title).toEqual(expect.any(String));
  });

  it('answers 404 for a slug the fixed catalog does not name', async () => {
    const response = await app.inject({ method: 'GET', url: `${LIST_URL}/no-such-guide` });
    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for a traversal-shaped slug rather than reaching any path', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${LIST_URL}/${encodeURIComponent('../../etc/passwd')}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
