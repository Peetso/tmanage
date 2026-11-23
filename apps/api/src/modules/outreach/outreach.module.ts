import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { Mailer } from '@tmanage/mail';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MAILER, TENANT_DATABASE } from '../../common/http/tokens.js';
import { PUBLIC_ABUSE_ASSESS } from '../public-abuse/public-abuse.guard.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import { PublicTrialInvitesController, TRIAL_INVITES } from './trial-invites.controller.js';
import { createTrialInvites } from './trial-invites.js';
import { PublicWalkthroughController, WALKTHROUGH_SERVICE } from './walkthrough.controller.js';
import { WalkthroughRepository } from './walkthrough.repository.js';
import { WalkthroughService } from './walkthrough.service.js';

/**
 * LANE-Q wiring: the public "Book a walkthrough" door and the trial-link pre-fill. Registered in `AppModule` beside the other
 * public doors, after `RateLimitsModule` (whose global `PUBLIC_ABUSE_ASSESS` it takes when
 * present). The global `MAILER` is optional: without one the request is stored and not mailed.
 */
function walkthroughProvider(): Provider {
  return {
    provide: WALKTHROUGH_SERVICE,
    inject: [
      TENANT_DATABASE,
      { token: MAILER, optional: true },
      { token: PUBLIC_ABUSE_ASSESS, optional: true },
    ],
    useFactory: (
      database: TenantDatabase,
      mailer: Mailer | null | undefined,
      assess: AssessPublicWrite | undefined,
    ) =>
      new WalkthroughService(
        new WalkthroughRepository(database),
        createFieldCipher(loadFieldCipherKeyring(process.env)),
        mailer ?? null,
        assess ?? null,
        undefined,
        undefined,
        // OUTREACH MANAGER: a booking from a campaign mail is credited to its recipient.
        createTrialInvites(database),
      ),
  };
}

@Module({})
export class OutreachPublicModule {
  static register(): DynamicModule {
    return {
      module: OutreachPublicModule,
      providers: [
        walkthroughProvider(),
        // LANE-Q part 2: the personal trial link's pre-fill.
        {
          provide: TRIAL_INVITES,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) => createTrialInvites(database),
        },
      ],
      controllers: [PublicWalkthroughController, PublicTrialInvitesController],
    };
  }
}
