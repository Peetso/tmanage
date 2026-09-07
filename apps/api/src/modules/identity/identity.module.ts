import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUTHENTICATION_SERVICE,
  SESSION_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SessionService } from './session.service.js';
import { DevelopmentSignInController, SessionController } from './session.controller.js';
import { AuthenticationService } from './authentication.service.js';
import { AuthenticationController, CredentialsController } from './authentication.controller.js';
import { CredentialsRepository } from './credentials.repository.js';
import { createSeedCipher } from './seed-cipher.js';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';

/**
 * ID-001's HTTP surface.
 *
 * The one decision worth reading here is the conditional controller list.
 * `DevelopmentSignInController` accepts a `userId` on trust, because ID-002 is not written and
 * nothing in this application yet authenticates a person. In production that route is **not
 * registered at all** rather than registered and refusing.
 *
 * The difference matters. A route that exists and returns 403 is one flipped condition away
 * from existing and returning a valid session, and the flip could come from a guard edit, a
 * misordered `APP_GUARD`, or an environment variable set wrongly during a deploy. A route that
 * was never added to the module has no code path at all: the router has no entry, and the 404
 * it returns is the same 404 as any other unknown path. `http-pipeline.db.test.ts` asserts it.
 */
@Module({})
export class IdentityModule {
  static register(): DynamicModule {
    const sessionService: Provider = {
      provide: SESSION_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new SessionService(database, config),
    };

    const authenticationService: Provider = {
      provide: AUTHENTICATION_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new AuthenticationService(
          database,
          {
            sessionSecret: config.sessionSecret,
            maxFailuresInWindow: config.maxFailuresInWindow,
            failureWindowSeconds: config.failureWindowSeconds,
            totpIssuer: config.totpIssuer,
            // No breached-password screen is wired. HIBP's range API is a network call to a
            // third party and nothing here has ever made it; `password.ts` still screens
            // against the bundled list, and the gap is recorded rather than filled with a
            // screen that would fail open.
            //
            // D08. The source-based bound in front of every password oracle in the service.
            // Built here, once, because the map *is* the state: one control per process, and
            // the bootstrap profile runs one API process (`50-BOOTSTRAP` §3, `main.ts`) — a
            // second one would count separately, and a restart forgets every window. The
            // config carries the window in seconds because that is what an operator writes in
            // an env file; the control counts in milliseconds, so it is converted here rather
            // than leaving two units loose in the codebase.
            abuseControl: createSignInAbuseControl({
              windowMs: config.authAbuseWindowSeconds * 1000,
              maxPerSource: config.authAbuseMaxPerSource,
              maxPerSourceAccount: config.authAbuseMaxPerSourceAccount,
              maxGlobal: config.authAbuseMaxGlobal,
            }),
          },
          // D07. The keyring was parsed and validated at boot by `packages/config`, so a
          // malformed `AUTH_MFA_SEED_KEYS` has already stopped the process by the time this
          // runs — the cipher is never built from a value nobody checked.
          new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
        ),
    };

    return {
      module: IdentityModule,
      providers: [sessionService, authenticationService],
      exports: [sessionService, authenticationService],
      controllers: [SessionController, AuthenticationController, CredentialsController],
    };
  }

  /** Everything in {@link register}, plus the development-only sign-in route. */
  static registerWithDevelopmentSignIn(): DynamicModule {
    const base = IdentityModule.register();
    return {
      ...base,
      controllers: [...(base.controllers ?? []), DevelopmentSignInController],
    };
  }
}
