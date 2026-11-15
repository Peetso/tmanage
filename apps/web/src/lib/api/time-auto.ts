import type { AutoTrackingPolicy, TrackingDeviceKind, TrackingDeviceReport } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * FIX-2026-11-10 — automatic time tracking and the team time view.
 *
 * - `/v1/organizations/:orgSlug/time/auto` — the caller's own tracking: read, settings (own switch
 *   and idle threshold), current task ("working on now"), heartbeat (`idleSeconds` only; the API
 *   stamps its own clock) and the owner's company policy (`PATCH policy`, owner only, audited).
 * - `/v1/organizations/:orgSlug/time/team` — everyone's tracked time, for holders of
 *   `time.view_team` (owner, admins, and people an admin authorized). The API checks it.
 *
 * Only state, times and the task travel: no screenshots, keystrokes, app names or URLs exist.
 */

export interface CurrentTask {
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
  /** Team time: a task the viewer may not see. No title or ids; the minutes still count. */
  readonly private?: boolean;
}

export interface AutoSession {
  readonly startedAt: string;
  readonly lastActiveAt: string;
  readonly live: boolean;
}

export interface AutoTrackingState {
  readonly policy: AutoTrackingPolicy;
  readonly enabled: boolean;
  readonly ownSwitch: boolean;
  /** The person's own threshold, read down to the owner's maximum. */
  readonly idleThresholdMinutes: number;
  /** The largest idle threshold the company owner allows (1..15). */
  readonly maxIdleMinutes: number;
  readonly currentTask: CurrentTask | null;
  readonly session: AutoSession | null;
  readonly manualTimerRunning: boolean;
  readonly visibleTo: 'admins_and_authorized';
  readonly serverNow: string;
}

export type TeamLiveState = 'tracking' | 'paused' | 'manual' | 'off';

export interface TeamPerson {
  readonly membershipId: string;
  readonly displayName: string;
  readonly live: TeamLiveState;
  readonly currentTask: CurrentTask | null;
  /** Filed time only; the open session is `inProgressMinutes`. */
  readonly todayMinutes: number;
  readonly weekMinutes: number;
  readonly rangeMinutes: number;
  readonly inProgressMinutes: number;
  /** A day over 12 hours, a session over 6 hours without a break, or late time in the range. */
  readonly needsReview: boolean;
  /** Item 17: where this person's tracking last ran; null = no device seen yet. */
  readonly device: { readonly kind: DeviceKind; readonly seenAt: string } | null;
}

/** Item 17: where automatic tracking runs (the desktop app, or a browser and its permission). */
export type DeviceKind = TrackingDeviceKind;

export interface TeamTime {
  readonly from: string;
  readonly to: string;
  readonly today: string;
  readonly week: { readonly periodStart: string; readonly periodEnd: string };
  /** The company time zone the days are counted in. */
  readonly timeZone: string;
  readonly policy: AutoTrackingPolicy;
  readonly people: readonly TeamPerson[];
  readonly totals: {
    readonly todayMinutes: number;
    readonly weekMinutes: number;
    readonly rangeMinutes: number;
    readonly inProgressMinutes: number;
  };
  readonly serverNow: string;
}

export type TeamSessionSource = 'manual' | 'timer' | 'automatic';

export interface TeamSession {
  readonly id: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly minutes: number;
  readonly source: TeamSessionSource;
  readonly workItemId: string | null;
  readonly workItemTitle: string | null;
  readonly projectId: string | null;
  readonly private: boolean;
  readonly needsReview: boolean;
  /** Automatic time filed late (its week was closed): the company day it was really tracked. */
  readonly lateFrom: string | null;
  readonly open: boolean;
}

export interface TeamDay {
  readonly membershipId: string;
  readonly displayName: string;
  readonly day: string;
  readonly timeZone: string;
  readonly sessions: readonly TeamSession[];
  /** Filed time only; the open session is `inProgressMinutes`. */
  readonly totalMinutes: number;
  readonly inProgressMinutes: number;
}

export interface TeamTimeQuery {
  readonly from?: string;
  readonly to?: string;
  readonly membershipId?: string;
  readonly projectId?: string;
}

const org = (organizationSlug: string): string =>
  `/v1/organizations/${encodeURIComponent(organizationSlug)}/time`;

export async function getAutoTracking(
  client: ApiClient,
  organizationSlug: string,
): Promise<AutoTrackingState> {
  const { data } = await client.request<AutoTrackingState>({
    path: `${org(organizationSlug)}/auto`,
  });
  return data;
}

export async function updateAutoTrackingSettings(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly enabled: boolean },
): Promise<AutoTrackingState> {
  const { data } = await client.request<AutoTrackingState>({
    method: 'PUT',
    path: `${org(organizationSlug)}/auto/settings`,
    body: input,
  });
  return data;
}

/** Set "working on now" (a work item), or clear it with `null`: time then stays unassigned. */
export async function setCurrentTask(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string | null,
): Promise<AutoTrackingState> {
  const { data } = await client.request<AutoTrackingState>({
    method: 'PUT',
    path: `${org(organizationSlug)}/auto/current-task`,
    body: { workItemId },
  });
  return data;
}

/** Item 17: tell the server where tracking runs for this person, so the owner can see it. */
export async function reportTrackingDevice(
  client: ApiClient,
  organizationSlug: string,
  kind: DeviceKind,
): Promise<void> {
  await client.request<unknown>({
    method: 'PUT',
    path: `${org(organizationSlug)}/auto/device`,
    body: { device: kind } satisfies TrackingDeviceReport,
  });
}

/** One heartbeat: how many seconds since the last input on the computer. Nothing else. */
export async function sendActivityHeartbeat(
  client: ApiClient,
  organizationSlug: string,
  idleSeconds: number,
): Promise<AutoTrackingState> {
  const { data } = await client.request<AutoTrackingState>({
    method: 'POST',
    path: `${org(organizationSlug)}/auto/heartbeat`,
    body: { idleSeconds },
  });
  return data;
}

export interface AutoTrackingPolicyChoice {
  readonly policy: AutoTrackingPolicy;
  readonly maxIdleMinutes: number;
}

/** Owner only — anyone else gets `403`. Audited by the API; "off" closes every open session. */
export async function updateAutoTrackingPolicy(
  client: ApiClient,
  organizationSlug: string,
  input: AutoTrackingPolicyChoice,
): Promise<AutoTrackingPolicyChoice> {
  const { data } = await client.request<AutoTrackingPolicyChoice>({
    method: 'PATCH',
    path: `${org(organizationSlug)}/auto/policy`,
    body: input,
  });
  return data;
}

export async function getTeamTime(
  client: ApiClient,
  organizationSlug: string,
  query: TeamTimeQuery,
): Promise<TeamTime> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const { data } = await client.request<TeamTime>({
    path: `${org(organizationSlug)}/team${suffix}`,
  });
  return data;
}

export async function getTeamDay(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  day: string,
): Promise<TeamDay> {
  const { data } = await client.request<TeamDay>({
    path: `${org(organizationSlug)}/team/${encodeURIComponent(membershipId)}/day?day=${encodeURIComponent(day)}`,
  });
  return data;
}
