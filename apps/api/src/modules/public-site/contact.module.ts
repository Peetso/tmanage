import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  CONTACT_ADMISSION,
  MARKETING_LEADS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ContactController } from './contact.controller.js';
import { MarketingLeadsRepository } from './contact.repository.js';

/**
 * x161. The public site's contact / lead intake wiring.
 *
 * A module of its own — one distinct file — rather than a shared `public-site.module.ts`, so this
 * slice stays file-disjoint from the sibling public-site slices (home, pricing, trust, status,
 * changelog): each registers here in `app.module.ts` rather than all editing one module file. The
 * repository writes on the identity (no-tenant) path, so it depends on `TENANT_DATABASE` and
 * nothing else; every provider carries an explicit token (ADR-0003).
 */
/**
 * Submissions admitted per address per window. A person filling the form in sends one or two; the
 * ceiling only has to stop a script filling `marketing_leads`. In process, like every limiter here:
 * a restart forgets the windows, which at worst admits a caller a few more.
 */
export const CONTACT_WINDOW_MS = 10 * 60 * 1_000;
export const CONTACT_MAX_PER_WINDOW = 5;

@Module({})
export class ContactModule {
  static register(
    limits: { readonly windowMs?: number; readonly max?: number } = {},
  ): DynamicModule {
    const repository: Provider = {
      provide: MARKETING_LEADS_REPOSITORY,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new MarketingLeadsRepository(database),
    };

    const admission: Provider = {
      provide: CONTACT_ADMISSION,
      useFactory: () =>
        createFixedWindowLimiter({
          windowMs: limits.windowMs ?? CONTACT_WINDOW_MS,
          max: limits.max ?? CONTACT_MAX_PER_WINDOW,
        }),
    };

    return {
      module: ContactModule,
      providers: [repository, admission],
      controllers: [ContactController],
    };
  }
}
