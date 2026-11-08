import type { ApiClient } from './client';

/**
 * Work item recurrence (module 7, x257).
 *
 * This module wraps the work-item recurrence API: read the rule, set (upsert) it, clear it, and
 * compute the next occurrence in-app. Two response shapes are exported and paired in the contracts
 * gate — {@link WorkItemRecurrence} (the stored rule, Exact with the API's `WorkItemRecurrenceView`)
 * and {@link NextOccurrence} (the computed next occurrence, Exact with `NextOccurrenceView`).
 * `organizationId` is absent on both, as on every wire projection.
 */

/** The cadences a rule may use. Mirrors the API's `WORK_ITEM_RECURRENCE_FREQS`. */
export const WORK_ITEM_RECURRENCE_FREQS = ['daily', 'weekly', 'monthly'] as const;

export type WorkItemRecurrenceFreq = (typeof WORK_ITEM_RECURRENCE_FREQS)[number];

/** One occurrence of a rule (53-09): `key` is the scheduled date, `date` the date after the holiday policy. */
export interface WorkItemRecurrenceOccurrence {
  readonly key: string;
  readonly date: string;
}

/** One recurrence rule — paired Exact with the API's `WorkItemRecurrenceView`. */
export interface WorkItemRecurrence {
  readonly workItemId: string;
  readonly freq: string;
  readonly interval: number;
  readonly until: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  // ---- 53-09 recurring work v2 ----
  readonly rrule: string | null;
  readonly startsOn: string | null;
  readonly byWeekday: readonly string[];
  readonly byMonthDay: number | null;
  readonly bySetPos: number | null;
  readonly countLimit: number | null;
  readonly timeZone: string | null;
  readonly spawnMode: string;
  readonly spawnAheadDays: number;
  readonly holidayPolicy: string;
  readonly status: string;
  readonly ownerUserId: string | null;
  readonly lastOccurrenceKey: string | null;
  readonly nextDates: readonly WorkItemRecurrenceOccurrence[];
}

/** The computed next occurrence — paired Exact with the API's `NextOccurrenceView`. */
export interface NextOccurrence {
  readonly workItemId: string;
  readonly freq: string;
  readonly interval: number;
  readonly from: string;
  readonly nextAt: string | null;
  readonly exhausted: boolean;
  /** 53-09: the next occurrence as a civil date with its key (null when exhausted). */
  readonly next?: WorkItemRecurrenceOccurrence | null;
}

/** The fields a set sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface SetRecurrenceInput {
  readonly freq: WorkItemRecurrenceFreq;
  readonly interval: number;
  readonly until?: string | null;
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

function recurrencePath(organizationSlug: string, workItemId: string): string {
  return `${orgBase(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/recurrence`;
}

/** Read a work item's recurrence rule, or `null` if it does not recur. */
export async function getWorkItemRecurrence(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<WorkItemRecurrence | null> {
  const { data } = await client.request<{ recurrence: WorkItemRecurrence | null }>({
    path: recurrencePath(organizationSlug, workItemId),
  });
  return data.recurrence;
}

/** Set (upsert) a work item's recurrence rule. */
export async function setWorkItemRecurrence(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: SetRecurrenceInput,
): Promise<WorkItemRecurrence> {
  const { data } = await client.request<WorkItemRecurrence>({
    method: 'PUT',
    path: recurrencePath(organizationSlug, workItemId),
    body: input,
  });
  return data;
}

/** Clear a work item's recurrence rule. */
export async function clearWorkItemRecurrence(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: recurrencePath(organizationSlug, workItemId),
  });
}

/** Compute the next occurrence from the rule in-app; it creates no work item. */
export async function generateNextOccurrence(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<NextOccurrence> {
  const { data } = await client.request<NextOccurrence>({
    method: 'POST',
    path: `${recurrencePath(organizationSlug, workItemId)}/generate-next`,
  });
  return data;
}

// ---- r46 · 53-09 repeat rules editor ----

/** The v2 body the editor sends (request-side, suffix `Input`). */
export interface RecurrenceRuleInput {
  readonly freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  readonly interval: number;
  readonly byWeekday?: readonly string[];
  readonly byMonthDay?: number | null;
  readonly bySetPos?: number | null;
  readonly countLimit?: number | null;
  readonly endsOn?: string | null;
  readonly holidayPolicy: 'keep' | 'skip' | 'next_working_day';
  readonly spawnAheadDays: number;
  /** Only when editing a saved rule. */
  readonly scope?: 'all' | 'this_and_future';
}

/** The next dates of a rule (saved or draft). */
export interface RecurrencePreview {
  readonly workItemId: string;
  readonly occurrences: readonly WorkItemRecurrenceOccurrence[];
}

/** Save the v2 rule. */
export async function saveRecurrenceRule(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: RecurrenceRuleInput,
): Promise<WorkItemRecurrence> {
  const { data } = await client.request<WorkItemRecurrence>({
    method: 'PUT',
    path: recurrencePath(organizationSlug, workItemId),
    body: input,
  });
  return data;
}

/** The next 5 dates of an unsaved rule. Writes nothing. */
export async function previewRecurrenceDraft(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: RecurrenceRuleInput,
): Promise<RecurrencePreview> {
  const { data } = await client.request<RecurrencePreview>({
    method: 'POST',
    path: `${recurrencePath(organizationSlug, workItemId)}/preview`,
    body: input,
  });
  return data;
}

/** Pause or resume the series. */
export async function setRecurrencePaused(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  paused: boolean,
): Promise<WorkItemRecurrence> {
  const { data } = await client.request<WorkItemRecurrence>({
    method: 'POST',
    path: `${recurrencePath(organizationSlug, workItemId)}/${paused ? 'pause' : 'resume'}`,
  });
  return data;
}
