import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { ObjectStore } from '@tmanage/storage';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  OBJECT_STORE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import {
  DEFAULT_FIGMA_SNAPSHOT_JOB_OPTIONS,
  FIGMA_SNAPSHOT_JOB,
  FigmaSnapshotJob,
  figmaSnapshotJobEnabled,
} from './figma-snapshot-job.js';
import {
  FIGMA_HTTP_OPTIONS,
  FigmaCallbackController,
  FigmaController,
  ProjectFigmaController,
  type FigmaHttpOptions,
} from './figma.controller.js';
import { figmaOAuthConfigFrom } from './figma-oauth.js';
import {
  DEFAULT_FIGMA_API_BASE,
  FigmaRestClient,
  fetchFigmaTransport,
  type FigmaTransport,
} from './figma.rest.js';
import { FIGMA_SERVICE, FigmaService } from './figma.service.js';
import { PortalFigmaController, PortalProjectFigmaController } from './portal-figma.controller.js';

/**
 * R4 slice 13 — Figma links. Always registered: a member connects with their own personal access
 * token, so nothing in the environment is required. `FIGMA_API_BASE` and `FIGMA_EMBED_ORIGIN`
 * override Figma's addresses (tests, a proxy). The frame-thread routes live in the files module
 * (they are the review service's), which builds its own `FigmaAccess` for the read decision.
 */
@Module({})
export class FigmaModule {
  static register(transport: FigmaTransport = fetchFigmaTransport): DynamicModule {
    const rest = new FigmaRestClient(
      transport,
      process.env['FIGMA_API_BASE'] ?? DEFAULT_FIGMA_API_BASE,
    );
    const job: Provider = {
      provide: FIGMA_SNAPSHOT_JOB,
      inject: [TENANT_DATABASE, OBJECT_STORE, API_CONFIG, AUDIT_SERVICE],
      useFactory: (
        database: TenantDatabase,
        store: ObjectStore,
        config: ApiConfig,
        audit: AuditService,
      ) =>
        new FigmaSnapshotJob(
          database,
          store,
          rest,
          createSeedCipher(config.mfaSeedKeys),
          audit,
          figmaSnapshotJobEnabled(),
          DEFAULT_FIGMA_SNAPSHOT_JOB_OPTIONS,
        ),
    };
    const service: Provider = {
      provide: FIGMA_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG, OBJECT_STORE, FIGMA_SNAPSHOT_JOB],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        config: ApiConfig,
        store: ObjectStore,
        snapshots: FigmaSnapshotJob,
      ) =>
        new FigmaService({
          database,
          audit,
          cipher: createSeedCipher(config.mfaSeedKeys),
          rest,
          store,
          snapshots,
          embedOrigin: process.env['FIGMA_EMBED_ORIGIN'] ?? 'https://embed.figma.com',
          // FIX4 item 6: one-click Connect when the server has a Figma app registered.
          oauth: figmaOAuthConfigFrom(process.env),
          apiPublicUrl: config.apiPublicUrl ?? config.webPublicUrl ?? '',
        }),
    };
    const httpOptions: Provider = {
      provide: FIGMA_HTTP_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): FigmaHttpOptions => ({
        sessionSecret: config.sessionSecret,
        secureCookies: config.secureCookies,
        webPublicUrl: config.webPublicUrl ?? '',
      }),
    };
    return {
      module: FigmaModule,
      providers: [job, service, httpOptions],
      exports: [service],
      controllers: [
        FigmaController,
        FigmaCallbackController,
        ProjectFigmaController,
        PortalFigmaController,
        PortalProjectFigmaController,
      ],
    };
  }
}
