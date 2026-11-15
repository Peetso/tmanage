import type { ApiClient } from './client';

/**
 * A10a — the browser calls behind the finance screens part 1: the finance profile
 * (`/finance/profile`), rate cards (`/finance/rate-cards`), weekly timesheets (`/time/timesheets`)
 * and expenses (`/expenses`). Shapes mirror the API views; the API re-checks every permission.
 */

function org(slug: string): string {
  return `/v1/organizations/${encodeURIComponent(slug)}`;
}

export interface FinanceProfile {
  readonly country: string;
  readonly baseCurrency: string;
  readonly taxRegistrationNo: string | null;
  readonly taxScheme: string;
  readonly defaultTaxRateBp: number;
  readonly legalNameEn: string | null;
  readonly legalNameAr: string | null;
  readonly addressEn: string | null;
  readonly addressAr: string | null;
  readonly invoicePrefix: string;
  readonly paymentTermsDays: number;
  readonly vatRegistrationStatus: string;
  readonly saved: boolean;
  readonly version: number;
  readonly updatedAt: string | null;
}

export type FinanceProfilePatch = Partial<
  Pick<
    FinanceProfile,
    | 'country'
    | 'baseCurrency'
    | 'taxRegistrationNo'
    | 'taxScheme'
    | 'defaultTaxRateBp'
    | 'legalNameEn'
    | 'legalNameAr'
    | 'addressEn'
    | 'addressAr'
    | 'invoicePrefix'
    | 'paymentTermsDays'
    | 'vatRegistrationStatus'
  >
> & { readonly version?: number | undefined };

export async function readFinanceProfile(client: ApiClient, slug: string): Promise<FinanceProfile> {
  const { data } = await client.request<FinanceProfile>({ path: `${org(slug)}/finance/profile` });
  return data;
}

export async function saveFinanceProfile(
  client: ApiClient,
  slug: string,
  patch: FinanceProfilePatch,
): Promise<FinanceProfile> {
  const { data } = await client.request<FinanceProfile>({
    method: 'PUT',
    path: `${org(slug)}/finance/profile`,
    body: patch,
  });
  return data;
}

export interface RateCard {
  readonly id: string;
  readonly scope: string;
  readonly scopeId: string | null;
  readonly name: string;
  readonly currency: string;
  readonly archived: boolean;
  readonly updatedAt: string;
}

export interface RateEntry {
  readonly id: string;
  readonly rateCardId: string;
  readonly targetType: string;
  readonly targetKey: string | null;
  readonly hourlyMinor: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export async function listRateCards(client: ApiClient, slug: string): Promise<readonly RateCard[]> {
  const { data } = await client.request<{ rateCards: readonly RateCard[] }>({
    path: `${org(slug)}/finance/rate-cards`,
  });
  return data.rateCards;
}

export async function createRateCard(
  client: ApiClient,
  slug: string,
  input: { readonly name: string; readonly currency: string },
): Promise<RateCard> {
  const { data } = await client.request<RateCard>({
    method: 'POST',
    path: `${org(slug)}/finance/rate-cards`,
    body: { scope: 'org', name: input.name, currency: input.currency },
  });
  return data;
}

export async function listRateEntries(
  client: ApiClient,
  slug: string,
  rateCardId: string,
): Promise<readonly RateEntry[]> {
  const { data } = await client.request<{ entries: readonly RateEntry[] }>({
    path: `${org(slug)}/finance/rate-cards/${encodeURIComponent(rateCardId)}/entries`,
  });
  return data.entries;
}

export async function addRateEntry(
  client: ApiClient,
  slug: string,
  rateCardId: string,
  input: { readonly hourlyMinor: number; readonly effectiveFrom: string },
): Promise<RateEntry> {
  const { data } = await client.request<RateEntry>({
    method: 'POST',
    path: `${org(slug)}/finance/rate-cards/${encodeURIComponent(rateCardId)}/entries`,
    body: {
      targetType: 'default',
      hourlyMinor: input.hourlyMinor,
      effectiveFrom: input.effectiveFrom,
    },
  });
  return data;
}

export type TimesheetState = 'open' | 'submitted' | 'approved' | 'changes_requested';

export interface TimesheetEntry {
  readonly id: string;
  readonly title: string | null;
  readonly spentOn: string;
  readonly minutes: number;
  readonly billable: boolean;
  /** Marked for review: a long day or session of automatic time, or late time from a closed week. */
  readonly needsReview: boolean;
  /** `automatic` = reported by the person's own computer, not verified. */
  readonly source: 'manual' | 'timer' | 'automatic';
}

export interface TimesheetGroup {
  readonly projectId: string | null;
  readonly workItemId: string | null;
  readonly title: string | null;
  readonly minutes: number;
  readonly entries: readonly TimesheetEntry[];
}

export interface Timesheet {
  readonly id: string;
  readonly membershipId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly days: readonly string[];
  readonly state: TimesheetState;
  readonly version: number;
  readonly decisionNote: string | null;
  readonly totalMinutes: number;
  readonly billableMinutes: number;
  readonly locked: boolean;
  readonly groups: readonly TimesheetGroup[];
}

export interface TeamMemberWeek {
  readonly membershipId: string;
  readonly timesheetId: string | null;
  readonly state: TimesheetState;
  readonly totalMinutes: number;
  readonly billableMinutes: number;
}

export interface TeamWeek {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly members: readonly TeamMemberWeek[];
}

const weekQuery = (week: string | undefined) =>
  week === undefined ? '' : `?week=${encodeURIComponent(week)}`;

export async function readMyTimesheet(
  client: ApiClient,
  slug: string,
  week?: string,
): Promise<Timesheet> {
  const { data } = await client.request<Timesheet>({
    path: `${org(slug)}/time/timesheets/mine${weekQuery(week)}`,
  });
  return data;
}

export async function readTeamWeek(
  client: ApiClient,
  slug: string,
  week?: string,
): Promise<TeamWeek> {
  const { data } = await client.request<TeamWeek>({
    path: `${org(slug)}/time/timesheets${weekQuery(week)}`,
  });
  return data;
}

export async function decideTimesheet(
  client: ApiClient,
  slug: string,
  timesheetId: string,
  action: 'submit' | 'approve' | 'request-changes',
  note?: string,
): Promise<Timesheet> {
  const { data } = await client.request<Timesheet>({
    method: 'POST',
    path: `${org(slug)}/time/timesheets/${encodeURIComponent(timesheetId)}/${action}`,
    body: action === 'request-changes' ? { note } : {},
  });
  return data;
}

const entriesPath = (slug: string, timesheetId: string, action: string) =>
  `${org(slug)}/time/timesheets/${encodeURIComponent(timesheetId)}/entries/${action}`;

/** Live check B2: file unassigned entries of the week under one task the person can see. */
export async function moveTimesheetEntries(
  client: ApiClient,
  slug: string,
  timesheetId: string,
  input: { readonly entryIds: readonly string[]; readonly workItemId: string },
): Promise<Timesheet> {
  const { data } = await client.request<Timesheet>({
    method: 'POST',
    path: entriesPath(slug, timesheetId, 'move'),
    body: input,
  });
  return data;
}

/** Live check B2: move some minutes of one unassigned entry to a task (or keep them apart). */
export async function splitTimesheetEntry(
  client: ApiClient,
  slug: string,
  timesheetId: string,
  input: { readonly entryId: string; readonly minutes: number; readonly workItemId: string | null },
): Promise<Timesheet> {
  const { data } = await client.request<Timesheet>({
    method: 'POST',
    path: entriesPath(slug, timesheetId, 'split'),
    body: input,
  });
  return data;
}

/** Live check B2: delete unassigned entries; time on a task, locked or approved time stays. */
export async function deleteUnassignedEntries(
  client: ApiClient,
  slug: string,
  timesheetId: string,
  entryIds: readonly string[],
): Promise<Timesheet> {
  const { data } = await client.request<Timesheet>({
    method: 'POST',
    path: entriesPath(slug, timesheetId, 'delete'),
    body: { entryIds },
  });
  return data;
}

export interface Expense {
  readonly id: string;
  readonly projectId: string | null;
  readonly membershipId: string;
  readonly spentOn: string;
  readonly category: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly billable: boolean;
  readonly note: string | null;
  readonly state: string;
  readonly rejectedReason: string | null;
  readonly version: number;
}

export interface NewExpense {
  readonly spentOn: string;
  readonly category: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly billable: boolean;
  readonly note: string | null;
  readonly state: 'draft' | 'submitted';
}

export async function listExpenses(client: ApiClient, slug: string): Promise<readonly Expense[]> {
  const { data } = await client.request<{ expenses: readonly Expense[] }>({
    path: `${org(slug)}/expenses`,
  });
  return data.expenses;
}

export async function createExpense(
  client: ApiClient,
  slug: string,
  input: NewExpense,
): Promise<Expense> {
  const { data } = await client.request<Expense>({
    method: 'POST',
    path: `${org(slug)}/expenses`,
    body: input,
  });
  return data;
}

export async function decideExpense(
  client: ApiClient,
  slug: string,
  expenseId: string,
  action: 'submit' | 'approve' | 'reject',
  note?: string,
): Promise<Expense> {
  const { data } = await client.request<Expense>({
    method: 'POST',
    path: `${org(slug)}/expenses/${encodeURIComponent(expenseId)}/${action}`,
    body: note === undefined ? {} : { note },
  });
  return data;
}
