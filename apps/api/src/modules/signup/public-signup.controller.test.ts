import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import { API_CONFIG, AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { SessionService } from '../identity/session.service.js';
import { PublicSignupController } from './public-signup.controller.js';
import { publicSignupModules, SIGNUP_MAX_PER_EMAIL } from './public-signup.module.js';
import type { PublicSignupService } from './public-signup.service.js';
import { SignupEmailTakenError } from './signup-accounts.repository.js';

const RESULT = {
  userId: '0199aa00-0000-7000-8000-0000000000b1',
  organizationId: '0199aa00-0000-7000-8000-0000000000b2',
  slug: 'nile-studio',
  organizationName: 'Nile Studio',
};

function harness(options: { admitSource?: boolean; error?: Error } = {}) {
  const signUp = vi.fn(async () => {
    if (options.error) throw options.error;
    return RESULT;
  });
  const start = vi.fn(async () => ({
    cookies: ['tm_access=a; HttpOnly'],
    csrfToken: 'csrf-1',
    expiresAt: new Date('2026-10-19T00:00:00.000Z'),
  }));
  const controller = new PublicSignupController(
    { signUp } as unknown as PublicSignupService,
    { start } as unknown as SessionService,
    () => options.admitSource ?? true,
    createFixedWindowLimiter({ windowMs: 60_000, max: SIGNUP_MAX_PER_EMAIL }),
  );
  const request = { headers: { 'user-agent': 'vitest' }, ip: '203.0.113.9' };
  ensureRequestState(request);
  return { controller, signUp, start, request, reply: { header: vi.fn() } };
}

const BODY = {
  email: 'mona@example.com',
  displayName: 'Mona',
  password: 'x',
  organizationName: 'Nile',
};

describe('PublicSignupController', () => {
  it('signs the new owner in and lands them on their new workspace', async () => {
    const h = harness();
    const view = await h.controller.signUp(BODY, h.request, h.reply);
    expect(view).toEqual({
      status: 'authenticated',
      csrfToken: 'csrf-1',
      expiresAt: '2026-10-19T00:00:00.000Z',
      organizationSlug: 'nile-studio',
      planId: null,
    });
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ userId: RESULT.userId }));
    expect(h.reply.header).toHaveBeenCalledWith('set-cookie', ['tm_access=a; HttpOnly']);
  });

  it('rate-limits per source before anything else', async () => {
    const h = harness({ admitSource: false });
    await expect(h.controller.signUp(BODY, h.request, h.reply)).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
    expect(h.signUp).not.toHaveBeenCalled();
  });

  it('rate-limits per email address, whatever the case or spacing', async () => {
    const h = harness({ error: new SignupEmailTakenError() });
    for (let i = 0; i < SIGNUP_MAX_PER_EMAIL; i += 1) {
      await h.controller.signUp(BODY, h.request, h.reply).catch(() => undefined);
    }
    await expect(
      h.controller.signUp({ ...BODY, email: ' MONA@example.com ' }, h.request, h.reply),
    ).rejects.toMatchObject({ status: 429 });
    expect(h.signUp).toHaveBeenCalledTimes(SIGNUP_MAX_PER_EMAIL);
  });

  it('refuses a filled honeypot with no detail and never reaches the service', async () => {
    const h = harness();
    const error = await h.controller
      .signUp({ ...BODY, website: 'http://spam.example' }, h.request, h.reply)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, details: undefined });
    expect(h.signUp).not.toHaveBeenCalled();
  });

  it('answers a duplicate email with 409 "sign in instead" and starts no session', async () => {
    const h = harness({ error: new SignupEmailTakenError() });
    await expect(h.controller.signUp(BODY, h.request, h.reply)).rejects.toMatchObject({
      status: 409,
      message: 'You already have an account. Sign in instead.',
      details: [{ field: 'email', message: 'account_exists' }],
    });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('NOCOOKIE: takes the utm values from the body, validated, and never from a cookie', async () => {
    const h = harness();
    const request = {
      ...h.request,
      headers: { ...h.request.headers, cookie: 'tm_signup_source=utm_source%3Dold_campaign' },
    };
    ensureRequestState(request);
    await h.controller.signUp(
      { ...BODY, attribution: { utm_source: 'facebook', utm_medium: 'bad value' } },
      request,
      h.reply,
    );
    expect(h.signUp).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), {
      utm_source: 'facebook',
    });
    await h.controller.signUp(BODY, request, h.reply);
    expect(h.signUp).toHaveBeenLastCalledWith(expect.anything(), expect.any(String), undefined);
  });
});

@Global()
@Module({
  providers: [
    { provide: TENANT_DATABASE, useValue: {} },
    { provide: AUDIT_SERVICE, useValue: {} },
    { provide: API_CONFIG, useValue: { cookieName: 'tm_session' } },
  ],
  exports: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
})
class FakeGlobalsModule {}

async function appWith(publicSignup: boolean | undefined): Promise<NestFastifyApplication> {
  @Module({
    imports: [
      FakeGlobalsModule,
      ...publicSignupModules(publicSignup === undefined ? {} : { publicSignup }),
    ],
  })
  class Root {}
  const app = await NestFactory.create<NestFastifyApplication>(Root, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('the PUBLIC_SIGNUP switch', () => {
  it.each([
    ['off', false],
    ['absent', undefined],
  ])(
    '%s: the sign-up routes do not exist (404)',
    async (_label, flag) => {
      const app = await appWith(flag);
      try {
        expect((await app.inject({ method: 'GET', url: '/v1/public/sign-up' })).statusCode).toBe(
          404,
        );
        expect(
          (await app.inject({ method: 'POST', url: '/v1/public/sign-up', payload: BODY }))
            .statusCode,
        ).toBe(404);
      } finally {
        await app.close();
      }
    },
    60_000,
  );

  it('on: the availability route answers', async () => {
    const app = await appWith(true);
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/public/sign-up' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ available: true });
    } finally {
      await app.close();
    }
  }, 60_000);
});
