import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { Mailer } from '@tmanage/mail';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { API_CONFIG, MAILER, TENANT_DATABASE } from '../../common/http/tokens.js';
import { AlertNotifier } from '../../common/observability/alerts.js';
import { platformSettingsReader } from '../billing/platform-settings-reader.js';
import { createMemoryBucketStore } from '../rate-limits/durable-rate-limiter.js';
import { RateLimitBucketsRepository } from '../rate-limits/rate-limit-buckets.repository.js';
import { AbuseBuckets } from './abuse-buckets.js';
import { PublicAbuseRepository, createMemoryAbuseStore } from './abuse-events.repository.js';
import {
  BLOCK_RULES_SERVICE,
  BlockRulesController,
  BlockRulesService,
} from './block-rules.controller.js';
import { matchingBlockRule } from './block-rules.repository.js';
import { ChallengeService } from './challenge.service.js';
import { FORM_PROOF_KEY, FormProofController } from './form-proof.controller.js';
import { formProofKey } from './form-proof.js';
import { PUBLIC_ABUSE_ASSESS, PublicAbuseGuard } from './public-abuse.guard.js';

/** `platform_settings` keys (Platform admin → Integrations writes them; 52-20 renders the widget). */
export const TURNSTILE_SITE_KEY_SETTING = 'turnstile_site_key';
export const TURNSTILE_SECRET_SETTING = 'turnstile_secret';

export interface PublicAbuseModuleOptions {
  /** 56-05's pepper source; also keys the value fingerprints and challenge hashes. */
  readonly secret: string;
  readonly limitScale?: number;
}

/**
 * The stored Turnstile secret, decrypted: a 56-02 `fc1.` envelope under the `integration_token`
 * purpose. A plaintext value is refused (it must never have been stored); a keyless host or a
 * missing row means "not configured", which the challenge service treats as an outage — the
 * e-mail code. The secret is never logged or returned; reading it masked is Platform admin's.
 */
export function turnstileSecretLoader(): () => Promise<string | null> {
  const cipher = createFieldCipher(loadFieldCipherKeyring(process.env));
  return async () => {
    const stored = await platformSettingsReader()?.get(TURNSTILE_SECRET_SETTING);
    if (typeof stored !== 'string' || stored === '' || !cipher.isEnvelope(stored)) return null;
    try {
      return cipher.decrypt(stored, {
        purpose: 'integration_token',
        ownerId: `platform:${TURNSTILE_SECRET_SETTING}`,
      });
    } catch {
      return null;
    }
  };
}

/**
 * 52-21 wiring. Imported by `RateLimitsModule` (so `app.module.ts` is untouched) and global, so
 * the public doors (sign-up, contact, 52-20's intake) inject {@link PUBLIC_ABUSE_ASSESS} by token.
 */
@Module({})
export class PublicAbuseModule {
  static register(options: PublicAbuseModuleOptions): DynamicModule {
    const key: Provider = {
      provide: FORM_PROOF_KEY,
      inject: [{ token: API_CONFIG, optional: true }],
      useFactory: (config: ApiConfig | undefined) =>
        formProofKey(config?.sessionSecret ?? options.secret),
    };
    const assess: Provider = {
      provide: PUBLIC_ABUSE_ASSESS,
      inject: [
        FORM_PROOF_KEY,
        { token: TENANT_DATABASE, optional: true },
        { token: MAILER, optional: true },
        { token: API_CONFIG, optional: true },
      ],
      useFactory: (
        proofKey: Buffer,
        database: TenantDatabase | null | undefined,
        mailer: Mailer | null | undefined,
        config: ApiConfig | undefined,
      ) => {
        const store = database ? new PublicAbuseRepository(database) : createMemoryAbuseStore();
        const buckets = new AbuseBuckets({
          // 56-05's table under new bucket names; the in-process store without a database.
          store: database ? new RateLimitBucketsRepository(database) : createMemoryBucketStore(),
          secret: options.secret,
          ...(options.limitScale === undefined ? {} : { limitScale: options.limitScale }),
        });
        const challenges = new ChallengeService({
          store,
          buckets,
          secret: options.secret,
          mailer: mailer ?? null,
          alerts: new AlertNotifier({
            recipients: config?.alertEmails ?? [],
            mailer: mailer ?? null,
          }),
          turnstileSecret: turnstileSecretLoader(),
        });
        return new PublicAbuseGuard({
          buckets,
          events: store,
          challenges,
          blockRules: database ? matchingBlockRule(database) : null,
          formProofKey: proofKey,
          secret: options.secret,
        }).assess;
      },
    };
    const blockRules: Provider = {
      provide: BLOCK_RULES_SERVICE,
      inject: [{ token: TENANT_DATABASE, optional: true }],
      useFactory: (database: TenantDatabase | null | undefined) =>
        new BlockRulesService(database ?? null),
    };
    return {
      module: PublicAbuseModule,
      global: true,
      providers: [key, assess, blockRules],
      controllers: [FormProofController, BlockRulesController],
      exports: [PUBLIC_ABUSE_ASSESS, FORM_PROOF_KEY],
    };
  }
}
