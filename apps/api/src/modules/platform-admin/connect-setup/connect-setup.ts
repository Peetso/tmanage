import { GOOGLE_CALLBACK_PATH } from '../../google-auth/google-oidc.js';
import {
  GCAL_CALLBACK_PATH,
  calendarConfigFrom,
} from '../../google-calendar/google-calendar.google.js';
import { DRIVE_CALLBACK_PATH, driveConfigFrom } from '../../google-drive/google-drive.google.js';
import { MSCAL_CALLBACK_PATH } from '../../microsoft-calendar/microsoft-calendar.graph.js';
import { ONEDRIVE_CALLBACK_PATH, oneDriveConfigFrom } from '../../onedrive/onedrive.graph.js';

/**
 * R37 · "Connect apps simply" — what the platform owner's "Set it up" checklist needs to know.
 *
 * Read only, and never a secret: for each provider (Google, Microsoft) whether its keys are set on
 * the server, which of its apps are therefore available, and the public return addresses the owner
 * pastes into the provider's console (`API_PUBLIC_URL` + each module's `*_CALLBACK_PATH`). Client
 * ids, secrets and tokens never leave the server: the view holds booleans and public URLs only.
 */

export type ConnectProviderId = 'google' | 'microsoft';

export type ConnectAppId =
  'google_sign_in' | 'google_calendar' | 'google_drive' | 'microsoft_calendar' | 'onedrive';

export interface ConnectAppSetupView {
  readonly app: ConnectAppId;
  readonly configured: boolean;
}

export interface ConnectProviderSetupView {
  readonly provider: ConnectProviderId;
  /** Every app of this provider has its keys. */
  readonly configured: boolean;
  readonly apps: readonly ConnectAppSetupView[];
  /** The exact return addresses to register with the provider, one per app. */
  readonly redirectUrls: readonly string[];
}

export interface ConnectSetupView {
  /** `API_PUBLIC_URL` (or `WEB_PUBLIC_URL`) is set, so the return addresses are real. */
  readonly publicAddressSet: boolean;
  readonly providers: readonly ConnectProviderSetupView[];
}

type Env = Readonly<Record<string, string | undefined>>;

function present(env: Env, name: string): boolean {
  return (env[name]?.trim() ?? '') !== '';
}

/** The public origin the providers send people back to, without a trailing slash. */
export function publicOrigin(env: Env): string | null {
  const raw = env['API_PUBLIC_URL']?.trim() || env['WEB_PUBLIC_URL']?.trim() || '';
  return raw === '' ? null : raw.replace(/\/+$/, '');
}

/** The checklist's data. Pure: the caller passes the environment. */
export function connectSetupView(env: Env): ConnectSetupView {
  const origin = publicOrigin(env);
  const url = (path: string) => `${origin ?? ''}${path}`;
  const google: ConnectAppSetupView[] = [
    {
      app: 'google_sign_in',
      configured: present(env, 'GOOGLE_CLIENT_ID') && present(env, 'GOOGLE_CLIENT_SECRET'),
    },
    { app: 'google_calendar', configured: calendarConfigFrom(env) !== null },
    { app: 'google_drive', configured: driveConfigFrom(env) !== null },
  ];
  const microsoftConfigured = oneDriveConfigFrom(env) !== null;
  const microsoft: ConnectAppSetupView[] = [
    { app: 'microsoft_calendar', configured: microsoftConfigured },
    { app: 'onedrive', configured: microsoftConfigured },
  ];
  return {
    publicAddressSet: origin !== null,
    providers: [
      {
        provider: 'google',
        configured: google.every((entry) => entry.configured),
        apps: google,
        redirectUrls: [GOOGLE_CALLBACK_PATH, GCAL_CALLBACK_PATH, DRIVE_CALLBACK_PATH].map(url),
      },
      {
        provider: 'microsoft',
        configured: microsoftConfigured,
        apps: microsoft,
        redirectUrls: [ONEDRIVE_CALLBACK_PATH, MSCAL_CALLBACK_PATH].map(url),
      },
    ],
  };
}

/**
 * The OAuth error codes a provider may put on its redirect (`?error=…`) that the Connected apps
 * screen explains in plain words. Anything else is dropped, so the fragment never carries free
 * text from the provider.
 */
export const PROVIDER_ERROR_REASONS = [
  'access_denied',
  'invalid_request',
  'invalid_client',
  'unauthorized_client',
  'redirect_uri_mismatch',
  'org_internal',
  'admin_policy_enforced',
  'invalid_scope',
  'consent_required',
  'interaction_required',
  'server_error',
  'temporarily_unavailable',
] as const;

export type ProviderErrorReason = (typeof PROVIDER_ERROR_REASONS)[number];

/** The provider's `error` query value when it is one we explain, else `null`. */
export function providerErrorReason(error: unknown): ProviderErrorReason | null {
  return typeof error === 'string' && (PROVIDER_ERROR_REASONS as readonly string[]).includes(error)
    ? (error as ProviderErrorReason)
    : null;
}
