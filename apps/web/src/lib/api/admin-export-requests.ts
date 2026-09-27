import type { ApiClient } from './client';

/**
 * Admin data-export requests (Administration & governance, module 18, x224).
 *
 * Wraps the admin export-requests API: list the organization's data-export requests and record a new
 * one (a scope from the fixed allowlist). The one exported response shape is {@link DataExportRequestView},
 * paired Exact with the API's `DataExportRequestView` in the contracts gate — the wire projection is a
 * flat list of requests and never echoes the tenant id. Recording a request produces no file and
 * transmits nothing; the actual export is a later (Needs-Peter) async worker.
 */

/** The organization's data-export requests — each with its scope, status and who asked when. */
export interface DataExportRequestView {
  readonly requests: readonly {
    readonly id: string;
    readonly scope: string;
    readonly status: string;
    readonly requestedBy: string;
    readonly requestedAt: string;
  }[];
}

/** The export scopes the request form offers — mirrors the API's fixed allowlist. */
export const EXPORT_SCOPES = ['full', 'members', 'projects', 'work_items', 'billing'] as const;

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/export-requests`;
}

/** List the organization's data-export requests. */
export async function readExportRequests(
  client: ApiClient,
  organizationSlug: string,
): Promise<DataExportRequestView> {
  const { data } = await client.request<DataExportRequestView>({ path: base(organizationSlug) });
  return data;
}

/** Record a new data-export request. Returns the full request list after the write. */
export async function createExportRequest(
  client: ApiClient,
  organizationSlug: string,
  input: { scope: string },
): Promise<DataExportRequestView> {
  const { data } = await client.request<DataExportRequestView>({
    method: 'POST',
    path: base(organizationSlug),
    body: { scope: input.scope },
  });
  return data;
}
