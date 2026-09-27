import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { INBOX_FLAG_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { InboxFlagController } from './inbox-flag.controller.js';
import { InboxFlagRepository } from './inbox-flag.repository.js';
import { InboxFlagService } from './inbox-flag.service.js';

/**
 * INBOX-001 IN-01 "Important inbox" wiring (x260).
 *
 * A service and the caller's-own flag routes over `TENANT_DATABASE`. Kept in a module of its own —
 * file-disjoint from the rest of the Inbox module — so this slice edits no file another Inbox slice
 * appends to. The ownership gate reads the caller's notification rows directly through the repository
 * (a recipient-scoped existence check), so unlike `InboxModule` it constructs no `WorkItemsService` or
 * `ClientRequestsService`: a flag needs to know only that the bundle is the caller's, which their own
 * notification rows already record. Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class InboxFlagModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INBOX_FLAG_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InboxFlagService(database, new InboxFlagRepository()),
    };

    return {
      module: InboxFlagModule,
      providers: [service],
      controllers: [InboxFlagController],
    };
  }
}
