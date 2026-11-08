import type { ApiClient } from './client';

/**
 * R37 · `GET /v1/platform/connect-setup` — the platform owner's "Set it up" checklist data: which
 * providers have their keys on the server, and the public return addresses to register. Booleans
 * and public URLs only. Paired with the API's `ConnectSetupView`
 * (`apps/api/src/modules/platform-admin/connect-setup/connect-setup.ts`).
 */

export type ConnectSetupProvider = 'google' | 'microsoft';

export interface ConnectSetupView {
  readonly publicAddressSet: boolean;
  readonly providers: readonly {
    readonly provider: ConnectSetupProvider;
    readonly configured: boolean;
    readonly apps: readonly { readonly app: string; readonly configured: boolean }[];
    readonly redirectUrls: readonly string[];
  }[];
}

export async function getConnectSetup(client: ApiClient): Promise<ConnectSetupView> {
  const { data } = await client.request<ConnectSetupView>({ path: '/v1/platform/connect-setup' });
  return data;
}

/** The env-var names the owner adds in Hostinger, per provider (names, never values). */
export const SETUP_KEY_NAMES: Readonly<Record<ConnectSetupProvider, readonly string[]>> = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  microsoft: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
};

/** The console pages each checklist step opens. */
export const SETUP_LINKS = {
  google: {
    1: 'https://console.cloud.google.com/projectselector2/apis/credentials',
    2: 'https://console.cloud.google.com/auth/audience',
    4: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
    5: 'https://hpanel.hostinger.com/',
  },
  microsoft: {
    1: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade',
    4: 'https://hpanel.hostinger.com/',
  },
} as const satisfies Record<ConnectSetupProvider, Partial<Record<number, string>>>;
