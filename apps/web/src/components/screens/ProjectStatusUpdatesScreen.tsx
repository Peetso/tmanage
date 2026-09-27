'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createProjectStatusUpdate,
  listProjectStatusUpdates,
} from '../../lib/api/project-status-updates';
import type {
  ProjectStatusBand,
  ProjectStatusUpdateSummary,
} from '../../lib/api/project-status-updates';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectStatusUpdatesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose status log this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient;
}

const BAND_LABELS: Readonly<Record<ProjectStatusBand, string>> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
};

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
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [statusBand, setStatusBand] = useState<ProjectStatusBand>('on_track');
  const [body, setBody] = useState('');

  const updates = useQuery({
    queryKey: ['project-status-updates', organizationSlug, projectId],
    queryFn: () => listProjectStatusUpdates(api, organizationSlug, projectId),
  });

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
      title="Status updates"
      description="This project's internal status log — where it stands, in the team's own words."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-status-author">
        <h2 id="tm-status-author" className="tm-eyebrow">
          Post an update
        </h2>
        <form className="tm-stack" onSubmit={onSubmit} noValidate>
          <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={post.isPending}>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-status-band">
                Status
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
                    {BAND_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-status-body">
                Update
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
                What changed, what stands, what is next. The team sees this — clients do not.
              </span>
            </div>
          </fieldset>

          {post.isError ? (
            <InlineAlert tone="danger" title="Could not post the update" live>
              {describeError(post.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={post.isPending}
              loadingLabel="Posting"
              disabled={!canSubmit}
            >
              Post update
            </Button>
          </div>
        </form>
      </section>

      {updates.isError ? (
        <InlineAlert tone="danger" title="Could not load the status log" live>
          {describeError(updates.error)}
        </InlineAlert>
      ) : null}

      {updates.isPending ? (
        <LoadingRegion label="Loading the project's status updates.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!updates.isPending && !updates.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No updates yet">
          This project has no status updates. Post the first one above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-status-log-heading">
          <h2 id="tm-status-log-heading" className="tm-eyebrow">
            Log
          </h2>
          <ol className="tm-stack tm-stack--loose">
            {rows.map((update) => (
              <StatusUpdateItem key={update.id} update={update} />
            ))}
          </ol>
        </section>
      ) : null}
    </AppShell>
  );
}

function StatusUpdateItem({ update }: { update: ProjectStatusUpdateSummary }) {
  return (
    <li className="tm-stack">
      <div className="tm-row">
        <span className="tm-eyebrow">{BAND_LABELS[update.statusBand]}</span>
        <time className="tm-field__hint" dateTime={update.postedAt}>
          {new Date(update.postedAt).toLocaleString()}
        </time>
      </div>
      <p className="tm-prose">{update.body}</p>
    </li>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
