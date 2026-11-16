import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { API_CONFIG } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { externalSignInProviders } from '../google-auth/google-auth.module.js';
import { MICROSOFT_SIGN_IN_PROVIDER } from '../google-auth/google-auth.service.js';
import {
  MicrosoftAuthController,
  MicrosoftAvailabilityController,
  type MicrosoftAuthOptions,
} from './microsoft-auth.controller.js';
import {
  MICROSOFT_AUTH_ADMISSION,
  MICROSOFT_AUTH_OPTIONS,
  MICROSOFT_AUTH_SERVICE,
  MICROSOFT_AUTH_SESSIONS,
  MICROSOFT_TRANSPORT,
} from './microsoft-auth.tokens.js';
import {
  createMicrosoftTransport,
  microsoftSignInConfigFrom,
  type MicrosoftSignInConfig,
  type MicrosoftTransport,
} from './microsoft-oidc.js';

/**
 * "Continue with Microsoft" (51-05). Same account rules as Google — the service, session starter
 * and limiter come from {@link externalSignInProviders} with the Microsoft provider id, so
 * linking is by a verified e-mail only, never into an unproved account, and a second factor is
 * still asked for.
 */
@Module({})
export class MicrosoftAuthModule {
  static register(
    config: MicrosoftSignInConfig,
    transport: MicrosoftTransport = createMicrosoftTransport(),
  ): DynamicModule {
    const options: Provider = {
      provide: MICROSOFT_AUTH_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (api: ApiConfig): MicrosoftAuthOptions => ({
        config,
        webPublicUrl: api.webPublicUrl ?? '',
        sessionSecret: api.sessionSecret,
        secureCookies: api.secureCookies,
      }),
    };
    return {
      module: MicrosoftAuthModule,
      providers: [
        options,
        ...externalSignInProviders(
          {
            service: MICROSOFT_AUTH_SERVICE,
            sessions: MICROSOFT_AUTH_SESSIONS,
            admission: MICROSOFT_AUTH_ADMISSION,
          },
          MICROSOFT_SIGN_IN_PROVIDER,
        ),
        { provide: MICROSOFT_TRANSPORT, useValue: transport },
      ],
      controllers: [MicrosoftAvailabilityController, MicrosoftAuthController],
    };
  }

  /** Without credentials: only `GET /v1/auth/microsoft`, answering `{ available: false }`. */
  static unavailable(): DynamicModule {
    return { module: MicrosoftAuthModule, controllers: [MicrosoftAvailabilityController] };
  }
}

/**
 * The full module when both Microsoft sign-in credentials are set; otherwise only the availability
 * probe, which says no (every other `/v1/auth/microsoft/*` route stays the router's 404).
 */
export function microsoftAuthModules(
  env: Readonly<Record<string, string | undefined>>,
): DynamicModule[] {
  const config = microsoftSignInConfigFrom(env);
  return [config ? MicrosoftAuthModule.register(config) : MicrosoftAuthModule.unavailable()];
}
