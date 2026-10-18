import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { IntegrationCatalogService } from './catalog.service.js';
import {
  IntegrationDirectoryController,
  IntegrationDirectoryModule,
} from './directory.controller.js';
import { IntegrationConnectionsRepository } from './directory.repository.js';
import {
  ConnectionHealthController,
  ConnectionHealthModule,
} from './connection-health.controller.js';
import { WebhooksController, WebhooksModule } from './webhooks.controller.js';
import { WebhooksRepository } from './webhooks.repository.js';
import {
  WebhookDeliveriesController,
  WebhookDeliveriesModule,
} from './webhook-deliveries.controller.js';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository.js';

/**
 * The live 500 on `/automations/apps` and `/admin/automations/webhooks`: these controllers took
 * class-typed constructor parameters without `@Inject(...)`. `emitDecoratorMetadata` is off
 * (ADR-0003), so Nest injected `undefined` and the first repository call threw. Compiling the real
 * modules proves every dependency now resolves to a real instance.
 */
@Global()
@Module({ providers: [{ provide: TENANT_DATABASE, useValue: {} }], exports: [TENANT_DATABASE] })
class FakeGlobalsModule {}

async function controllerOf<T>(module: unknown, controller: new (...args: never[]) => T) {
  const ref = await Test.createTestingModule({
    imports: [FakeGlobalsModule, module as never],
  }).compile();
  const instance = ref.get(controller) as Record<string, unknown>;
  return { instance, close: () => ref.close() };
}

describe('automations integration modules resolve their dependencies', () => {
  it('directory controller gets the catalog and the connections repository', async () => {
    const { instance, close } = await controllerOf(
      IntegrationDirectoryModule.register(),
      IntegrationDirectoryController,
    );
    expect(instance['catalog']).toBeInstanceOf(IntegrationCatalogService);
    expect(instance['connections']).toBeInstanceOf(IntegrationConnectionsRepository);
    await close();
  });

  it('connection health controller gets its repository and service', async () => {
    const { instance, close } = await controllerOf(
      ConnectionHealthModule.register(),
      ConnectionHealthController,
    );
    expect(instance['connections']).toBeInstanceOf(IntegrationConnectionsRepository);
    expect(instance['health']).toBeDefined();
    await close();
  });

  it('webhooks and deliveries controllers get their repositories', async () => {
    const hooks = await controllerOf(WebhooksModule.register(), WebhooksController);
    expect(hooks.instance['webhooks']).toBeInstanceOf(WebhooksRepository);
    await hooks.close();
    const deliveries = await controllerOf(
      WebhookDeliveriesModule.register(),
      WebhookDeliveriesController,
    );
    expect(deliveries.instance['deliveries']).toBeInstanceOf(WebhookDeliveriesRepository);
    await deliveries.close();
  });
});
