'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  linkWorkItemToDecision,
  listDecisionWorkLinks,
  unlinkWorkItemFromDecision,
} from '../../lib/api/decision-work-links';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface DecisionWorkLinksPanelProps {
  organizationSlug: string;
  /** The decision whose linked work this panel shows. */
  decisionId: string;
  /** The decision's title, for the panel heading and accessible labels. */
  decisionTitle: string;
  client?: ApiClient;
}

/**
 * **Decision → work links (x149).**
 *
 * `38-MODULE-MAP` §Decisions ("linked actions"): the work items a decision set in motion. This panel
 * lists a decision's linked work in creation order, links a work item by id, and unlinks one. It reads
 * `GET …/decisions/:id/work-links` and writes `POST …/work-links` and `DELETE …/work-links/:linkId`,
 * gated on the server by `meeting.write` (link/unlink) and `work.read` (list).
 *
 * As on the sibling screens, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describeError()` turns into a sentence; the panel never guesses a capability
 * of its own and never renders blank on a refusal.
 */
export function DecisionWorkLinksPanel({
  organizationSlug,
  decisionId,
  decisionTitle,
  client,
}: DecisionWorkLinksPanelProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const [workItemId, setWorkItemId] = useState('');

  const headingId = `tm-decision-work-links-${decisionId}`;

  const links = useQuery({
    queryKey: ['decision-work-links', organizationSlug, decisionId],
    queryFn: () => listDecisionWorkLinks(api, organizationSlug, decisionId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['decision-work-links', organizationSlug, decisionId],
    });
  }

  const linkMutation = useMutation({
    mutationFn: () => linkWorkItemToDecision(api, organizationSlug, decisionId, workItemId.trim()),
    onSuccess: async () => {
      setWorkItemId('');
      await refetch();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: (linkId: string) =>
      unlinkWorkItemFromDecision(api, organizationSlug, decisionId, linkId),
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
    <section className="tm-dx-card" aria-labelledby={headingId}>
      <h3 id={headingId} className="tm-dx-caption">
        {t('DecisionWorkLinksPanel.linkedWork')}
        {rows.length > 0 ? ` · ${rows.length}` : ''}
        <span className="tm-visually-hidden"> — {decisionTitle}</span>
      </h3>
      <p className="tm-dx-card__title" aria-hidden="true">
        {decisionTitle}
      </p>

      <form className="tm-dx-form" onSubmit={onSubmit} noValidate>
        <fieldset className="tm-fieldset" disabled={linkMutation.isPending}>
          <Field
            label={t('DecisionWorkLinksPanel.workItemId')}
            name="workItemId"
            value={workItemId}
            onChange={(event) => setWorkItemId(event.target.value)}
            hint={t('DecisionWorkLinksPanel.workItemIdHint')}
            required
          />
        </fieldset>

        {linkMutation.isError ? (
          <InlineAlert tone="danger" title={t('DecisionWorkLinksPanel.linkError')} live>
            {describeError(linkMutation.error)}
          </InlineAlert>
        ) : null}

        <Button
          type="submit"
          tone="ink"
          size="compact"
          loading={linkMutation.isPending}
          loadingLabel={t('DecisionWorkLinksPanel.linking')}
          disabled={!canSubmit}
        >
          {t('DecisionWorkLinksPanel.linkWorkItem')}
        </Button>
      </form>

      {links.isError ? (
        <InlineAlert tone="danger" title={t('DecisionWorkLinksPanel.loadError')} live>
          {describeError(links.error)}
        </InlineAlert>
      ) : null}

      {links.isPending ? (
        <LoadingRegion label={t('DecisionWorkLinksPanel.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!links.isPending && !links.isError && rows.length === 0 ? (
        <div className="tm-dx-empty">
          <p className="tm-dx-empty__title">{t('DecisionWorkLinksPanel.emptyTitle')}</p>
          <p className="tm-dx-empty__body">{t('DecisionWorkLinksPanel.emptyBody')}</p>
        </div>
      ) : null}

      {rows.length > 0 && unlinkMutation.isError ? (
        <InlineAlert tone="danger" title={t('DecisionWorkLinksPanel.unlinkError')} live>
          {describeError(unlinkMutation.error)}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-dx-table-card"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
          // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={`${t('DecisionWorkLinksPanel.ariaLinkedToPrefix')}${decisionTitle}`}
        >
          <table className="tm-dx-table">
            <caption className="tm-visually-hidden">
              {t('DecisionWorkLinksPanel.captionPrefix')} {rows.length}{' '}
              {t('DecisionWorkLinksPanel.captionSuffix')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('DecisionWorkLinksPanel.thWorkItem')}</th>
                <th scope="col">{t('DecisionWorkLinksPanel.thState')}</th>
                <th scope="col">{t('DecisionWorkLinksPanel.thAction')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.linkId}>
                  <th scope="row" className="tm-dx-table__title">
                    {row.workItemTitle}
                  </th>
                  <td className="tm-dx-table__mono">{row.workItemState}</td>
                  <td className="tm-dx-table__end">
                    <Button
                      type="button"
                      tone="outline"
                      size="compact"
                      onClick={() => unlinkMutation.mutate(row.linkId)}
                      disabled={unlinkMutation.isPending}
                    >
                      {t('DecisionWorkLinksPanel.unlink')}
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
