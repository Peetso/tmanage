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
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface AdminExportRequestsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  /** Human labels for the fixed export scopes. */
  const scopeLabels: Record<string, string> = {
    full: t('AdminExportRequestsScreen.scopeFull'),
    members: t('AdminExportRequestsScreen.scopeMembers'),
    projects: t('AdminExportRequestsScreen.scopeProjects'),
    work_items: t('AdminExportRequestsScreen.scopeWorkItems'),
    billing: t('AdminExportRequestsScreen.scopeBilling'),
  };

  /** Human labels for the request lifecycle. */
  const statusLabels: Record<string, string> = {
    pending: t('AdminExportRequestsScreen.statusPending'),
    processing: t('AdminExportRequestsScreen.statusProcessing'),
    completed: t('AdminExportRequestsScreen.statusCompleted'),
    failed: t('AdminExportRequestsScreen.statusFailed'),
  };

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
      title={t('AdminExportRequestsScreen.title')}
      description={t('AdminExportRequestsScreen.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-admin-exports-heading">
        <h2 id="tm-admin-exports-heading" className="tm-eyebrow">
          {t('AdminExportRequestsScreen.requestsHeading')}
        </h2>

        {requests.isError ? (
          <InlineAlert tone="danger" title={t('AdminExportRequestsScreen.loadError')} live>
            {describeError(requests.error)}
          </InlineAlert>
        ) : null}

        {requests.isPending ? (
          <LoadingRegion label={t('AdminExportRequestsScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!requests.isPending && !requests.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title={t('AdminExportRequestsScreen.emptyTitle')}>
            {t('AdminExportRequestsScreen.emptyBody')}
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-stack" aria-label={t('AdminExportRequestsScreen.listLabel')}>
            {rows.map((request) => (
              <li key={request.id} className="tm-row">
                <strong>{scopeLabels[request.scope] ?? request.scope}</strong>
                <span>{statusLabels[request.status] ?? request.status}</span>
                <span>{new Date(request.requestedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-admin-exports-new-heading">
        <h2 id="tm-admin-exports-new-heading" className="tm-eyebrow">
          {t('AdminExportRequestsScreen.newRequestHeading')}
        </h2>

        <form
          className="tm-stack"
          noValidate
          aria-label={t('AdminExportRequestsScreen.formLabel')}
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setCreated(false);
            if (!save.isPending) save.mutate();
          }}
        >
          <Select
            label={t('AdminExportRequestsScreen.scopeSelectLabel')}
            name="export-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            hint={t('AdminExportRequestsScreen.scopeSelectHint')}
          >
            {EXPORT_SCOPES.map((value) => (
              <option key={value} value={value}>
                {scopeLabels[value] ?? value}
              </option>
            ))}
          </Select>

          {save.isError ? (
            <InlineAlert tone="danger" title={t('AdminExportRequestsScreen.recordError')} live>
              {describeError(save.error)}
            </InlineAlert>
          ) : null}
          {created && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title={t('AdminExportRequestsScreen.recordedTitle')} live>
              {t('AdminExportRequestsScreen.recordedBody')}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel={t('AdminExportRequestsScreen.recording')}
            >
              {t('AdminExportRequestsScreen.requestExport')}
            </Button>
          </div>
        </form>
      </section>
    </AppShell>
  );
}
