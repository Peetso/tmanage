import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * 62-27 / 62-A1c (B12) — Settings → Alerts: the owner's choice per signal rule (on or off, the
 * threshold, who is told), read and saved through `…/insights/signal-settings`.
 *
 * The route answers 404 while the company's `business_briefing` flag is off; this client turns
 * that 404 into `null` ("no alert rules here") so the screen says so calmly. A non-owner gets the
 * server's 403 as an ordinary error. Units, limits and recipient choices come from the server (the
 * domain catalogue), never from this file: the screen draws what it is given.
 *
 * Hand-written for the boundary reason `errors.ts` gives; paired Exact with the API's
 * `SignalSettingsView` in the `e2e/contracts` shape check (B12 WIRING).
 */

export type SignalRuleKey =
  | 'deadline_at_risk'
  | 'overloaded_person'
  | 'overdue_invoice'
  | 'project_over_budget'
  | 'stale_task'
  | 'unusual_expense'
  | 'approval_waiting_on_client'
  | 'approved_time_not_invoiced';

export type SignalRecipient =
  | 'project_lead'
  | 'their_manager'
  | 'assignee'
  | 'owner'
  | 'project_lead_and_owner'
  | 'finance_team'
  | 'owner_and_finance_team';

export type SignalThresholdUnit =
  | 'days_before'
  | 'percent_of_capacity'
  | 'days_overdue'
  | 'percent_of_budget'
  | 'days'
  | 'times_usual';

/** One rule as the server answers it. Paired Exact with the API view. */
export interface SignalSettingView {
  readonly rule: SignalRuleKey;
  readonly enabled: boolean;
  readonly threshold: number;
  readonly recipient: SignalRecipient;
  readonly unit: SignalThresholdUnit;
  readonly min: number;
  readonly max: number;
  /** The recipient choices; a money rule has one, shown as fixed text, not a control. */
  readonly recipients: readonly SignalRecipient[];
  readonly money: boolean;
}

export interface SignalSettingsView {
  readonly rules: readonly SignalSettingView[];
}

/** One rule as the PUT takes it: the owner's three choices. */
export interface SignalSettingInput {
  readonly rule: SignalRuleKey;
  readonly enabled: boolean;
  readonly threshold: number;
  readonly recipient: SignalRecipient;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/insights/signal-settings`;
}

/** The rules, or `null` while the briefing is off for this company (the route's 404). */
export async function getSignalSettings(
  client: ApiClient,
  organizationSlug: string,
): Promise<SignalSettingsView | null> {
  try {
    const { data } = await client.request<SignalSettingsView>({ path: path(organizationSlug) });
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

/** Saves the listed rules whole (the server writes nothing on any bad field) and returns all. */
export async function updateSignalSettings(
  client: ApiClient,
  organizationSlug: string,
  rules: readonly SignalSettingInput[],
): Promise<SignalSettingsView> {
  const { data } = await client.request<SignalSettingsView>({
    method: 'PUT',
    path: path(organizationSlug),
    body: { rules },
  });
  return data;
}

export function signalSettingsQueryKey(organizationSlug: string): readonly unknown[] {
  return ['signal-settings', organizationSlug];
}
