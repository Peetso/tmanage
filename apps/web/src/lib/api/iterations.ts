import type { ApiClient } from './client';

/**
 * 53-21 — a project's iterations (light sprints), over the API's iteration routes.
 *
 * Reads are `work.read`; create / edit / complete are `project.manage` on the project; moving work
 * in or out is `work.update` on every item. The screen never decides any of that: a refusal comes
 * back as the API's ordinary error and `describeError()` words it.
 */

export type IterationPhase = 'planned' | 'active' | 'ended' | 'completed';

export interface IterationSummary {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly goal: string | null;
  /** `YYYY-MM-DD`, in the project's calendar. */
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: string;
  readonly phase: IterationPhase;
  readonly completedAt: string | null;
  /** The concurrency token an edit presents as `expectedVersion`. */
  readonly version: number;
  readonly itemCount: number;
  readonly committedPoints: number;
  readonly donePoints: number;
  readonly daysLeft: number;
}

export interface IterationList {
  readonly projectId: string;
  readonly pointsEnabled: boolean;
  readonly iterations: readonly IterationSummary[];
}

export interface IterationItem {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly points: number | null;
}

export interface IterationDetail extends IterationSummary {
  readonly items: readonly IterationItem[];
}

export interface BurndownPoint {
  readonly date: string;
  readonly workingDay: boolean;
  /** Points in scope by the end of this day. */
  readonly scope: number;
  readonly scopeItems: number;
  readonly remainingPoints: number;
  readonly remainingItems: number;
}

export interface Burndown {
  readonly iterationId: string;
  readonly points: readonly BurndownPoint[];
}

export interface IterationInput {
  readonly name: string;
  readonly goal: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface CompleteResult {
  readonly iterationId: string;
  readonly moved: number;
  readonly left: number;
  readonly movedTo: string | null;
  readonly alreadyCompleted: boolean;
}

function orgPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

function iterationPath(organizationSlug: string, iterationId: string): string {
  return `${orgPath(organizationSlug)}/iterations/${encodeURIComponent(iterationId)}`;
}

export async function listIterations(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<IterationList> {
  const { data } = await client.request<IterationList>({
    path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/iterations`,
  });
  return data;
}

/** Create an iteration. Both dates or neither: without dates the API takes the next free slot. */
export async function createIteration(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: { readonly name: string; readonly goal: string | null } & Partial<
    Pick<IterationInput, 'startsOn' | 'endsOn'>
  >,
): Promise<IterationSummary> {
  const { data } = await client.request<IterationSummary>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/iterations`,
    body: input,
  });
  return data;
}

export async function getIteration(
  client: ApiClient,
  organizationSlug: string,
  iterationId: string,
): Promise<IterationDetail> {
  const { data } = await client.request<IterationDetail>({
    path: iterationPath(organizationSlug, iterationId),
  });
  return data;
}

export async function updateIteration(
  client: ApiClient,
  organizationSlug: string,
  iterationId: string,
  input: IterationInput & { readonly expectedVersion: number },
): Promise<IterationSummary> {
  const { data } = await client.request<IterationSummary>({
    method: 'PUT',
    path: iterationPath(organizationSlug, iterationId),
    body: input,
  });
  return data;
}

export async function getIterationBurndown(
  client: ApiClient,
  organizationSlug: string,
  iterationId: string,
): Promise<Burndown> {
  const { data } = await client.request<Burndown>({
    path: `${iterationPath(organizationSlug, iterationId)}/burndown`,
  });
  return data;
}

/** Move work into (`add`) or out of (`remove`) an iteration. */
export async function moveIterationItems(
  client: ApiClient,
  organizationSlug: string,
  iterationId: string,
  change: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
): Promise<{ readonly added: number; readonly removed: number }> {
  const { data } = await client.request<{ readonly added: number; readonly removed: number }>({
    method: 'POST',
    path: `${iterationPath(organizationSlug, iterationId)}/items`,
    body: change,
  });
  return data;
}

/** Close an iteration; unfinished work moves to `moveUnfinishedTo` or back to the backlog (null). */
export async function completeIteration(
  client: ApiClient,
  organizationSlug: string,
  iterationId: string,
  moveUnfinishedTo: string | null,
): Promise<CompleteResult> {
  const { data } = await client.request<CompleteResult>({
    method: 'POST',
    path: `${iterationPath(organizationSlug, iterationId)}/complete`,
    body: { moveUnfinishedTo },
  });
  return data;
}

export interface BurnUpBar {
  readonly date: string;
  /** Points (or items when the project has no points) in scope that day. */
  readonly scope: number;
  /** Done so far that day. */
  readonly done: number;
}

/**
 * The burn-up view of the API's burndown series: scope stays scope, done is scope minus what is
 * still open. Non-working days are dropped (nothing happens on them, and a flat bar reads as a
 * stall). Without points the item counts stand in, so a points-off project still sees progress.
 */
export function burnUpBars(points: readonly BurndownPoint[], usePoints: boolean): BurnUpBar[] {
  return points
    .filter((point) => point.workingDay)
    .map((point) => {
      const scope = usePoints ? point.scope : point.scopeItems;
      const remaining = usePoints ? point.remainingPoints : point.remainingItems;
      return { date: point.date, scope, done: Math.max(0, scope - remaining) };
    });
}
