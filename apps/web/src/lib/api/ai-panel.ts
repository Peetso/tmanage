import type { ApiClient } from './client';

/**
 * The AI panel's own API (AI panel with two tabs, Fable 5.2 rulings 2026-11-23). Mirrors
 * `apps/api/src/modules/ai-panel/ai-panel.service.ts` (`AiPanelView`),
 * `apps/api/src/modules/ai-panel/ai-activity.service.ts` (`AiActivityItemView`,
 * `AiActivityPageView`) and `apps/api/src/modules/oauth/grants.service.ts` (`AiPanelAppView`).
 *
 * - `GET …/ai/panel`: tabs or no tabs, the "not on" state (owner or member version), the member's
 *   connected apps and the "Your AI" count, in one request. Every flag is the server's decision
 *   (AR-9): never default one on the screen.
 * - `GET …/ai/activity?cursor=`: what the member's own connected AI read or changed, newest first,
 *   20 a page. A name appears only for an item the member can open now; otherwise the row says only
 *   its kind ("Read a task").
 *
 * Both need a cookie session.
 */

/** Why TManage AI does not answer this member (`TmanageAiUnavailableReason` in the API). */
export type TmanageAiUnavailableReason =
  'not_on_test_list' | 'flag_off' | 'ai_off' | 'no_key' | 'member_blocked';

/** Why the member's own AI apps are off. */
export type OwnAiOffReason = 'platform_off' | 'workspace_off';

/** The AI apps recognised by their verified client id. Any other app: the neutral mark. */
export type KnownAiApp = 'claude' | 'chatgpt' | 'cursor';

export type AiActivityVerb = 'read' | 'changed' | 'waiting';

/** One of the member's own connected AI apps. `app` and `openUrl` never come from the name. */
export interface AiPanelApp {
  readonly grantId: string;
  readonly clientName: string;
  readonly verified: boolean;
  readonly app: KnownAiApp | null;
  /** Where "Open" goes (new tab, `rel="noopener noreferrer"`); `null` = no "Open". */
  readonly openUrl: string | null;
  readonly connectedAt: string;
  readonly lastUsedAt: string | null;
}

export interface AiPanelView {
  readonly tmanageAi: {
    readonly inPlan: boolean;
    readonly enabled: boolean;
    readonly available: boolean;
    readonly reason: TmanageAiUnavailableReason | null;
    /** May open Settings > AI and turn TManage AI on (the workspace owner). */
    readonly canManage: boolean;
  };
  readonly ownAi: {
    readonly enabled: boolean;
    readonly reason: OwnAiOffReason | null;
    /** May flip the workspace's "Allow AI apps" switch. */
    readonly canManage: boolean;
  };
  readonly apps: readonly AiPanelApp[];
  /** The "Your AI" tab count: the member's own waiting approvals. */
  readonly pendingApprovals: number;
}

export interface AiActivityItem {
  readonly id: string;
  readonly at: string;
  readonly verb: AiActivityVerb;
  /** The call did not complete: nothing was read or changed. */
  readonly failed: boolean;
  /** `null` for a personal access token or an app no longer known here. */
  readonly clientName: string | null;
  readonly app: KnownAiApp | null;
  /** The item kind (`work_item`, `project`, …); `null` for a lookup with no subject. */
  readonly kind: string | null;
  /** How many items a bulk read returned ("Read 4 tasks"); `null` for one item. */
  readonly count: number | null;
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
}

export interface AiActivityPage {
  readonly items: readonly AiActivityItem[];
  /** Pass back as `cursor` for the next (older) page; `null` on the last page. */
  readonly nextCursor: string | null;
}

function aiBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/ai`;
}

export async function getAiPanel(
  client: ApiClient,
  organizationSlug: string,
): Promise<AiPanelView> {
  const { data } = await client.request<AiPanelView>({ path: `${aiBase(organizationSlug)}/panel` });
  return data;
}

export async function listAiActivity(
  client: ApiClient,
  organizationSlug: string,
  cursor: string | null = null,
): Promise<AiActivityPage> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  const { data } = await client.request<AiActivityPage>({
    path: `${aiBase(organizationSlug)}/activity${query}`,
  });
  return data;
}

/** The query keys the panel shares, so the tab count and the panel ask once. */
export function aiPanelKey(organizationSlug: string): readonly string[] {
  return ['ai-panel', organizationSlug];
}

export function aiActivityKey(organizationSlug: string): readonly string[] {
  return ['ai-activity', organizationSlug];
}
