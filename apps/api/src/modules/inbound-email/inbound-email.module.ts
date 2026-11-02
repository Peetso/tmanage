import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { InboundEmailRepository } from './inbound-email.repository.js';
import { InboundEmailService } from './inbound-email.service.js';
import { InboundEmailController } from './inbound-email.controller.js';

/**
 * R21-f (54-12 / 54-12a) — inbound e-mail wiring. The service is exported so the later poller (or a
 * JSON inbound webhook) can call `ingest()`; no poller is registered here.
 */
@Module({})
export class InboundEmailModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: InboundEmailService,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InboundEmailService(database, new InboundEmailRepository()),
    };
    return {
      module: InboundEmailModule,
      providers: [service],
      controllers: [InboundEmailController],
      exports: [InboundEmailService],
    };
  }
}
