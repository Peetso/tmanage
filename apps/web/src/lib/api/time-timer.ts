import type { TimeRoundingChoice } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * 52-01 — the caller's own running timer, `/v1/organizations/:orgSlug/time/timer`.
 *
 * One running timer per member: `start` answers 409 (`timer_running`) when one is already running
 * unless `force` is set, in which case the API stops the old one into a time entry first. `stop`
 * turns the running timer into a time entry and returns it; an optional `note` replaces the
 * timer's own note. The route gate is `work.read`; client principals are refused by the API.
 * Every read carries the company's rounding step, so the Stop dialog announces what is saved.
 */

export interface RunningTimer {
  readonly id: string;
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly note: string | null;
  readonly billable: boolean;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  /** Seconds since `startedAt`, as of the server's `serverNow`. */
  readonly elapsedSeconds: number;
}

export interface TimerState {
  readonly timer: RunningTimer | null;
  readonly serverNow: string;
  /** The step a stopped timer is rounded up to, in minutes (`0`/`1` = exact minutes). */
  readonly roundingMinutes: number;
}

export interface StoppedTimeEntry {
  readonly id: string;
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly minutes: number;
  readonly spentOn: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly billable: boolean;
  readonly source: string;
  readonly needsReview: boolean;
  readonly note: string | null;
}

export interface StartTimerInput {
  readonly workItemId?: string;
  readonly projectId?: string;
  readonly note?: string;
  /** Stop a timer that is already running (saving its time) and start this one. */
  readonly force?: boolean;
}

const base = (organizationSlug: string): string =>
  `/v1/organizations/${encodeURIComponent(organizationSlug)}/time/timer`;

export async function getTimer(client: ApiClient, organizationSlug: string): Promise<TimerState> {
  const { data } = await client.request<TimerState>({ path: base(organizationSlug) });
  return data;
}

export async function startTimer(
  client: ApiClient,
  organizationSlug: string,
  input: StartTimerInput,
): Promise<TimerState> {
  const { data } = await client.request<TimerState>({
    method: 'POST',
    path: `${base(organizationSlug)}/start`,
    body: input,
  });
  return data;
}

/** Owner only — anyone else gets `403`. Audited by the API. Automatic time is never rounded. */
export async function updateTimeRounding(
  client: ApiClient,
  organizationSlug: string,
  roundingMinutes: TimeRoundingChoice,
): Promise<{ readonly roundingMinutes: number }> {
  const { data } = await client.request<{ readonly roundingMinutes: number }>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/time/rounding`,
    body: { roundingMinutes },
  });
  return data;
}

/** UX test T-P1-1: throw the running timer away; nothing is saved (audited on the server). */
export async function discardTimer(client: ApiClient, organizationSlug: string): Promise<void> {
  await client.request<unknown>({ method: 'POST', path: `${base(organizationSlug)}/discard` });
}

export async function stopTimer(
  client: ApiClient,
  organizationSlug: string,
  /** `minutes`: what the person chose to save (1 up to the rounded amount); omitted = rounded. */
  input: { readonly note?: string; readonly minutes?: number },
): Promise<StoppedTimeEntry> {
  const { data } = await client.request<StoppedTimeEntry>({
    method: 'POST',
    path: `${base(organizationSlug)}/stop`,
    body: input,
  });
  return data;
}
