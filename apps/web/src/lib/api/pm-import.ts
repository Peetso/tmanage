import type { ApiClient } from './client';

/**
 * R45 L3 (54-25). The Trello / Asana token import, owner/admin only (`org.manage`). Mirrors
 * `apps/api/src/modules/import/pm-import.service.ts`. The pasted token goes to `connect` once and
 * never comes back: the API keeps it in the token vault and deletes it when the import ends.
 */

export type PmSource = 'trello' | 'asana';
export const PM_TARGET_STATES = [
  'backlog',
  'ready',
  'in_progress',
  'internal_review',
  'done',
] as const;
export type PmTargetState = (typeof PM_TARGET_STATES)[number];

export interface PmBoard {
  readonly id: string;
  readonly name: string;
  readonly group: string | null;
}

export interface PmPerson {
  readonly key: string;
  readonly name: string;
  readonly email: string | null;
}

export interface PmDiscovery {
  readonly containers: readonly string[];
  readonly people: readonly PmPerson[];
  readonly suggestion: {
    readonly statusMap: Readonly<Record<string, PmTargetState>>;
    readonly userMap: Readonly<Record<string, string>>;
  };
  readonly cardCount: number;
  readonly truncated: boolean;
}

export interface PmPreview {
  readonly counts: {
    readonly cards: number;
    readonly comments: number | null;
    readonly dueDates: number;
    readonly assigned: number;
    readonly alreadyImported: number;
    readonly archivedSkipped: number;
  };
  readonly unmappedContainers: readonly string[];
  readonly unmatchedPeople: readonly string[];
  readonly truncated: boolean;
}

export type PmJobStatus = 'running' | 'committed' | 'committed_with_errors' | 'failed';

export interface PmJob {
  readonly jobId: string;
  readonly source: PmSource;
  readonly status: PmJobStatus;
  readonly committedCount: number;
  readonly failedCount: number;
}

export interface PmImportChoices {
  readonly projectId: string;
  readonly boardIds: readonly string[];
  readonly statusMap: Readonly<Record<string, PmTargetState>>;
  readonly userMap: Readonly<Record<string, string | null>>;
}

function base(organizationSlug: string, source: PmSource): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/imports/pm/${source}`;
}

export async function connectPmSource(
  client: ApiClient,
  organizationSlug: string,
  source: PmSource,
  credential: { readonly apiKey?: string; readonly token: string },
): Promise<readonly PmBoard[]> {
  const { data } = await client.request<{ boards: readonly PmBoard[] }>({
    method: 'POST',
    path: `${base(organizationSlug, source)}/connect`,
    body: credential,
  });
  return data.boards;
}

export async function disconnectPmSource(
  client: ApiClient,
  organizationSlug: string,
  source: PmSource,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${base(organizationSlug, source)}/connection`,
  });
}

export async function discoverPmBoards(
  client: ApiClient,
  organizationSlug: string,
  source: PmSource,
  boardIds: readonly string[],
): Promise<PmDiscovery> {
  const { data } = await client.request<PmDiscovery>({
    method: 'POST',
    path: `${base(organizationSlug, source)}/discover`,
    body: { boardIds },
  });
  return data;
}

export async function previewPmImport(
  client: ApiClient,
  organizationSlug: string,
  source: PmSource,
  choices: PmImportChoices,
): Promise<PmPreview> {
  const { data } = await client.request<PmPreview>({
    method: 'POST',
    path: `${base(organizationSlug, source)}/preview`,
    body: choices,
  });
  return data;
}

export async function startPmImport(
  client: ApiClient,
  organizationSlug: string,
  source: PmSource,
  choices: PmImportChoices,
): Promise<PmJob> {
  const { data } = await client.request<PmJob>({
    method: 'POST',
    path: `${base(organizationSlug, source)}/jobs`,
    body: choices,
  });
  return data;
}

export async function fetchPmJob(
  client: ApiClient,
  organizationSlug: string,
  source: PmSource,
  jobId: string,
): Promise<PmJob> {
  const { data } = await client.request<PmJob>({
    path: `${base(organizationSlug, source)}/jobs/${encodeURIComponent(jobId)}`,
  });
  return data;
}

/** The status a list / section name suggests (the API's own rule, for an unmapped name). */
export function suggestPmState(name: string): PmTargetState {
  const n = name.toLowerCase();
  if (/\b(done|complete[d]?|closed|finished|shipped)\b/u.test(n)) return 'done';
  if (/\b(review|qa|testing|approval)\b/u.test(n)) return 'internal_review';
  if (/\b(doing|in progress|progress|working|wip|started)\b/u.test(n)) return 'in_progress';
  if (/\b(to ?do|ready|next|up next|planned)\b/u.test(n)) return 'ready';
  return 'backlog';
}
