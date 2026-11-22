import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { API_CONFIG, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { NETWORK_ACCESS_SERVICE } from '../identity/network-access/network-access.service.js';
import type { NetworkAccessService } from '../identity/network-access/network-access.service.js';
import { platformPeopleDirectory } from '../platform-admin/people/people-directory.js';
import { platformAdminCore } from '../platform-admin/platform-admin-core.module.js';
import {
  OrganizationSecurityEventsController,
  PlatformAlertRulesController,
  PlatformAttackTracksController,
  PlatformSecuritySignalsController,
  PlatformSourceLabelsController,
} from './security-signals.controller.js';
import { SourceLabelRepository } from './source-labels.repository.js';
import { SOURCE_LABELS_SERVICE, SourceLabelsService } from './source-labels.service.js';
import { SecuritySignalsRepository } from './security-signals.repository.js';
import { SECURITY_SIGNALS_SERVICE, SecuritySignalsService } from './security-signals.service.js';
import {
  SOURCE_FINDINGS_JOB,
  SourceFindingsJob,
  sourceFindingsJobEnabled,
} from './source-findings-job.js';
import { SourceFindingsRepository } from './source-findings.repository.js';
import { dailyPepper, hashSubject } from '../rate-limits/durable-rate-limiter.js';
import { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import { AttackTrackRepository } from './attack-tracks.repository.js';
import { ATTACK_TRACKS_SERVICE, AttackTracksService } from './attack-tracks.service.js';
import type { SourceHashers } from './attack-tracks.service.js';

/**
 * 56-23 wiring. The service is stateless, so the organization route and the platform area each
 * build their own: `SecuritySignalsModule` in `AppModule` (the org `admin/security/events` read)
 * and `PlatformSecuritySignalsModule` in `PLATFORM_AREA_MODULES`, so the alert rules and the
 * platform signal list exist only where the Platform admin does.
 */
function serviceProvider(): Provider {
  return {
    provide: SECURITY_SIGNALS_SERVICE,
    inject: [TENANT_DATABASE],
    useFactory: (database: TenantDatabase) =>
      new SecuritySignalsService(new SecuritySignalsRepository(database)),
  };
}

/**
 * SEC-ALERTS. The sign-in door's rules over `authentication_events`, evaluated where the read
 * already is (`source-findings.ts`); in `SecuritySignalsModule` only, so one copy runs per process.
 */
function sourceFindingsJobProvider(): Provider {
  return {
    provide: SOURCE_FINDINGS_JOB,
    inject: [TENANT_DATABASE],
    useFactory: (database: TenantDatabase) =>
      new SourceFindingsJob(new SourceFindingsRepository(database), sourceFindingsJobEnabled()),
  };
}

/** SEC-ALERTS item 6. Global: the platform area's attack tracker joins on these hashes. */
export const SOURCE_HASHERS = Symbol.for('tmanage.SourceHashers');

/**
 * The public-link and rate-limit hashes of an address, under the same pepper `AppModule` hands
 * `PublicLinksModule` and `RateLimitsModule`. Rate-limit keys re-key every UTC day, so a live
 * bucket is matched for today and yesterday only.
 */
export function sourceHashersFor(pepper: string | undefined): SourceHashers {
  if (pepper === undefined || pepper === '') return {};
  const links = new PublicLinkSecrets(pepper);
  return {
    publicLinkIpHash: (ip) => links.ipHash(ip),
    rateLimitSubjects: (ip, at) =>
      [0, 1].map((days) =>
        hashSubject(dailyPepper(pepper, new Date(at.getTime() - days * 86_400_000)), 'ip', ip),
      ),
  };
}

@Module({})
export class SecuritySignalsModule {
  static register(options: { readonly pepper?: string | undefined } = {}): DynamicModule {
    return {
      module: SecuritySignalsModule,
      global: true,
      providers: [
        serviceProvider(),
        sourceFindingsJobProvider(),
        { provide: SOURCE_HASHERS, useValue: sourceHashersFor(options.pepper) },
      ],
      exports: [SOURCE_HASHERS],
      controllers: [OrganizationSecurityEventsController],
    };
  }
}

function sourceLabelsProvider(): Provider {
  return {
    provide: SOURCE_LABELS_SERVICE,
    inject: [TENANT_DATABASE],
    useFactory: (database: TenantDatabase) =>
      new SourceLabelsService(new SourceLabelRepository(database)),
  };
}

/**
 * SEC-TRACKER: the tracker reads the door's standing through identity's published
 * `NETWORK_ACCESS_SERVICE` (global `NetworkAccessModule`), the labels through its own service, and
 * the targeted accounts' names through the platform people directory (AR-5: services, not
 * foreign repositories). The door service is required: a tracker that cannot say "blocked" must
 * fail to boot, not show every source as unblocked.
 */
function attackTracksProvider(): Provider {
  return {
    provide: ATTACK_TRACKS_SERVICE,
    inject: [
      TENANT_DATABASE,
      API_CONFIG,
      NETWORK_ACCESS_SERVICE,
      SOURCE_LABELS_SERVICE,
      { token: SOURCE_HASHERS, optional: true },
    ],
    useFactory: (
      database: TenantDatabase,
      config: ApiConfig,
      door: NetworkAccessService,
      labels: SourceLabelsService,
      hashers: SourceHashers | undefined,
    ) =>
      new AttackTracksService(new AttackTrackRepository(database), hashers ?? {}, {
        standing: door,
        labels,
        people: platformPeopleDirectory(database, config),
      }),
  };
}

@Module({})
export class PlatformSecuritySignalsModule {
  static register(): DynamicModule {
    return {
      module: PlatformSecuritySignalsModule,
      imports: [platformAdminCore()],
      providers: [serviceProvider(), sourceLabelsProvider(), attackTracksProvider()],
      controllers: [
        PlatformAlertRulesController,
        PlatformSecuritySignalsController,
        PlatformAttackTracksController,
        PlatformSourceLabelsController,
      ],
    };
  }
}
