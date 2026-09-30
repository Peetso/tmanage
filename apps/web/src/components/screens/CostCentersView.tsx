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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
  const api = client ?? browserApiClient();
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
      title="Cost centers"
      description="Name cost centers and assign projects to them, to group usage by cost center."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-cost-center-new-heading">
        <h2 id="tm-cost-center-new-heading" className="tm-eyebrow">
          New cost center
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
            label="Code"
            name="code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            hint="A short identifier, up to 64 characters."
            maxLength={64}
            required
          />
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="The display name for this cost center."
            maxLength={190}
            required
          />

          {create.isError ? (
            <InlineAlert tone="danger" title="Could not create the cost center" live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel="Creating"
              disabled={!canCreate}
            >
              Create cost center
            </Button>
          </div>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-cost-center-list-heading"
      >
        <h2 id="tm-cost-center-list-heading" className="tm-eyebrow">
          Cost centers
        </h2>

        {costCenters.isError ? (
          <InlineAlert tone="danger" title="Could not load the cost centers" live>
            {describeError(costCenters.error)}
          </InlineAlert>
        ) : null}

        {costCenters.isPending ? (
          <LoadingRegion label="Loading the cost centers.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!costCenters.isPending && !costCenters.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No cost centers yet">
            Create a cost center above, then assign projects to it.
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
    <article className="tm-panel tm-stack" aria-label={`Cost center ${center.name}`}>
      <div className="tm-row tm-row--between">
        <h3 className="tm-heading-sm">
          {center.name} <span className="tm-muted">({center.code})</span>
        </h3>
        <Button
          type="button"
          tone="destructive"
          size="accessible"
          loading={remove.isPending}
          loadingLabel="Deleting"
          onClick={() => remove.mutate()}
        >
          Delete
        </Button>
      </div>

      {center.projectIds.length === 0 ? (
        <p className="tm-muted">No projects assigned.</p>
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
                loadingLabel="Removing"
                onClick={() => unassign.mutate(assigned)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {remove.isError ? (
        <InlineAlert tone="danger" title="Could not delete the cost center" live>
          {describeError(remove.error)}
        </InlineAlert>
      ) : null}
      {assign.isError ? (
        <InlineAlert tone="danger" title="Could not assign the project" live>
          {describeError(assign.error)}
        </InlineAlert>
      ) : null}
      {unassign.isError ? (
        <InlineAlert tone="danger" title="Could not remove the assignment" live>
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
            Assign a project
          </label>
          <input
            id={inputId}
            className="tm-field__control"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="Project id"
          />
        </div>
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          loading={assign.isPending}
          loadingLabel="Assigning"
          disabled={!canAssign}
        >
          Assign
        </Button>
      </form>
    </article>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
