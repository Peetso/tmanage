import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { ObjectStore } from '@tmanage/storage';
import type { ApiConfig } from '../../common/http/api-config.js';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  ERASURE_DATABASE,
  MALWARE_SCANNER,
  OBJECT_STORE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import {
  AdminPrivacyController,
  MyPrivacyController,
  PRIVACY_SERVICE,
} from './privacy.controller.js';
import { providerObjectSources } from '../files/provider-object-sources.js';
import { ArchiveFileContents } from './privacy-archive-files.repository.js';
import { PrivacyArchiveBuilder } from './privacy-archive.repository.js';
import { CompanyErasure } from './privacy-erasure.repository.js';
import { PRIVACY_JOB, PrivacyJob, PrivacyPass, privacyJobEnabled } from './privacy-job.js';
import { PrivacyRepository } from './privacy.repository.js';
import { PrivacyService } from './privacy.service.js';
import { PRIVACY_STEP_UP, PrivacyStepUp } from './privacy-step-up.js';

/** The DI token of the pass the job runs (exported for a suite that drives one directly). */
export const PRIVACY_PASS = Symbol.for('tmanage.PrivacyPass');

/**
 * D5 (Figma F5) — data export and deletion requests. Registered from `app.module.ts`; depends only on
 * the global tenant and erasure databases, object store, malware scanner, audit service and outbox.
 * The job runs in this process only when it runs background work (`WORKER_INPROCESS=1` /
 * `PRIVACY_JOBS_INPROCESS=1`).
 */
@Module({})
export class PrivacyModule {
  static register(): DynamicModule {
    const pass: Provider = {
      provide: PRIVACY_PASS,
      inject: [
        TENANT_DATABASE,
        OBJECT_STORE,
        { token: MALWARE_SCANNER, optional: true },
        { token: AUDIT_SERVICE, optional: true },
        { token: OUTBOX_EVENTS_REPOSITORY, optional: true },
        { token: API_CONFIG, optional: true },
        ERASURE_DATABASE,
      ],
      useFactory: (
        database: TenantDatabase,
        store: ObjectStore,
        scanner: MalwareScanner | undefined,
        audit: AuditService | undefined,
        outbox: OutboxEventsRepository | undefined,
        config: ApiConfig | undefined,
        erasureDatabase: TenantDatabase,
      ) =>
        new PrivacyPass(
          database,
          store,
          scanner,
          audit,
          outbox,
          new PrivacyRepository(),
          // 57-13b: a version held in the company's Drive/OneDrive is exported from there.
          new PrivacyArchiveBuilder(
            database,
            new ArchiveFileContents(
              database,
              store,
              scanner,
              undefined,
              audit && config ? providerObjectSources(database, audit, config) : {},
            ),
          ),
          undefined,
          undefined,
          // H3: the company erasure deletes on its own credential (`tmanage_erasure`).
          new CompanyErasure(erasureDatabase, store),
        ),
    };
    const job: Provider = {
      provide: PRIVACY_JOB,
      inject: [PRIVACY_PASS],
      useFactory: (privacyPass: PrivacyPass) => new PrivacyJob(privacyPass, privacyJobEnabled()),
    };
    const service: Provider = {
      provide: PRIVACY_SERVICE,
      inject: [
        TENANT_DATABASE,
        OBJECT_STORE,
        { token: AUDIT_SERVICE, optional: true },
        { token: OUTBOX_EVENTS_REPOSITORY, optional: true },
        { token: MALWARE_SCANNER, optional: true },
        PRIVACY_JOB,
      ],
      useFactory: (
        database: TenantDatabase,
        store: ObjectStore,
        audit: AuditService | undefined,
        outbox: OutboxEventsRepository | undefined,
        scanner: MalwareScanner | undefined,
        privacyJob: PrivacyJob,
      ) => new PrivacyService(database, store, audit, outbox, scanner, privacyJob),
    };
    const stepUp: Provider = {
      provide: PRIVACY_STEP_UP,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => new PrivacyStepUp(config.sessionSecret),
    };
    return {
      module: PrivacyModule,
      providers: [pass, job, service, stepUp],
      exports: [service],
      controllers: [AdminPrivacyController, MyPrivacyController],
    };
  }
}
