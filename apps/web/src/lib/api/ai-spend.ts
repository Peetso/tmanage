import type { ApiClient } from './client';

/**
 * Platform admin › AI spend (plan 62-19) — the web side of two API slices:
 *
 * - 62-08 `/v1/platform/settings/ai-budget` (`platform.settings.edit`): the pool caps under the
 *   server's ceiling, the Sonnet switch ("detailed answers"), pause / resume, and the reserve
 *   release (needs a step-up confirmed in the last 15 minutes: 403 `reauthentication_required`).
 * - 62-07 `/v1/platform/ai/test-list` (`platform.settings.edit`): the test list, its pool class,
 *   pack grants (with an `Idempotency-Key`) and declines.
 *
 * Money is micro-USD in views and whole cents in bodies, exactly as the API speaks. Every write
 * carries the admin's typed reason; the server writes the platform log (DA-11).
 */

export type AiAdminPool = 'customers' | 'testing' | 'reserve';
export type AiPool = AiAdminPool | 'packs';
export type AiPoolClass = 'customers' | 'testing';

export const AI_ADMIN_POOLS: readonly AiAdminPool[] = ['customers', 'testing', 'reserve'];
export const MICRO_USD_PER_CENT = 10_000;

export interface AiBudgetPoolView {
  readonly pool: AiPool;
  readonly capMicroUsd: number;
  readonly settledMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly remainingMicroUsd: number;
  readonly paused: boolean;
  readonly pausedReason: string | null;
}

export interface AiBudgetView {
  readonly ceilingMicroUsd: number;
  readonly capsMicroUsd: Readonly<Record<AiAdminPool, number>>;
  readonly sonnetEnabled: boolean;
  readonly paused: boolean;
  readonly periodStart: string;
  readonly pools: readonly AiBudgetPoolView[];
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface AiTestListEntryView {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly listedAt: string | null;
  readonly poolClass: AiPoolClass;
}

export interface AiPackRequestQueueView {
  readonly id: string;
  readonly organizationId: string;
  readonly requestedAt: string;
}

export interface AiTestListView {
  readonly workspaces: readonly AiTestListEntryView[];
  readonly openRequests: readonly AiPackRequestQueueView[];
  readonly maxPackCredits: number;
}

export interface AiPackGrantView {
  readonly packId: string;
  readonly organizationId: string;
  readonly sizeCredits: number;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly requestId: string | null;
}

/** `PUT …/ai-budget`: all three caps in cents, the switch, and when the caps apply. */
export interface AiBudgetUpdate {
  readonly customersCents: number;
  readonly testingCents: number;
  readonly reserveCents: number;
  readonly sonnetEnabled: boolean;
  readonly applyTo: 'this_month' | 'next_month';
  readonly reason: string;
}

const BUDGET = '/v1/platform/settings/ai-budget';
const TEST_LIST = '/v1/platform/ai/test-list';

export async function fetchAiBudget(client: ApiClient): Promise<AiBudgetView> {
  const { data } = await client.request<AiBudgetView>({ path: BUDGET });
  return data;
}

export async function updateAiBudget(
  client: ApiClient,
  update: AiBudgetUpdate,
): Promise<AiBudgetView> {
  const { data } = await client.request<AiBudgetView>({
    method: 'PUT',
    path: BUDGET,
    body: update,
  });
  return data;
}

export async function pauseAi(client: ApiClient, reason: string): Promise<AiBudgetView> {
  const { data } = await client.request<AiBudgetView>({
    method: 'POST',
    path: `${BUDGET}/pause`,
    body: { reason },
  });
  return data;
}

export async function resumeAi(client: ApiClient, reason: string): Promise<AiBudgetView> {
  const { data } = await client.request<AiBudgetView>({
    method: 'POST',
    path: `${BUDGET}/resume`,
    body: { reason },
  });
  return data;
}

export async function releaseAiReserve(
  client: ApiClient,
  input: { readonly to: AiPoolClass; readonly amountCents: number; readonly reason: string },
): Promise<AiBudgetView> {
  const { data } = await client.request<AiBudgetView>({
    method: 'POST',
    path: `${BUDGET}/reserve-release`,
    body: input,
  });
  return data;
}

export async function fetchAiTestList(client: ApiClient): Promise<AiTestListView> {
  const { data } = await client.request<AiTestListView>({ path: TEST_LIST });
  return data;
}

export async function setAiTestListEntry(
  client: ApiClient,
  organizationId: string,
  input: {
    readonly onTestList: boolean;
    readonly poolClass?: AiPoolClass;
    readonly reason: string;
  },
): Promise<AiTestListEntryView> {
  const { data } = await client.request<AiTestListEntryView>({
    method: 'PUT',
    path: `${TEST_LIST}/${encodeURIComponent(organizationId)}`,
    body: input,
  });
  return data;
}

/** One grant per `idempotencyKey`: a retry of the same click never grants twice. */
export async function grantAiPack(
  client: ApiClient,
  organizationId: string,
  input: {
    readonly sizeCredits: number;
    readonly requestId: string | null;
    readonly reason: string;
    readonly idempotencyKey: string;
  },
): Promise<AiPackGrantView> {
  const { data } = await client.request<AiPackGrantView>({
    method: 'POST',
    path: `${TEST_LIST}/${encodeURIComponent(organizationId)}/packs`,
    body: {
      sizeCredits: input.sizeCredits,
      ...(input.requestId === null ? {} : { requestId: input.requestId }),
      reason: input.reason,
    },
    headers: { 'Idempotency-Key': input.idempotencyKey },
  });
  return data;
}

export async function declineAiPackRequest(
  client: ApiClient,
  organizationId: string,
  requestId: string,
  reason: string | null,
): Promise<AiPackRequestQueueView> {
  const { data } = await client.request<AiPackRequestQueueView>({
    method: 'POST',
    path: `${TEST_LIST}/${encodeURIComponent(organizationId)}/pack-requests/${encodeURIComponent(requestId)}/decline`,
    body: reason === null ? {} : { reason },
  });
  return data;
}
