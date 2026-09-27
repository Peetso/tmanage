'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CAPABILITIES } from '@tmanage/domain';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { createCustomRole, readCustomRoles } from '../../lib/api/admin-roles';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AdminRolesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Custom roles (Administration module 18, x173).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration (roles). This screen lists the organization's custom roles and
 * defines a new one — a name plus a subset of the fixed capability allowlist. It is a faithful reader of
 * the API: the capabilities offered are exactly the domain's `CAPABILITIES`, and a create POSTs a name
 * and the chosen subset, which the API validates against its allowlist and refuses to let widen past the
 * caller (the privilege-escalation boundary lives on the server; this screen only presents it).
 *
 * ## What it does, and what it cannot
 *
 * - **It never invents a capability.** The picker is the fixed allowlist; the API rejects anything else.
 * - **A role is created, not edited or removed here.** The API grants no update or delete path yet, so
 *   there is no rename or delete control — those are later slices.
 */
export function AdminRolesScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminRolesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const roles = useQuery({
    queryKey: ['admin-roles', organizationSlug],
    queryFn: () => readCustomRoles(api, organizationSlug),
  });

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [created, setCreated] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      createCustomRole(api, organizationSlug, { name, capabilities: [...selected] }),
    onSuccess: async () => {
      setCreated(true);
      setName('');
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ['admin-roles', organizationSlug] });
    },
  });

  function toggle(capability: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(capability)) next.delete(capability);
      else next.add(capability);
      return next;
    });
  }

  const rows = roles.data?.roles ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Custom roles"
      description="Define a role and the capabilities it grants. A role can only grant what you hold yourself."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-admin-roles-heading">
        <h2 id="tm-admin-roles-heading" className="tm-eyebrow">
          Roles
        </h2>

        {roles.isError ? (
          <InlineAlert tone="danger" title="Could not load the roles" live>
            {describeError(roles.error)}
          </InlineAlert>
        ) : null}

        {roles.isPending ? (
          <LoadingRegion label="Loading the roles.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!roles.isPending && !roles.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No custom roles yet">
            No custom roles have been defined. Create one below.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-stack" aria-label="Custom roles">
            {rows.map((role) => (
              <li key={role.id} className="tm-row">
                <strong>{role.name}</strong>
                <span>
                  {role.capabilities.length} capabilit
                  {role.capabilities.length === 1 ? 'y' : 'ies'}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-admin-roles-new-heading">
        <h2 id="tm-admin-roles-new-heading" className="tm-eyebrow">
          New role
        </h2>

        <form
          className="tm-stack"
          noValidate
          aria-label="Create a custom role"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setCreated(false);
            if (!save.isPending) save.mutate();
          }}
        >
          <Field
            label="Role name"
            name="role-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="A short name for the role, unique within your organization."
          />

          <fieldset className="tm-stack tm-fieldset">
            <legend>Capabilities</legend>
            {CAPABILITIES.map((capability) => (
              <Checkbox
                key={capability}
                label={capability}
                name={`capability-${capability}`}
                checked={selected.has(capability)}
                onChange={() => toggle(capability)}
              />
            ))}
          </fieldset>

          {save.isError ? (
            <InlineAlert tone="danger" title="Could not create the role" live>
              {describeError(save.error)}
            </InlineAlert>
          ) : null}
          {created && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title="Role created" live>
              The role has been created for your organization.
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel="Creating"
            >
              Create role
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
