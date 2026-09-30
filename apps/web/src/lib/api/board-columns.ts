import type { ApiClient } from './client';

/**
 * Work board columns (module 7, x308).
 *
 * This module wraps the board-columns API: list the org's custom board columns (any member), and
 * define / edit / remove a column (org config). One response shape is exported and paired in the
 * contracts gate — {@link BoardColumn}, Exact with the API's `BoardColumnView`. `organizationId` is
 * absent, as on every wire projection. A column is a display grouping over the existing work states;
 * nothing here changes the work-item state machine.
 */

/** The work-state keys a column may group. Mirrors the API's `WORK_ITEM_STATES`. */
export const WORK_ITEM_STATE_KEYS = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'internal_review',
  'done',
  'archived',
] as const;

export type WorkItemStateKey = (typeof WORK_ITEM_STATE_KEYS)[number];

/** One board column — paired Exact with the API's `BoardColumnView`. */
export interface BoardColumn {
  readonly id: string;
  readonly label: string;
  readonly stateKey: string;
  readonly position: number;
  readonly createdAt: string;
}

/** The fields a define / edit sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface BoardColumnInput {
  readonly label: string;
  readonly stateKey: WorkItemStateKey;
  readonly position: number;
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

/** List the organization's board columns, position-ascending. */
export async function listBoardColumns(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly BoardColumn[]> {
  const { data } = await client.request<{ columns: readonly BoardColumn[] }>({
    path: `${orgBase(organizationSlug)}/work/board-columns`,
  });
  return data.columns;
}

/** Define a board column. */
export async function defineBoardColumn(
  client: ApiClient,
  organizationSlug: string,
  input: BoardColumnInput,
): Promise<BoardColumn> {
  const { data } = await client.request<BoardColumn>({
    method: 'POST',
    path: `${orgBase(organizationSlug)}/work/board-columns`,
    body: input,
  });
  return data;
}

/** Edit a board column in place. */
export async function updateBoardColumn(
  client: ApiClient,
  organizationSlug: string,
  columnId: string,
  input: BoardColumnInput,
): Promise<BoardColumn> {
  const { data } = await client.request<BoardColumn>({
    method: 'PUT',
    path: `${orgBase(organizationSlug)}/work/board-columns/${encodeURIComponent(columnId)}`,
    body: input,
  });
  return data;
}

/** Remove a board column. */
export async function removeBoardColumn(
  client: ApiClient,
  organizationSlug: string,
  columnId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${orgBase(organizationSlug)}/work/board-columns/${encodeURIComponent(columnId)}`,
  });
}
