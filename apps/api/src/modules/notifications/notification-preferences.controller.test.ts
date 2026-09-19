import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import { HttpExceptionFilter } from '../../common/http/http-exception.filter.js';
import { SessionNotAuthenticatedError } from '../identity/session.service.js';
import type { AuthenticatedSession } from '../identity/session.service.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import {
  API_CONFIG,
  NOTIFICATION_PREFERENCES_SERVICE,
  SESSION_SERVICE,
} from '../../common/http/tokens.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import { NotificationPreferencesController } from './notification-preferences.controller.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from './notification-preferences.service.js';
import type { NotificationPreferencesService } from './notification-preferences.service.js';

/**
 * NOTIF-001 preferences — the route's authentication and own-only scoping, proved without a
 * database. Two properties the HTTP surface owns and nothing else does:
 *
 * - **Anonymous is refused.** The route carries no `@Public()`, so the globally-registered
 *   `SessionAuthGuard` turns a request with no session cookie into a 401 before the handler
 *   runs. The real guard is in the chain here, over a fake `SessionService`, so this asserts
 *   the wiring rather than a copy of it.
 * - **A caller reads their own row and no other.** The recipient is `principal.userId`, set
 *   by the authenticated pipeline, never a path or query value. The fake service records the
 *   id it was asked for; the test asserts it is the authenticated user's.
 *
 * The tenant and capability guards are not in this chain — this file is about the session
 * boundary. `getPreferences`/`updatePreferences` are faked; the database round-trip is
 * `notif-001-preferences.db.test.ts`.
 */

const AUTHENTICATED: AuthenticatedSession = {
  userId: '0199aa00-0000-7000-8000-000000000001',
  sessionId: '0199aa00-0000-7000-8000-0000000000a1',
};
const ORG_ID = '0199aa00-0000-7000-8000-000000000010';
const MEMBERSHIP_ID = '0199aa00-0000-7000-8000-000000000020';
const COOKIE_NAME = 'tm_at';

/** After authentication, stand in for `TenantContextGuard`: attach the caller's context. */
@Injectable()
class TestContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<object>();
    const state = ensureRequestState(request);
    if (!state.session) return true;
    state.tenant = createTenantContext({
      organizationId: ORG_ID,
      userId: state.session.userId,
      membershipId: MEMBERSHIP_ID,
      principalKind: 'internal',
      capabilities: [],
      policyVersion: '2026-09-19',
      correlationId: state.correlationId,
    });
    const principal: Principal = {
      userId: state.session.userId,
      organizationId: ORG_ID,
      kind: 'internal',
      role: 'owner',
      membershipId: MEMBERSHIP_ID,
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: true,
    };
    state.principal = principal;
    return true;
  }
}

const getPreferences = vi.fn();
const updatePreferences = vi.fn();
const service = { getPreferences, updatePreferences } as unknown as NotificationPreferencesService;

const sessions = {
  authenticate: vi.fn(async (input: { accessToken: string | undefined }) => {
    if (!input.accessToken) throw new SessionNotAuthenticatedError('no_cookie');
    return AUTHENTICATED;
  }),
};
const config = { cookieName: COOKIE_NAME } as unknown as ApiConfig;

@Module({
  controllers: [NotificationPreferencesController],
  providers: [
    { provide: NOTIFICATION_PREFERENCES_SERVICE, useValue: service },
    { provide: SESSION_SERVICE, useValue: sessions },
    { provide: API_CONFIG, useValue: config },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: TestContextGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class TestModule {}

let app: NestFastifyApplication;
const URL = `/v1/organizations/northstar/notification-preferences`;

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

describe('GET /v1/organizations/:orgSlug/notification-preferences', () => {
  it('refuses an anonymous caller with 401', async () => {
    const response = await app.inject({ method: 'GET', url: URL });
    expect(response.statusCode).toBe(401);
    expect(getPreferences).not.toHaveBeenCalled();
  });

  it('answers 200 with the authenticated caller’s own preferences', async () => {
    getPreferences.mockResolvedValueOnce(DEFAULT_NOTIFICATION_PREFERENCES);

    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie: `${COOKIE_NAME}=a-signed-token` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    // The recipient is the authenticated principal, never a value the request could name.
    const principal = getPreferences.mock.calls[0]![1] as Principal;
    expect(principal.userId).toBe(AUTHENTICATED.userId);
  });
});

describe('PUT /v1/organizations/:orgSlug/notification-preferences', () => {
  it('rejects a quiet-hours timezone that is not a real IANA zone (INBOX-001)', async () => {
    // A stored zone the delivery seam feeds to Intl must be real; a bogus one is a 400, not a
    // row that silently never triggers quiet hours.
    const response = await app.inject({
      method: 'PUT',
      url: URL,
      headers: { cookie: `${COOKIE_NAME}=a-signed-token` },
      payload: {
        inAppEnabled: true,
        emailEnabled: true,
        digestFrequency: 'off',
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        quietHoursTimezone: 'Mars/Phobos',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_failed');
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('rejects a zero-length quiet-hours window whose start equals its end (INBOX-001)', async () => {
    // A window with start == end describes no time; the delivery seam reads no window from it,
    // so it is the client's error rather than a row stored as if it meant something.
    const response = await app.inject({
      method: 'PUT',
      url: URL,
      headers: { cookie: `${COOKIE_NAME}=a-signed-token` },
      payload: {
        inAppEnabled: true,
        emailEnabled: true,
        digestFrequency: 'off',
        quietHoursStart: '22:00',
        quietHoursEnd: '22:00',
        quietHoursTimezone: 'Europe/London',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_failed');
    expect(updatePreferences).not.toHaveBeenCalled();
  });
});
