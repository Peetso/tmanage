'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { createCustomRole, readCustomRoles } from '../../lib/api/admin-roles';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { CAPABILITIES_BY_AREA, capabilityLabel } from '../../lib/capability-labels';

export interface AdminRolesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Custom roles (Administration module 18, x173)** — drawn in ADM-02's language: the section map
 * on the left, a table card of the organization's roles, and an aside card that defines a new one.
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
 * - **A role is created here, edited on the role editor.** Renaming and changing capabilities is
 *   ADM-03 (`/admin/roles/edit`); there is no delete path yet.
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
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="roles"
      crumbs={['Roles']}
      title={
        rows.length > 0 ? `${rows.length} custom ${rows.length === 1 ? 'role' : 'roles'}` : 'Roles'
      }
      titleMeta="A role can only grant what you hold yourself"
      {...(rows.length > 0
        ? {
            actions: (
              <Link
                href={`/${organizationSlug}/admin/roles/edit`}
                className="tm-button tm-button--outline tm-button--compact"
              >
                Edit a role
              </Link>
            ),
          }
        : {})}
      rail="sections"
    >
      <div className="tm-cc-split">
        <section className="tm-cc-column" aria-labelledby="tm-admin-roles-heading">
          <h2 id="tm-admin-roles-heading" className="tm-visually-hidden">
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
            <div className="tm-cc-card tm-cc-card--quiet">
              <p className="tm-cc-card__title">No custom roles yet</p>
              <p className="tm-cc-card__body">
                No custom roles have been defined. Create one with the New role form.
              </p>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div className="tm-cc-card tm-cc-card--flush">
              <table className="tm-table tm-cc-table" aria-label="Custom roles">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Capabilities</th>
                    <th scope="col" className="tm-cc-end">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((role) => (
                    <tr key={role.id}>
                      <td>
                        <strong className="tm-cc-cell-title">{role.name}</strong>
                        <span className="tm-cc-cell-sub">
                          {role.capabilities.slice(0, 3).map(capabilityLabel).join(' · ')}
                          {role.capabilities.length > 3 ? ' …' : ''}
                        </span>
                      </td>
                      <td>
                        <span className="tm-cc-pill">
                          {role.capabilities.length} capabilit
                          {role.capabilities.length === 1 ? 'y' : 'ies'}
                        </span>
                      </td>
                      <td className="tm-cc-end">
                        <span className="tm-cc-cell-mono">{formatDay(role.createdAt)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="tm-cc-card" aria-labelledby="tm-admin-roles-new-heading">
          <p className="tm-cc-eyebrow">New role</p>
          <h2 id="tm-admin-roles-new-heading" className="tm-cc-card__title">
            What this role can actually reach
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

            <fieldset className="tm-cc-matrix tm-cc-card tm-cc-card--flush">
              <legend className="tm-visually-hidden">Capabilities</legend>
              <div className="tm-cc-matrix__head" aria-hidden="true">
                <span>Capability</span>
                <span>{selected.size} chosen</span>
              </div>
              <ul className="tm-cc-matrix__list">
                {CAPABILITIES_BY_AREA.map((capability) => (
                  <li key={capability}>
                    <Checkbox
                      label={capabilityLabel(capability)}
                      name={`capability-${capability}`}
                      checked={selected.has(capability)}
                      onChange={() => toggle(capability)}
                    />
                  </li>
                ))}
              </ul>
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
      </div>
    </ControlCenterShell>
  );
}

function formatDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
