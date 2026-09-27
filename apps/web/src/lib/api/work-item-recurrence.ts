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

/** One recurrence rule — paired Exact with the API's `WorkItemRecurrenceView`. */
export interface WorkItemRecurrence {
  readonly workItemId: string;
  readonly freq: string;
  readonly interval: number;
  readonly until: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The computed next occurrence — paired Exact with the API's `NextOccurrenceView`. */
export interface NextOccurrence {
  readonly workItemId: string;
  readonly freq: string;
  readonly interval: number;
  readonly from: string;
  readonly nextAt: string | null;
  readonly exhausted: boolean;
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
