import 'reflect-metadata';
import { Controller, Delete, Module, Patch, Put } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { corsOptions } from './cors.js';

/**
 * Review finding D20 (2026-09-06), held in place by a preflight rather than by a paragraph.
 *
 * The browser asks before a cross-origin `DELETE` with a `x-csrf-token` header; the answer
 * is what `@fastify/cors` writes from the options `main.ts` passes. This test registers the
 * same options on a minimal application and reads the answer. The routes exist only so that
 * the preflight is for something real; their handlers are never reached by an `OPTIONS`.
 *
 * The first case is the witness: on the options without `methods` it fails, because the
 * plugin's default is `GET,HEAD,POST`. The others say the same for `PUT` and `PATCH`, and
 * that a stranger origin is still not named — `methods` widens what the allowed origins may
 * do, not who is allowed.
 */

const WEB_ORIGIN = 'http://web.example.test';
const OTHER_ORIGIN = 'http://elsewhere.example.test';

@Controller('probe')
class ProbeController {
  @Delete('session')
  remove(): { readonly ok: true } {
    return { ok: true };
  }

  @Put('part')
  put(): { readonly ok: true } {
    return { ok: true };
  }

  @Patch('item')
  patch(): { readonly ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

function preflight(
  app: NestFastifyApplication,
  method: string,
  url: string,
  origin: string = WEB_ORIGIN,
) {
  return app.inject({
    method: 'OPTIONS',
    url,
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'content-type, x-csrf-token',
    },
  });
}

function allowedMethods(headers: Record<string, unknown>): readonly string[] {
  const value = headers['access-control-allow-methods'];
  return typeof value === 'string' ? value.split(',').map((m) => m.trim().toUpperCase()) : [];
}

describe('the CORS policy (D20)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
      logger: false,
    });
    app.enableCors(corsOptions([WEB_ORIGIN]));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('answers an allowed origin that a DELETE carrying x-csrf-token may proceed', async () => {
    const response = await preflight(app, 'DELETE', '/probe/session');

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(allowedMethods(response.headers)).toContain('DELETE');
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'x-csrf-token',
    );
  });

  it('accepts PUT and PATCH the same way', async () => {
    const put = await preflight(app, 'PUT', '/probe/part');
    const patch = await preflight(app, 'PATCH', '/probe/item');

    expect(allowedMethods(put.headers)).toContain('PUT');
    expect(allowedMethods(patch.headers)).toContain('PATCH');
  });

  it('lets an upload session be opened cross-origin with its Idempotency-Key', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/probe/upload-sessions',
      headers: {
        origin: WEB_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-csrf-token, idempotency-key',
      },
    });

    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'idempotency-key',
    );
  });

  it('still names no allowed origin to an origin that is not allowed', async () => {
    const response = await preflight(app, 'DELETE', '/probe/session', OTHER_ORIGIN);

    // `@fastify/cors` still writes the method list; the browser refuses on the absent
    // `Access-Control-Allow-Origin`, which is the gate that matters.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
