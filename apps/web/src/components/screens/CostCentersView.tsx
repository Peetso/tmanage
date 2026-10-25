'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  assignCostCenterProject,
  createCostCenter,
  deleteCostCenter,
  listCostCenters,
  unassignCostCenterProject,
  type CostCenterSummary,
} from '../../lib/api/billing-cost-centers';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/billing.css';

export interface CostCentersViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Billing & entitlements (module 19, x281).**
 *
 * `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §allocation; `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP`
 * §Billing; `22-SCREEN-INVENTORY` §Billing. This screen owns the org-scoped cost centers a billing
 * admin names — a code and a display name — and the projects assigned to each. It creates a definition,
 * lists the organization's definitions with their assigned project ids, deletes one, and assigns or
 * unassigns a project. Every route is gated on the server by `org.manage`, so a member without the
 * capability sees the API's refusal rather than a blank page.
 *
 * ## What it does, and what it cannot
 *
 * Definitions and assignments only. Nothing is metered or charged here; grouping usage/spend by cost
 * center is a later slice.
 */
export function CostCentersView({
  organizationSlug,
  organizationName,
  client,
}: CostCentersViewProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();

  const costCenters = useQuery({
    queryKey: ['cost-centers', organizationSlug],
    queryFn: () => listCostCenters(api, organizationSlug),
  });

  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['cost-centers', organizationSlug] });

  const create = useMutation({
    mutationFn: () =>
      createCostCenter(api, organizationSlug, { code: code.trim(), name: name.trim() }),
    onSuccess: async () => {
      setCode('');
      setName('');
      await invalidate();
    },
  });

  const rows = costCenters.data ?? [];
  const canCreate = code.trim() !== '' && name.trim() !== '' && !create.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('CostCentersView.eyebrow')}
      title={t('CostCentersView.title')}
      description={t('CostCentersView.description')}
    >
      <div className="tm-bil">
        <section className="tm-panel tm-stack" aria-labelledby="tm-cost-center-new-heading">
          <h2 id="tm-cost-center-new-heading" className="tm-eyebrow">
            {t('CostCentersView.newCostCenterHeading')}
          </h2>
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canCreate) create.mutate();
            }}
          >
            <Field
              label={t('CostCentersView.codeLabel')}
              name="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              hint={t('CostCentersView.codeHint')}
              maxLength={64}
              required
            />
            <Field
              label={t('CostCentersView.nameLabel')}
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint={t('CostCentersView.nameHint')}
              maxLength={190}
              required
            />

            {create.isError ? (
              <InlineAlert tone="danger" title={t('CostCentersView.createError')} live>
                {describeError(create.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={create.isPending}
                loadingLabel={t('CostCentersView.creating')}
                disabled={!canCreate}
              >
                {t('CostCentersView.createCostCenter')}
              </Button>
            </div>
          </form>
        </section>

        <section
          className="tm-panel tm-panel--quiet tm-stack"
          aria-labelledby="tm-cost-center-list-heading"
        >
          <h2 id="tm-cost-center-list-heading" className="tm-eyebrow">
            {t('CostCentersView.costCentersHeading')}
          </h2>

          {costCenters.isError ? (
            <InlineAlert tone="danger" title={t('CostCentersView.loadError')} live>
              {describeError(costCenters.error)}
            </InlineAlert>
          ) : null}

          {costCenters.isPending ? (
            <LoadingRegion label={t('CostCentersView.loadingLabel')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!costCenters.isPending && !costCenters.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title={t('CostCentersView.emptyTitle')}>
              {t('CostCentersView.emptyBody')}
            </InlineAlert>
          ) : null}

          {rows.map((center) => (
            <CostCenterCard
              key={center.id}
              center={center}
              api={api}
              organizationSlug={organizationSlug}
              onChanged={invalidate}
            />
          ))}
        </section>
      </div>
    </AppShell>
  );
}

interface CostCenterCardProps {
  center: CostCenterSummary;
  api: ApiClient;
  organizationSlug: string;
  onChanged: () => Promise<unknown>;
}

/** One cost center: its code and name, its assigned projects, and the controls to change them. */
function CostCenterCard({ center, api, organizationSlug, onChanged }: CostCenterCardProps) {
  const describeError = useDescribeApiError();
  const t = useT();
  const [projectId, setProjectId] = useState('');
  const inputId = `tm-cost-center-project-${center.id}`;

  const assign = useMutation({
    mutationFn: () => assignCostCenterProject(api, organizationSlug, center.id, projectId.trim()),
    onSuccess: async () => {
      setProjectId('');
      await onChanged();
    },
  });
  const unassign = useMutation({
    mutationFn: (target: string) =>
      unassignCostCenterProject(api, organizationSlug, center.id, target),
    onSuccess: async () => {
      await onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteCostCenter(api, organizationSlug, center.id),
    onSuccess: async () => {
      await onChanged();
    },
  });

  const canAssign = projectId.trim() !== '' && !assign.isPending;

  return (
    <article
      className="tm-panel tm-stack"
      aria-label={`${t('CostCentersView.costCenterPrefix')}${center.name}`}
    >
      <div className="tm-row tm-row--between">
        <h3 className="tm-heading-sm">
          {center.name} <span className="tm-muted">({center.code})</span>
        </h3>
        <Button
          type="button"
          tone="destructive"
          size="accessible"
          loading={remove.isPending}
          loadingLabel={t('CostCentersView.deleting')}
          onClick={() => remove.mutate()}
        >
          {t('CostCentersView.delete')}
        </Button>
      </div>

      {center.projectIds.length === 0 ? (
        <p className="tm-muted">{t('CostCentersView.noProjects')}</p>
      ) : (
        <ul className="tm-stack">
          {center.projectIds.map((assigned) => (
            <li key={assigned} className="tm-row tm-row--between">
              <span>{assigned}</span>
              <Button
                type="button"
                tone="text"
                size="accessible"
                loading={unassign.isPending}
                loadingLabel={t('CostCentersView.removing')}
                onClick={() => unassign.mutate(assigned)}
              >
                {t('CostCentersView.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {remove.isError ? (
        <InlineAlert tone="danger" title={t('CostCentersView.deleteError')} live>
          {describeError(remove.error)}
        </InlineAlert>
      ) : null}
      {assign.isError ? (
        <InlineAlert tone="danger" title={t('CostCentersView.assignError')} live>
          {describeError(assign.error)}
        </InlineAlert>
      ) : null}
      {unassign.isError ? (
        <InlineAlert tone="danger" title={t('CostCentersView.unassignError')} live>
          {describeError(unassign.error)}
        </InlineAlert>
      ) : null}

      <form
        className="tm-row"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canAssign) assign.mutate();
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={inputId}>
            {t('CostCentersView.assignLabel')}
          </label>
          <input
            id={inputId}
            className="tm-field__control"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder={t('CostCentersView.projectIdPlaceholder')}
          />
        </div>
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          loading={assign.isPending}
          loadingLabel={t('CostCentersView.assigning')}
          disabled={!canAssign}
        >
          {t('CostCentersView.assign')}
        </Button>
      </form>
    </article>
  );
}
