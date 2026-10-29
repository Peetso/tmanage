import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import {
  AUDIT_SERVICE,
  MALWARE_SCANNER,
  OBJECT_STORE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../../common/http/tokens.js';
import type { MalwareScanner } from '../../../common/scan/malware-scanner.js';
import type { AuditService } from '../../audit/audit.service.js';
import { MeetingsService } from '../../calendar/meetings.service.js';
import { ConversationsRepository } from '../../conversations/conversations.repository.js';
import { DecisionsService } from '../../decisions/decisions.service.js';
import { DocumentsService } from '../../docs/documents.service.js';
import { FileAssetsRepository } from '../../files/file-assets.repository.js';
import { FileDownloadService } from '../../files/file-download.service.js';
import type { OutboxEventsRepository } from '../../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../../projects/projects.repository.js';
import { ClientRequestsRepository } from '../../requests/client-requests.repository.js';
import { MembershipResolver } from '../../tenancy/membership-resolver.repository.js';
import { PrincipalRepository } from '../../tenancy/principal.repository.js';
import { WorkItemsRepository } from '../../work/work-items.repository.js';
import { WorkItemsService } from '../../work/work-items.service.js';
import { PLATFORM_AUDIT_SERVICE, platformAdminCore } from '../platform-admin-core.module.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import { PlatformCommentsContentController } from './comments-content.controller.js';
import { ContentListsRepository } from './content-lists.repository.js';
import { PLATFORM_CONTENT_SERVICE } from './content-http.js';
import { PlatformContentService } from './content.service.js';
import type { ContentOrgPorts } from './content.service.js';
import { PlatformConversationsContentController } from './conversations-content.controller.js';
import { PlatformDecisionsContentController } from './decisions-content.controller.js';
import { PlatformDocsContentController } from './docs-content.controller.js';
import { PlatformFilesContentController } from './files-content.controller.js';
import { PlatformMeetingsContentController } from './meetings-content.controller.js';
import { PlatformRequestsContentController } from './requests-content.controller.js';
import { SupportContextResolver } from './support-context.js';
import { PlatformTrashController } from './trash.controller.js';
import { PlatformWorkContentController } from './work-content.controller.js';

/**
 * Platform admin · Content (platform-admin v2 · PA-08; listed in `platform-admin.areas.ts`).
 *
 * The organization modules' services and repositories are constructed here rather than imported,
 * the reasoning `ConversationsModule` records: those modules register through `.register()`, and a
 * stateless repository or a service over the same database costs nothing to own a second handle
 * on. The resolver and the principal repository are the ones `TenantContextGuard` uses.
 */
@Module({})
export class PlatformContentModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PLATFORM_CONTENT_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        PLATFORM_AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
        OBJECT_STORE,
        MALWARE_SCANNER,
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        platformAudit: PlatformAuditService,
        outbox: OutboxEventsRepository,
        store: ObjectStore,
        scanner: MalwareScanner,
      ) => {
        const workItemsRepository = new WorkItemsRepository();
        const org: ContentOrgPorts = {
          messages: new ConversationsRepository(),
          workItemsRepository,
          workItems: new WorkItemsService(
            database,
            workItemsRepository,
            audit,
            new ProjectsRepository(),
            outbox,
          ) as unknown as ContentOrgPorts['workItems'],
          documents: new DocumentsService(database),
          decisions: new DecisionsService(database),
          meetings: new MeetingsService(database),
          downloads: new FileDownloadService(
            database,
            new FileAssetsRepository(),
            new ProjectsRepository(),
            new ClientRequestsRepository(),
            store,
            audit,
            scanner,
          ),
        };
        return new PlatformContentService(
          database,
          new SupportContextResolver(
            database,
            new MembershipResolver(database),
            new PrincipalRepository(),
          ),
          new ContentListsRepository(),
          audit,
          platformAudit,
          org,
        );
      },
    };
    return {
      module: PlatformContentModule,
      imports: [platformAdminCore()],
      providers: [service],
      controllers: [
        PlatformConversationsContentController,
        PlatformWorkContentController,
        PlatformCommentsContentController,
        PlatformDocsContentController,
        PlatformDecisionsContentController,
        PlatformMeetingsContentController,
        PlatformFilesContentController,
        PlatformRequestsContentController,
        PlatformTrashController,
      ],
    };
  }
}
