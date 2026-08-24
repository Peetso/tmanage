import 'reflect-metadata';
import { Controller, Get, Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0003, held in place by a test rather than by a paragraph.
 *
 * This application registers every provider under an explicit token and puts `@Inject(TOKEN)`
 * on every injected constructor parameter. The reason is not style: vitest transforms
 * TypeScript with **esbuild**, which does not implement `emitDecoratorMetadata`.
 *
 * The second case below records how that fails, and it is worse than a wiring error. Without
 * `design:paramtypes` Nest does not see an unresolvable dependency — it sees a constructor
 * that takes **no arguments**. So the container reports nothing, `NestFactory.create()`
 * succeeds, `app.init()` succeeds, the route is registered, and the dependency is simply
 * `undefined`. The first request then throws inside the handler and the caller gets a bare
 * 500.
 *
 * That is the failure mode this convention exists to avoid: not a build that breaks, but an
 * application that starts cleanly, passes a health check, and 500s on every real request.
 *
 * Both directions are asserted. The positive alone would keep passing if someone enabled
 * `emitDecoratorMetadata` and started omitting tokens; the negative is what says the
 * constraint is still real.
 */

const GREETER = Symbol.for('tmanage.test.greeter');

@Injectable()
class Greeter {
  greet(): string {
    return 'ok';
  }
}

@Controller('di-probe')
class TokenisedController {
  constructor(@Inject(GREETER) private readonly greeter: Greeter) {}

  @Get()
  read(): { readonly value: string } {
    return { value: this.greeter.greet() };
  }
}

@Module({
  controllers: [TokenisedController],
  providers: [{ provide: GREETER, useClass: Greeter }],
})
class TokenisedModule {}

/** The same graph, relying on emitted parameter types instead of a token. */
@Controller('di-probe')
class MetadataController {
  constructor(private readonly greeter: Greeter) {}

  @Get()
  read(): { readonly value: string } {
    return { value: this.greeter.greet() };
  }
}

@Module({ controllers: [MetadataController], providers: [Greeter] })
class MetadataModule {}

describe('Nest dependency injection under esbuild', () => {
  it('resolves an explicitly-tokenised dependency and serves a request', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(
      TokenisedModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await app.inject({ method: 'GET', url: '/di-probe' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ value: 'ok' });

    await app.close();
  }, 60_000);

  it('silently starts, then fails at request time, when a dependency relies on emitted types', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(
      MetadataModule,
      new FastifyAdapter(),
      { logger: false },
    );

    // No error here, and that is the whole point. Nest sees a zero-argument constructor
    // rather than an unresolvable dependency, so nothing objects.
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await app.inject({ method: 'GET', url: '/di-probe' });
    expect(response.statusCode).toBe(500);

    // If this ever returns 200, `emitDecoratorMetadata` has been enabled or the transform has
    // changed. ADR-0003's premise would then need revisiting deliberately, rather than being
    // discovered when half the providers quietly stopped needing their tokens.
    await app.close();
  }, 60_000);
});
