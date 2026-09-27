'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createExportRequest,
  EXPORT_SCOPES,
  readExportRequests,
} from '../../lib/api/admin-export-requests';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AdminExportRequestsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Human labels for the fixed export scopes. */
const SCOPE_LABELS: Record<string, string> = {
  full: 'Whole organization',
  members: 'People & memberships',
  projects: 'Projects',
  work_items: 'Work items',
  billing: 'Billing',
};

/** Human labels for the request lifecycle. */
const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

/**
 * **Admin data-export requests (Administration & governance, module 18, x224).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration & governance. This screen lists the organization's data-export
 * requests and records a new one — a GDPR-style request to export a chosen scope of the studio's data.
 * It is a faithful reader of the API: recording a request only creates a `pending` record and tracks
 * its status; the actual bulk export file generation and delivery is a later (Needs-Peter) async
 * worker, so this screen never produces or downloads a file.
 */
export function AdminExportRequestsScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminExportRequestsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const requests = useQuery({
    queryKey: ['admin-export-requests', organizationSlug],
    queryFn: () => readExportRequests(api, organizationSlug),
  });

  const [scope, setScope] = useState<string>(EXPORT_SCOPES[0]);
  const [created, setCreated] = useState(false);

  const save = useMutation({
    mutationFn: () => createExportRequest(api, organizationSlug, { scope }),
    onSuccess: async () => {
      setCreated(true);
      setScope(EXPORT_SCOPES[0]);
      await queryClient.invalidateQueries({
        queryKey: ['admin-export-requests', organizationSlug],
      });
    },
  });

  const rows = requests.data?.requests ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Data export requests"
      description="Request an export of your organization's data and track its status. Preparing the export is handled separately; recording a request here does not produce a file."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-admin-exports-heading">
        <h2 id="tm-admin-exports-heading" className="tm-eyebrow">
          Requests
        </h2>

        {requests.isError ? (
          <InlineAlert tone="danger" title="Could not load the requests" live>
            {describeError(requests.error)}
          </InlineAlert>
        ) : null}

        {requests.isPending ? (
          <LoadingRegion label="Loading the export requests.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!requests.isPending && !requests.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No export requests yet">
            No data-export requests have been made. Create one below.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-stack" aria-label="Data export requests">
            {rows.map((request) => (
              <li key={request.id} className="tm-row">
                <strong>{SCOPE_LABELS[request.scope] ?? request.scope}</strong>
                <span>{STATUS_LABELS[request.status] ?? request.status}</span>
                <span>{new Date(request.requestedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-admin-exports-new-heading">
        <h2 id="tm-admin-exports-new-heading" className="tm-eyebrow">
          New request
        </h2>

        <form
          className="tm-stack"
          noValidate
          aria-label="Request a data export"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setCreated(false);
            if (!save.isPending) save.mutate();
          }}
        >
          <Select
            label="What to export"
            name="export-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            hint="Choose the scope of the export. The file is prepared separately once requested."
          >
            {EXPORT_SCOPES.map((value) => (
              <option key={value} value={value}>
                {SCOPE_LABELS[value] ?? value}
              </option>
            ))}
          </Select>

          {save.isError ? (
            <InlineAlert tone="danger" title="Could not record the request" live>
              {describeError(save.error)}
            </InlineAlert>
          ) : null}
          {created && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title="Request recorded" live>
              Your data-export request has been recorded and is pending.
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel="Recording"
            >
              Request export
            </Button>
          </div>
        </form>
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
