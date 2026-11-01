'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import {
  createProjectStatusUpdate,
  listProjectStatusUpdates,
} from '../../lib/api/project-status-updates';
import type {
  ProjectStatusBand,
  ProjectStatusUpdateSummary,
} from '../../lib/api/project-status-updates';
import type { ApiClient } from '../../lib/api/client';
import { listManagedUpdates } from '../../lib/api/managed-updates';
import { useA10T } from '../projects/UnpublishUpdateDialog';
import { UpdateLifecycleControls } from './UpdateLifecycleControls';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appLocale } from '../../lib/i18n/app-locale';

export interface ProjectStatusUpdatesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose status log this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient;
}

const BAND_KEY = {
  on_track: 'ProjectStatusUpdatesScreen.bandOnTrack',
  at_risk: 'ProjectStatusUpdatesScreen.bandAtRisk',
  off_track: 'ProjectStatusUpdatesScreen.bandOffTrack',
} as const;

const BANDS: readonly ProjectStatusBand[] = ['on_track', 'at_risk', 'off_track'];

/**
 * **Project internal status updates (x235).**
 *
 * `38-MODULE-MAP` §Projects & portfolio: a project's **internal** status changelog — the studio's own
 * running log of where a project stands. This screen posts an update (a status band and a narrative)
 * and lists the project's updates newest-first. It reads `GET …/projects/:id/status-updates` and
 * writes `POST …/status-updates`, gated on the server by `project.manage`.
 *
 * This is the **internal** log, distinct from the client portal updates (x125): it is never shown to a
 * client. As on the sibling screens, **authorization is the API's**: a caller without the capability
 * gets the ordinary refusal, which `describeError()` turns into a sentence.
 */
export function ProjectStatusUpdatesScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectStatusUpdatesScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const a10 = useA10T();

  const [statusBand, setStatusBand] = useState<ProjectStatusBand>('on_track');
  const [body, setBody] = useState('');

  const updates = useQuery({
    queryKey: ['project-status-updates', organizationSlug, projectId],
    queryFn: () => listProjectStatusUpdates(api, organizationSlug, projectId),
  });

  // A10 — the project's client updates (drafts included), each drawn as the published-update card.
  const clientUpdates = useQuery({
    queryKey: ['managed-updates', organizationSlug, projectId],
    queryFn: () => listManagedUpdates(api, organizationSlug, projectId),
  });
  const clientRows = clientUpdates.data ?? [];

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['project-status-updates', organizationSlug, projectId],
    });
  }

  const post = useMutation({
    mutationFn: () =>
      createProjectStatusUpdate(api, organizationSlug, projectId, {
        statusBand,
        body: body.trim(),
      }),
    onSuccess: async () => {
      setStatusBand('on_track');
      setBody('');
      await refetch();
    },
  });

  const rows = useMemo(() => updates.data?.updates ?? [], [updates.data]);
  const canSubmit = body.trim() !== '';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || post.isPending) return;
    post.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('ProjectStatusUpdatesScreen.title')}
      description={t('ProjectStatusUpdatesScreen.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-status-author">
        <h2 id="tm-status-author" className="tm-eyebrow">
          {t('ProjectStatusUpdatesScreen.postAnUpdate')}
        </h2>
        <form className="tm-stack" onSubmit={onSubmit} noValidate>
          <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={post.isPending}>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-status-band">
                {t('ProjectStatusUpdatesScreen.status')}
              </label>
              <select
                id="tm-status-band"
                name="statusBand"
                className="tm-field__control"
                value={statusBand}
                onChange={(event) => setStatusBand(event.target.value as ProjectStatusBand)}
              >
                {BANDS.map((value) => (
                  <option key={value} value={value}>
                    {t(BAND_KEY[value])}
                  </option>
                ))}
              </select>
            </div>

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-status-body">
                {t('ProjectStatusUpdatesScreen.update')}
              </label>
              <textarea
                id="tm-status-body"
                name="body"
                className="tm-field__control tm-field__control--multiline"
                rows={4}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                aria-describedby="tm-status-body-hint"
                required
              />
              <span className="tm-field__hint" id="tm-status-body-hint">
                {t('ProjectStatusUpdatesScreen.bodyHint')}
              </span>
            </div>
          </fieldset>

          {post.isError ? (
            <InlineAlert tone="danger" title={t('ProjectStatusUpdatesScreen.postFailed')} live>
              {describeError(post.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={post.isPending}
              loadingLabel={t('ProjectStatusUpdatesScreen.posting')}
              disabled={!canSubmit}
            >
              {t('ProjectStatusUpdatesScreen.postUpdate')}
            </Button>
          </div>
        </form>
      </section>

      {updates.isError ? (
        <InlineAlert tone="danger" title={t('ProjectStatusUpdatesScreen.loadFailed')} live>
          {describeError(updates.error)}
        </InlineAlert>
      ) : null}

      {updates.isPending ? (
        <LoadingRegion label={t('ProjectStatusUpdatesScreen.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!updates.isPending && !updates.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title={t('ProjectStatusUpdatesScreen.emptyTitle')}>
          {t('ProjectStatusUpdatesScreen.emptyBody')}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-status-log-heading">
          <h2 id="tm-status-log-heading" className="tm-eyebrow">
            {t('ProjectStatusUpdatesScreen.log')}
          </h2>
          <ol className="tm-stack tm-stack--loose">
            {rows.map((update) => (
              <StatusUpdateItem key={update.id} update={update} />
            ))}
          </ol>
        </section>
      ) : null}

      {clientUpdates.isError ? (
        <InlineAlert tone="danger" title={a10('UpdateCard.loadFailed')} live>
          {describeError(clientUpdates.error)}
        </InlineAlert>
      ) : null}

      {clientRows.length > 0 ? (
        <section className="tm-stack" aria-labelledby="tm-client-updates-heading">
          <h2 id="tm-client-updates-heading" className="tm-eyebrow">
            {a10('UpdateCard.sectionTitle')}
          </h2>
          <ol className="tm-upd-list">
            {clientRows.map((update) => (
              <li key={update.id}>
                <UpdateLifecycleControls
                  api={api}
                  organizationSlug={organizationSlug}
                  update={update}
                />
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </AppShell>
  );
}

function StatusUpdateItem({ update }: { update: ProjectStatusUpdateSummary }) {
  const t = useT();
  return (
    <li className="tm-stack">
      <div className="tm-row">
        <span className="tm-eyebrow">{t(BAND_KEY[update.statusBand])}</span>
        <time className="tm-field__hint" dateTime={update.postedAt}>
          {new Date(update.postedAt).toLocaleString(appLocale())}
        </time>
      </div>
      <p className="tm-prose">{update.body}</p>
    </li>
  );
}
