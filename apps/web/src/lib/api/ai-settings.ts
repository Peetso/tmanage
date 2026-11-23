import type { ApiClient } from './client';

/**
 * Settings > AI (plan 62-17) — the owner's TManage AI settings: `GET` / `PATCH
 * /v1/organizations/:orgSlug/copilot/settings`. Owner only (403 `copilot.settings:owner`); absent
 * (404) for a workspace that is not on the test list. The server validates every field and audits
 * each change in the same transaction (IP-2, DA-11); the screen only collects the owner's choices.
 */

export type AiWriteScope = 'read' | 'read_write';
export type AiProvider = 'anthropic' | 'voyage';

export interface AiBlockedMemberEntry {
  readonly membershipId: string;
  readonly displayName: string;
  readonly blockedAt: string;
}

export interface AiShareChoice {
  readonly percent: number;
  readonly memberCredits: number;
}

export interface AiSettingsView {
  readonly aiEnabled: boolean;
  readonly writeScope: AiWriteScope;
  readonly runAtOnce: boolean;
  readonly fileReading: boolean;
  readonly memberSharePercent: number;
  readonly conversationRetentionDays: number;
  readonly blockedMembers: readonly AiBlockedMemberEntry[];
  readonly credits: {
    readonly workspaceCredits: number;
    readonly memberCredits: number;
    readonly shareChoices: readonly AiShareChoice[];
  };
  readonly providers: readonly AiProvider[];
  readonly updatedAt: string | null;
  /**
   * AI-TWO-WAYS: can TManage AI answer once on? `flag_off` = the workspace's "AI copilot" module is
   * off (Control Center › Modules); `no_key` = TManage has no AI key for this workspace's
   * group yet (nothing for the owner to do).
   */
  readonly readiness: AiReadiness;
}

export type AiReadiness = 'ready' | 'flag_off' | 'no_key';

/** The PATCH body: every field optional; the ids are this workspace's memberships (max 50 each). */
export interface AiSettingsPatch {
  readonly aiEnabled?: boolean;
  readonly writeScope?: AiWriteScope;
  readonly runAtOnce?: boolean;
  readonly fileReading?: boolean;
  readonly memberSharePercent?: number;
  readonly conversationRetentionDays?: number;
  readonly blockMembershipIds?: readonly string[];
  readonly allowMembershipIds?: readonly string[];
}

export const AI_RETENTION_MIN_DAYS = 1;
export const AI_RETENTION_MAX_DAYS = 365;

export const AI_SETTINGS_KEY = (slug: string) => ['ai-settings', slug] as const;

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/copilot/settings`;
}

export async function fetchAiSettings(
  client: ApiClient,
  organizationSlug: string,
): Promise<AiSettingsView> {
  const { data } = await client.request<AiSettingsView>({ path: path(organizationSlug) });
  return data;
}

export async function updateAiSettings(
  client: ApiClient,
  organizationSlug: string,
  patch: AiSettingsPatch,
): Promise<AiSettingsView> {
  const { data } = await client.request<AiSettingsView>({
    method: 'PATCH',
    path: path(organizationSlug),
    body: patch,
  });
  return data;
}
