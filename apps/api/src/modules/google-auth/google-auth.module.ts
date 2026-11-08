import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  INVITATION_MAILER,
  TENANT_DATABASE,
  WELCOME_MAILER,
} from '../../common/http/tokens.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvitationMailer } from '../../common/email/invitation-mailer.js';
import type { WelcomeMailer } from '../../common/email/welcome-email.js';
import type { AuditService } from '../audit/audit.service.js';
import { ClientMembershipsRepository } from '../clients/client-memberships.repository.js';
import { CredentialsRepository } from '../identity/credentials.repository.js';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { SessionService } from '../identity/session.service.js';
import { CONTACT_MAX_PER_WINDOW, CONTACT_WINDOW_MS } from '../public-site/contact.module.js';
import { createPublicSignupSwitch } from '../platform-admin/platform-settings.js';
import { PublicSignupService } from '../signup/public-signup.service.js';
import { InvitationsRepository } from '../tenancy/invitations.repository.js';
import { InvitationsService } from '../tenancy/invitations.service.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { ProvisioningService } from '../tenancy/provisioning.service.js';
import { GoogleAuthController, type GoogleAuthOptions } from './google-auth.controller.js';
import { GoogleAuthService } from './google-auth.service.js';
import { SsoEnforcedSignInPolicyGate } from '../sso/sso-enforcement.js';
import {
  GOOGLE_AUTH_ADMISSION,
  GOOGLE_AUTH_OPTIONS,
  GOOGLE_AUTH_SERVICE,
  GOOGLE_AUTH_SESSIONS,
  GOOGLE_TRANSPORT,
} from './google-auth.tokens.js';
import { createGoogleTransport, type GoogleTransport } from './google-oidc.js';

/**
 * "Continue with Google". `app.module.ts` registers it only when both `GOOGLE_CLIENT_ID` and
 * `GOOGLE_CLIENT_SECRET` are set (see {@link googleAuthModules}). Its collaborators are
 * constructed here, as `TenancyModule` constructs its own repositories, rather than importing
 * sibling dynamic modules a second time.
 */
@Module({})
export class GoogleAuthModule {
  static register(transport: GoogleTransport = createGoogleTransport()): DynamicModule {
    const options: Provider = {
      provide: GOOGLE_AUTH_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): GoogleAuthOptions => {
        if (!config.googleOAuth) throw new Error('GoogleAuthModule needs GOOGLE_CLIENT_ID/SECRET');
        return {
          clientId: config.googleOAuth.clientId,
          clientSecret: config.googleOAuth.clientSecret,
          webPublicUrl: config.webPublicUrl ?? '',
          sessionSecret: config.sessionSecret,
          secureCookies: config.secureCookies,
        };
      },
    };
    const service: Provider = {
      provide: GOOGLE_AUTH_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        API_CONFIG,
        { token: INVITATION_MAILER, optional: true },
        { token: WELCOME_MAILER, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        config: ApiConfig,
        invitationMail?: InvitationMailer,
        welcome?: WelcomeMailer,
      ) =>
        new GoogleAuthService({
          database,
          credentials: new CredentialsRepository(createSeedCipher(config.mfaSeedKeys)),
          invitations: new InvitationsService(
            database,
            new InvitationsRepository(),
            new MembershipsRepository(),
            new ClientMembershipsRepository(),
            audit,
            invitationMail,
          ),
          signup:
            config.publicSignup === true || (config.platformAdminEmails?.length ?? 0) > 0
              ? new PublicSignupService(
                  database,
                  new ProvisioningService(database, audit),
                  welcome ?? null,
                )
              : null,
          // Platform admin's switch (0206) decides at request time; `PUBLIC_SIGNUP` backs it.
          signupSwitch: createPublicSignupSwitch(database, {
            environmentDefault: config.publicSignup === true,
            databaseBacked: (config.platformAdminEmails?.length ?? 0) > 0,
          }),
          sessionSecret: config.sessionSecret,
          // R18-e (56-25): the organization sign-in policy, checked after Google proved the person.
          signInPolicy: new SsoEnforcedSignInPolicyGate(database),
        }),
    };
    const sessions: Provider = {
      provide: GOOGLE_AUTH_SESSIONS,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new SessionService(database, config),
    };
    const admission: Provider = {
      provide: GOOGLE_AUTH_ADMISSION,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        createFixedWindowLimiter({
          windowMs: config.contactWindowMs ?? CONTACT_WINDOW_MS,
          // Starting a Google attempt is cheap and a person may retry a few times.
          max: Math.max(10, (config.contactMaxPerWindow ?? CONTACT_MAX_PER_WINDOW) * 4),
        }),
    };
    return {
      module: GoogleAuthModule,
      providers: [
        options,
        service,
        sessions,
        admission,
        { provide: GOOGLE_TRANSPORT, useValue: transport },
      ],
      controllers: [GoogleAuthController],
    };
  }
}

/** Registered only when both Google credentials are configured; otherwise the routes 404. */
export function googleAuthModules(config: Pick<ApiConfig, 'googleOAuth'>): DynamicModule[] {
  return config.googleOAuth ? [GoogleAuthModule.register()] : [];
}
