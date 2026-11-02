import type { ApiClient } from './client';

/**
 * The onboarding-import receipt endpoint — ON-09 "progress" / ADM-10 "receipt" (x104), behind the
 * Import Receipt screen. It reads a committed job's terminal status, its committed / failed
 * counts, and the per-row outcomes in source order.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection
 * (`ImportCommitView` / `ImportCommitRowView`) in the `e2e/contracts` shape check so the two
 * shapes cannot drift.
 *
 * The read is gated on the server by `org.manage` — the same coarse gate the validate and commit
 * halves use — so a caller without it gets the ordinary 403 the shared client turns into an
 * error. There is no organization-id argument: the tenant is the slug in the path resolved
 * against the caller's membership, never a value the caller supplies.
 */

/** One source row's outcome in a committed import — pairs with the API's `ImportCommitRowView`. */
export interface ImportReceiptRow {
  readonly sourceIndex: number;
  readonly outcome: 'created' | 'failed';
  /** The created entity's id for a `created` row; `null` for a `failed` one. */
  readonly createdEntityId: string | null;
  /** The validation / authorization error for a `failed` row; `null` for a `created` one. */
  readonly error: string | null;
}

/** A committed job's receipt — pairs with the API's `ImportCommitView`. */
export interface ImportReceipt {
  readonly jobId: string;
  readonly sourceKind: 'project' | 'jira_issues' | 'notion_database' | 'basecamp_messages';
  readonly status: 'committed' | 'committed_with_errors';
  readonly committedCount: number;
  readonly failedCount: number;
  readonly rows: readonly ImportReceiptRow[];
  /** R21-e: a `jira_issues` commit's summary, on the commit response only (never stored). */
  readonly jira?: ImportJiraSummary;
  /** R22-f: a `notion_database` commit's summary, on the commit response only. */
  readonly notion?: ImportNotionSummary;
  /** R22-f: a `basecamp_messages` commit's summary, on the commit response only. */
  readonly basecamp?: ImportBasecampSummary;
}

/** R21-e: what a Jira batch created — pairs with the API's `JiraCommitSummary`. */
export interface ImportJiraSummary {
  readonly projectId: string;
  readonly prefix: string | null;
  readonly sprintsCreated: number;
  readonly itemsKeyed: number;
  readonly epicsSkipped: number;
  readonly notes: readonly string[];
  /** R22-e: unknown ADF node / wiki macro names met in descriptions (`jira_unknown_markup`). */
  readonly descriptionNotes: readonly string[];
}

/** R22-f: what a Notion database batch created — pairs with the API's `NotionCommitSummary`. */
export interface ImportNotionSummary {
  readonly projectId: string;
  readonly itemsCreated: number;
  readonly labelsCreated: number;
  readonly notes: readonly string[];
}

/** R22-f: what a Basecamp batch created — pairs with the API's `BasecampCommitSummary`. */
export interface ImportBasecampSummary {
  readonly projectId: string;
  readonly documentsCreated: number;
  readonly itemsCreated: number;
  readonly phasesCreated: number;
  /** Rows not imported, by kind: `{ campfire: n, hillchart: n, … }`. */
  readonly basecampSkipped: Readonly<Record<string, number>>;
  readonly notes: readonly string[];
}

export async function fetchImportReceipt(
  client: ApiClient,
  organizationSlug: string,
  jobId: string,
): Promise<ImportReceipt> {
  const { data } = await client.request<ImportReceipt>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/imports/${encodeURIComponent(
      jobId,
    )}/receipt`,
  });
  return data;
}
