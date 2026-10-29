import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Mailer } from '@tmanage/mail';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { MAILER, TENANT_DATABASE } from '../../../common/http/tokens.js';
import { AlertNotifier, parseAlertEmails } from '../../../common/observability/alerts.js';
import { platformAdminCore } from '../platform-admin-core.module.js';
import { CapacitySampler, parseInodeExclude } from './capacity-sampler.js';
import { CAPACITY_STORE, PlatformCapacityController } from './capacity.controller.js';
import { CapacityRepository } from './capacity.repository.js';
import type { CapacityStore } from './capacity.repository.js';

/**
 * 56-32 · host capacity — a platform area module (listed in `platform-admin.areas.ts`).
 *
 * Reads `process.env` the way `EmailDeliverabilityModule` does, so no config-schema change is
 * needed: `TMANAGE_APP_ROOT` (default: cwd), `TMANAGE_INODE_EXCLUDE`, `ALERT_EMAILS`, and
 * `TMANAGE_CAPACITY_SAMPLER_OFF=1` to keep the timer from starting. The sampler never starts under
 * a test runner (`NODE_ENV=test`); tests drive `tick()` themselves.
 *
 * The alerts go through an `AlertNotifier` of this module's own (the root module's notifier is
 * not exported to feature modules), on the app's mailer; off when `ALERT_EMAILS` is unset.
 */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

export function samplerAutoStart(): boolean {
  return env('TMANAGE_CAPACITY_SAMPLER_OFF') !== '1' && process.env['NODE_ENV'] !== 'test';
}

@Module({})
export class PlatformCapacityModule {
  static register(): DynamicModule {
    return {
      module: PlatformCapacityModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: CAPACITY_STORE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) => new CapacityRepository(database),
        },
        {
          provide: CapacitySampler,
          inject: [CAPACITY_STORE, { token: MAILER, optional: true }],
          useFactory: (store: CapacityStore, mailer: Mailer | null | undefined) => {
            const appRoot = env('TMANAGE_APP_ROOT') ?? process.cwd();
            return new CapacitySampler({
              store,
              alerts: new AlertNotifier({
                recipients: parseAlertEmails(env('ALERT_EMAILS')),
                mailer: mailer ?? null,
              }),
              appRoot,
              inodeExclude: parseInodeExclude(env('TMANAGE_INODE_EXCLUDE'), appRoot),
              autoStart: samplerAutoStart(),
            });
          },
        },
      ],
      controllers: [PlatformCapacityController],
    };
  }
}
