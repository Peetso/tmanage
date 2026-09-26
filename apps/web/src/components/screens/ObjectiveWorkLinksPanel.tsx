'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  linkWorkItemToObjective,
  listObjectiveWorkLinks,
  unlinkWorkItemFromObjective,
} from '../../lib/api/objective-work-links';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ObjectiveWorkLinksPanelProps {
  organizationSlug: string;
  /** The objective whose linked work this panel shows. */
  objectiveId: string;
  /** The objective's name, for the panel heading and accessible labels. */
  objectiveName: string;
  client?: ApiClient;
}

/**
 * **Objective → work links (x138).**
 *
 * `38-MODULE-MAP` §Projects ("objectives ↔ work"): the work items that advance one objective. This
 * panel lists an objective's linked work in creation order, links a work item by id, and unlinks one.
 * It reads `GET …/objectives/:id/work-links` and writes `POST …/work-links` and
 * `DELETE …/work-links/:linkId`, gated on the server by `project.manage` (link/unlink) and `work.read`
 * (list).
 *
 * As on the sibling screens, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describeError()` turns into a sentence; the panel never guesses a capability
 * of its own and never renders blank on a refusal.
 */
export function ObjectiveWorkLinksPanel({
  organizationSlug,
  objectiveId,
  objectiveName,
  client,
}: ObjectiveWorkLinksPanelProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [workItemId, setWorkItemId] = useState('');

  const headingId = `tm-work-links-${objectiveId}`;

  const links = useQuery({
    queryKey: ['objective-work-links', organizationSlug, objectiveId],
    queryFn: () => listObjectiveWorkLinks(api, organizationSlug, objectiveId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['objective-work-links', organizationSlug, objectiveId],
    });
  }

  const linkMutation = useMutation({
    mutationFn: () =>
      linkWorkItemToObjective(api, organizationSlug, objectiveId, workItemId.trim()),
    onSuccess: async () => {
      setWorkItemId('');
      await refetch();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: (linkId: string) =>
      unlinkWorkItemFromObjective(api, organizationSlug, objectiveId, linkId),
    onSuccess: refetch,
  });

  const rows = useMemo(() => links.data ?? [], [links.data]);
  const canSubmit = workItemId.trim() !== '';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || linkMutation.isPending) return;
    linkMutation.mutate();
  }

  return (
    <section className="tm-panel tm-stack" aria-labelledby={headingId}>
      <h3 id={headingId} className="tm-eyebrow">
        Linked work — {objectiveName}
      </h3>

      <form className="tm-stack" onSubmit={onSubmit} noValidate>
        <fieldset
          className="tm-fieldset tm-stack tm-stack--loose"
          disabled={linkMutation.isPending}
        >
          <Field
            label="Work item ID"
            name="workItemId"
            value={workItemId}
            onChange={(event) => setWorkItemId(event.target.value)}
            hint="The ID of a work item in this project to link to the objective."
            required
          />
        </fieldset>

        {linkMutation.isError ? (
          <InlineAlert tone="danger" title="Could not link the work item" live>
            {describeError(linkMutation.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={linkMutation.isPending}
            loadingLabel="Linking"
            disabled={!canSubmit}
          >
            Link work item
          </Button>
        </div>
      </form>

      {links.isError ? (
        <InlineAlert tone="danger" title="Could not load the linked work" live>
          {describeError(links.error)}
        </InlineAlert>
      ) : null}

      {links.isPending ? (
        <LoadingRegion label="Loading the objective's linked work.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!links.isPending && !links.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No linked work yet">
          No work is linked to this objective. Link the first item above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 && unlinkMutation.isError ? (
        <InlineAlert tone="danger" title="Could not unlink the work item" live>
          {describeError(unlinkMutation.error)}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
          // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={`Work linked to ${objectiveName}`}
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Work linked to this objective, in link order, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Work item</th>
                <th scope="col">State</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.linkId}>
                  <th scope="row" className="tm-table__title">
                    {row.workItemTitle}
                  </th>
                  <td>{row.workItemState}</td>
                  <td>
                    <Button
                      type="button"
                      tone="outline"
                      size="accessible"
                      onClick={() => unlinkMutation.mutate(row.linkId)}
                      disabled={unlinkMutation.isPending}
                    >
                      Unlink
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
