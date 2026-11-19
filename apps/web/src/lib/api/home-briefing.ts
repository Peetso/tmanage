import type { ApiClient } from './client';
import { ApiRequestError } from './errors';

/**
 * 62-A1b (B11) — the Home business briefing, `GET …/home/briefing`. The open signals of the last
 * hourly check that this person may act on, grouped; built from rows by the server, no model.
 *
 * The route answers 404 while the company's `business_briefing` flag is off, and to clients and
 * guests; this client turns that 404 into `null` ("no briefing here"), so the Home card and the
 * settings switch simply do not appear. Hand-written for the boundary reason `errors.ts` gives;
 * paired with the API view in the `e2e/contracts` shape check.
 */

export type BriefingAudience = 'company' | 'team' | 'none';

export type BriefingGroupKey =
  | 'projects_at_risk'
  | 'money_to_collect'
  | 'money_to_invoice'
  | 'people_overloaded'
  | 'waiting_on_clients'
  | 'over_budget'
  | 'stale_work'
  | 'unusual_expenses';

export type BriefingRule =
  | 'deadline_at_risk'
  | 'overloaded_person'
  | 'overdue_invoice'
  | 'project_over_budget'
  | 'stale_task'
  | 'unusual_expense'
  | 'approval_waiting_on_client'
  | 'approved_time_not_invoiced';

export type BriefingSubjectType =
  'work_item' | 'membership' | 'client_invoice' | 'project' | 'expense' | 'approval';

export interface BriefingAmount {
  readonly minor: number;
  readonly currency: string;
}

export interface BriefingLine {
  readonly signalId: string;
  readonly rule: BriefingRule;
  readonly subjectType: BriefingSubjectType;
  readonly subjectId: string;
  readonly projectId: string | null;
  /** The measured figure in the rule's unit (days, per cent, times the usual). */
  readonly measure: number;
  readonly threshold: number;
  readonly title: string | null;
  readonly context: string | null;
  readonly amount: BriefingAmount | null;
  readonly category: string | null;
  readonly deliverableId: string | null;
  /** Workspace-relative path of the record ("/work/…"). */
  readonly path: string;
}

export interface BriefingGroup {
  readonly group: BriefingGroupKey;
  readonly count: number;
  readonly lines: readonly BriefingLine[];
  readonly more: number;
  /** Workspace-relative path of the full list. */
  readonly path: string;
}

export interface HomeBriefing {
  readonly audience: BriefingAudience;
  /** ISO time of the last hourly check; null before the first. */
  readonly asOf: string | null;
  readonly groups: readonly BriefingGroup[];
}

/** The briefing, or `null` where there is none (flag off, client, guest). */
export async function getHomeBriefing(
  client: ApiClient,
  organizationSlug: string,
): Promise<HomeBriefing | null> {
  try {
    const { data } = await client.request<HomeBriefing>({
      path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/home/briefing`,
    });
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

/** The briefing is for this person: the server lists at least one group's worth of scope. */
export function hasBriefing(briefing: HomeBriefing | null | undefined): briefing is HomeBriefing {
  return briefing?.audience === 'company' || briefing?.audience === 'team';
}

/** The query key every reader of the briefing shares. */
export function homeBriefingQueryKey(organizationSlug: string): readonly unknown[] {
  return ['home', 'briefing', organizationSlug];
}
