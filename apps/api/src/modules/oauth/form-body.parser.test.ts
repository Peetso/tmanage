import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { HttpAdapterHost } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { OAuthFormBodyParser } from './form-body.parser.js';

type Handler = (
  request: unknown,
  body: string,
  done: (error: Error | null, value?: unknown) => void,
) => void;

function hostWith(adapter: unknown): HttpAdapterHost {
  return { httpAdapter: adapter } as unknown as HttpAdapterHost;
}

function fakeFastify(present = false) {
  const handlers = new Map<string, Handler>();
  const instance = {
    hasContentTypeParser: vi.fn((type: string) => present || handlers.has(type)),
    addContentTypeParser: vi.fn((type: string, _options: unknown, handler: Handler) => {
      handlers.set(type, handler);
    }),
  };
  return { instance, handlers, adapter: { getInstance: () => instance } };
}

describe('OAuthFormBodyParser', () => {
  it('registers a urlencoded parser on the HTTP server and parses form bodies', () => {
    const { instance, handlers, adapter } = fakeFastify();
    new OAuthFormBodyParser(hostWith(adapter)).onApplicationBootstrap();
    expect(instance.addContentTypeParser).toHaveBeenCalledTimes(1);
    const handler = handlers.get('application/x-www-form-urlencoded');
    expect(handler).toBeDefined();
    const done = vi.fn();
    handler?.({}, 'grant_type=authorization_code&code=a%2Bb', done);
    expect(done).toHaveBeenCalledWith(null, { grant_type: 'authorization_code', code: 'a+b' });
  });

  it('is idempotent when the parser is already registered', () => {
    const { instance, adapter } = fakeFastify(true);
    new OAuthFormBodyParser(hostWith(adapter)).onApplicationBootstrap();
    expect(instance.addContentTypeParser).not.toHaveBeenCalled();
  });

  it.each([null, undefined])(
    'does nothing in a standalone application context (adapter %s)',
    (adapter) => {
      expect(() =>
        new OAuthFormBodyParser(hostWith(adapter)).onApplicationBootstrap(),
      ).not.toThrow();
    },
  );

  it('lets NestFactory.createApplicationContext boot a module that provides it (the --once jobs)', async () => {
    @Module({ providers: [OAuthFormBodyParser] })
    class StandaloneModule {}
    const app = await NestFactory.createApplicationContext(StandaloneModule, { logger: false });
    try {
      expect(app.get(OAuthFormBodyParser)).toBeInstanceOf(OAuthFormBodyParser);
    } finally {
      await app.close();
    }
  });
});
