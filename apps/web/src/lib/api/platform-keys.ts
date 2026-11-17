import type { ApiClient } from './client';

/**
 * 56-02 · Platform admin → Settings → Keys (`/v1/platform/keys/*`). Status only: key ids, the
 * active key per purpose and the rotation ledger — the API never returns a key value, and there
 * is no route that accepts one. Mirrors `apps/api/.../settings/keys.service.ts`.
 */

export type KeyPurpose =
  | 'mfa'
  | 'storage_token'
  | 'calendar_token'
  | 'webhook_secret'
  | 'scim_token'
  | 'push_key'
  | 'integration_token'
  | 'zatca_key'
  | 'reporter_email'
  // R22-a: the organization secrets envelope (ZATCA signing certificate + key).
  | 'org_secret'
  // 56-03p: the connector token vault (connector credentials, Figma tokens).
  | 'connector_token'
  | 'figma_token';

export type KeyRotationStatus = 'queued' | 'running' | 'done' | 'failed';

export interface KeyRotationView {
  readonly id: string;
  readonly purpose: string;
  readonly fromKeyId: string | null;
  readonly toKeyId: string;
  readonly status: KeyRotationStatus;
  readonly rowsTotal: number;
  readonly rowsProcessed: number;
  readonly rowsFailed: number;
  readonly createdAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface KeyPurposeView {
  readonly purpose: KeyPurpose;
  readonly activeKeyId: string | null;
  readonly keysInRing: number;
  readonly rowsOnOldKey: number | null;
  readonly lastRotationAt: string | null;
  readonly rotatable: boolean;
  readonly rotation: KeyRotationView | null;
}

/** `GET /v1/platform/keys/status`. */
export interface PlatformKeysView {
  readonly enabled: boolean;
  readonly activeKeyId: string | null;
  readonly keyIds: readonly string[];
  readonly mfaFallback: boolean;
  readonly purposes: readonly KeyPurposeView[];
  readonly rotation: KeyRotationView | null;
  readonly lastRotationAt: string | null;
  readonly nextRotationDueAt: string | null;
  readonly sessions: { readonly keysInRing: number; readonly overlap: boolean };
}

export const PLATFORM_KEYS_QUERY_KEY = ['platform', 'keys'] as const;

export async function fetchPlatformKeys(client: ApiClient): Promise<PlatformKeysView> {
  const { data } = await client.request<PlatformKeysView>({ path: '/v1/platform/keys/status' });
  return data;
}

/** `POST /v1/platform/keys/rotate {purpose}` — queues the re-encrypt job (super admin). */
export async function rotatePlatformKey(
  client: ApiClient,
  purpose: KeyPurpose,
): Promise<PlatformKeysView> {
  const { data } = await client.request<PlatformKeysView>({
    method: 'POST',
    path: '/v1/platform/keys/rotate',
    body: { purpose },
  });
  return data;
}

/** Share of a rotation's rows walked, 0–100 (whole number). */
export function rotationPercent(rotation: KeyRotationView): number {
  if (rotation.rowsTotal <= 0) return rotation.status === 'done' ? 100 : 0;
  return Math.min(100, Math.floor((rotation.rowsProcessed / rotation.rowsTotal) * 100));
}
