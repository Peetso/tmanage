import type { ApiClient } from './client';

/**
 * Automations scheduled triggers (x167).
 *
 * Wraps the schedules API: list a tenant's schedules and record one for a workflow template. The one
 * exported response shape is {@link AutomationScheduleSummary}, paired Exact with the API's
 * `AutomationScheduleView` in the contracts gate. Firing a scheduled run is a background dispatcher
 * (Needs-Peter), out of this slice; this module only records and lists.
 */

/** The recurrence intervals, mirroring the API's `interval` union. */
export type ScheduleInterval = 'hourly' | 'daily' | 'weekly';

/**
 * A recurrence spec — paired structurally with the API's `ScheduleSpec`. `hour` is present for
 * `daily`/`weekly`, `dayOfWeek` (0 = Sunday … 6 = Saturday) for `weekly`. A nested component of
 * {@link AutomationScheduleSummary}, not a top-level response projection — its structure is asserted
 * through that pair, so it is a `type` alias (which the contracts gate treats as a nested shape).
 */
export type ScheduleSpec = {
  readonly interval: ScheduleInterval;
  readonly hour?: number;
  readonly dayOfWeek?: number;
};

/**
 * One schedule — paired Exact with the API's `AutomationScheduleView`. `organizationId` is absent on
 * both sides: the wire projection never echoes the tenant id.
 */
export interface AutomationScheduleSummary {
  readonly id: string;
  readonly templateId: string;
  readonly spec: ScheduleSpec;
  readonly nextRunAt: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

/** The fields a schedule request sends. Request-side, so the contracts gate does not enumerate it. */
export interface ScheduleTemplateInput {
  readonly interval: ScheduleInterval;
  readonly hour?: number;
  readonly dayOfWeek?: number;
  /** Whether the schedule is active. Set once, at creation; defaults to enabled server-side. */
  readonly enabled?: boolean;
}

function automationsBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations`;
}

/** List the tenant's schedules, soonest-due first. */
export async function listAutomationSchedules(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly AutomationScheduleSummary[]> {
  const { data } = await client.request<{ schedules: readonly AutomationScheduleSummary[] }>({
    path: `${automationsBase(organizationSlug)}/schedules`,
  });
  return data.schedules;
}

/** Record a schedule for a workflow template. */
export async function scheduleAutomationTemplate(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  input: ScheduleTemplateInput,
): Promise<AutomationScheduleSummary> {
  const { data } = await client.request<AutomationScheduleSummary>({
    method: 'POST',
    path: `${automationsBase(organizationSlug)}/templates/${encodeURIComponent(templateId)}/schedule`,
    body: input,
  });
  return data;
}
