import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { INBOX_SNOOZE_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { InboxSnoozeController } from './inbox-snooze.controller.js';
import { InboxSnoozeRepository } from './inbox-snooze.repository.js';
import { InboxSnoozeService } from './inbox-snooze.service.js';

/**
 * INBOX snooze wiring (IN-01/IN-02, x259).
 *
 * A service and the caller's-own snooze routes over `TENANT_DATABASE`. Kept in a module of its own —
 * file-disjoint from the rest of the inbox module — so this slice edits no file another inbox slice
 * appends to. It resolves a bundle's object through its own repository's tenant-scoped read (no
 * `WorkItemsService`/`ClientRequestsService` to construct, unlike the inbox list), so it depends on
 * nothing but the global tenant database. Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class InboxSnoozeModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INBOX_SNOOZE_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InboxSnoozeService(database, new InboxSnoozeRepository()),
    };

    return {
      module: InboxSnoozeModule,
      providers: [service],
      controllers: [InboxSnoozeController],
    };
  }
}
