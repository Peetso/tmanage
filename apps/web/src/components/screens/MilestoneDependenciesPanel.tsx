'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  linkMilestoneDependency,
  listMilestoneDependencies,
  unlinkMilestoneDependency,
} from '../../lib/api/milestone-links';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface MilestoneDependenciesPanelProps {
  organizationSlug: string;
  /** The milestone whose dependencies this panel shows. */
  milestoneId: string;
  /** The milestone's title, for the panel heading and accessible labels. */
  milestoneTitle: string;
  client?: ApiClient;
}

/**
 * **Milestone dependencies (x236).**
 *
 * `38-MODULE-MAP` §Projects & portfolio: the milestones one milestone depends on. Distinct from the
 * x139 milestone screens (`MilestoneLifecycleControls`, `PortalMilestonesScreen`) — this panel is the
 * dependency control. It lists a milestone's prerequisites in creation order, links one by id, and
 * unlinks one. It reads `GET …/projects/milestones/:id/links` and writes `POST …/links` and
 * `DELETE …/links/:dependsOnMilestoneId`, all gated on the server by `project.manage`.
 *
 * As on the sibling screens, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describeError()` turns into a sentence; the panel never guesses a
 * capability of its own and never renders blank on a refusal.
 */
export function MilestoneDependenciesPanel({
  organizationSlug,
  milestoneId,
  milestoneTitle,
  client,
}: MilestoneDependenciesPanelProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();

  const [dependsOnMilestoneId, setDependsOnMilestoneId] = useState('');

  const headingId = `tm-milestone-deps-${milestoneId}`;

  const dependencies = useQuery({
    queryKey: ['milestone-dependencies', organizationSlug, milestoneId],
    queryFn: () => listMilestoneDependencies(api, organizationSlug, milestoneId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['milestone-dependencies', organizationSlug, milestoneId],
    });
  }

  const linkMutation = useMutation({
    mutationFn: () =>
      linkMilestoneDependency(api, organizationSlug, milestoneId, dependsOnMilestoneId.trim()),
    onSuccess: async () => {
      setDependsOnMilestoneId('');
      await refetch();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: (targetId: string) =>
      unlinkMilestoneDependency(api, organizationSlug, milestoneId, targetId),
    onSuccess: refetch,
  });

  const rows = useMemo(() => dependencies.data ?? [], [dependencies.data]);
  const canSubmit = dependsOnMilestoneId.trim() !== '';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || linkMutation.isPending) return;
    linkMutation.mutate();
  }

  return (
    <section className="tm-panel tm-stack" aria-labelledby={headingId}>
      <h3 id={headingId} className="tm-eyebrow">
        {t('MilestoneDependenciesPanel.dependsOn')} {milestoneTitle}
      </h3>

      <form className="tm-stack" onSubmit={onSubmit} noValidate>
        <fieldset
          className="tm-fieldset tm-stack tm-stack--loose"
          disabled={linkMutation.isPending}
        >
          <Field
            label={t('MilestoneDependenciesPanel.prerequisiteIdLabel')}
            name="dependsOnMilestoneId"
            value={dependsOnMilestoneId}
            onChange={(event) => setDependsOnMilestoneId(event.target.value)}
            hint={t('MilestoneDependenciesPanel.prerequisiteIdHint')}
            required
          />
        </fieldset>

        {linkMutation.isError ? (
          <InlineAlert tone="danger" title={t('MilestoneDependenciesPanel.addError')} live>
            {describeError(linkMutation.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={linkMutation.isPending}
            loadingLabel={t('MilestoneDependenciesPanel.linking')}
            disabled={!canSubmit}
          >
            {t('MilestoneDependenciesPanel.addDependency')}
          </Button>
        </div>
      </form>

      {dependencies.isError ? (
        <InlineAlert tone="danger" title={t('MilestoneDependenciesPanel.loadError')} live>
          {describeError(dependencies.error)}
        </InlineAlert>
      ) : null}

      {dependencies.isPending ? (
        <LoadingRegion label={t('MilestoneDependenciesPanel.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!dependencies.isPending && !dependencies.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title={t('MilestoneDependenciesPanel.emptyTitle')}>
          {t('MilestoneDependenciesPanel.emptyBody')}
        </InlineAlert>
      ) : null}

      {rows.length > 0 && unlinkMutation.isError ? (
        <InlineAlert tone="danger" title={t('MilestoneDependenciesPanel.removeError')} live>
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
          aria-label={`${t('MilestoneDependenciesPanel.regionPrefix')} ${milestoneTitle} ${t('MilestoneDependenciesPanel.regionSuffix')}`}
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              {t('MilestoneDependenciesPanel.captionPrefix')} {rows.length}{' '}
              {t('MilestoneDependenciesPanel.captionShown')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('MilestoneDependenciesPanel.colPrerequisite')}</th>
                <th scope="col">{t('MilestoneDependenciesPanel.colStatus')}</th>
                <th scope="col">{t('MilestoneDependenciesPanel.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.linkId}>
                  <th scope="row" className="tm-table__title">
                    {row.dependsOnTitle}
                  </th>
                  <td>{row.dependsOnStatus}</td>
                  <td>
                    <Button
                      type="button"
                      tone="outline"
                      size="accessible"
                      onClick={() => unlinkMutation.mutate(row.dependsOnMilestoneId)}
                      disabled={unlinkMutation.isPending}
                    >
                      {t('MilestoneDependenciesPanel.remove')}
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
