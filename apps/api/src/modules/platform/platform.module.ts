import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { OUTBOX_EVENTS_REPOSITORY } from '../../common/http/tokens.js';
import { OutboxEventsRepository } from './outbox-events.repository.js';

/**
 * PLAT-004's API-side wiring — the outbox writer.
 *
 * **Global**, for the reason `AuditModule` is: the writer is cross-cutting in the same way
 * the audit trail is — three unrelated feature modules call it from inside their own
 * transactions, and a `register()`-per-importer shape would build one instance per importer.
 * The repository is stateless today, so two instances would *work*; a future singleton
 * concern (a metric, a sampler) would then silently exist several times, which is the trap
 * the audit module's doc names.
 *
 * No service class between the modules and the repository, unlike audit — the writer has no
 * policy to apply and no read model to narrow. `assertSafeAuditMetadata` has no analogue
 * here because the payload shapes are closed types; the gate is the compiler.
 */
@Global()
@Module({})
export class PlatformModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: OUTBOX_EVENTS_REPOSITORY,
      useFactory: () => new OutboxEventsRepository(),
    };

    return {
      module: PlatformModule,
      global: true,
      providers: [repository],
      exports: [repository],
    };
  }
}
