'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CAPABILITIES } from '@tmanage/domain';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { readCustomRoles } from '../../lib/api/admin-roles';
import { cloneCustomRole, editCustomRole } from '../../lib/api/admin-role-edit';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface RoleEditScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Custom role clone + edit (Administration module 18, x195).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration (roles). Distinct from x173's create/list screen: this screen
 * operates on an **existing** role chosen from the list — edit its name and capability subset in place,
 * or clone it under a new name. It stays a faithful reader of the API: the capabilities offered are
 * exactly the domain's `CAPABILITIES`, and the API is the sole enforcer of the privilege-escalation
 * boundary — a save or clone that would grant beyond the caller is refused server-side (403) and shown
 * here as an error; this screen never decides what may be granted.
 */
export function RoleEditScreen({
  organizationSlug,
  organizationName,
  client,
}: RoleEditScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const roles = useQuery({
    queryKey: ['admin-roles', organizationSlug],
    queryFn: () => readCustomRoles(api, organizationSlug),
  });

  const rows = useMemo(() => roles.data?.roles ?? [], [roles.data]);

  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [cloneName, setCloneName] = useState('');
  const [saved, setSaved] = useState(false);
  const [cloned, setCloned] = useState(false);

  const current = rows.find((role) => role.id === selectedId);

  // When the list first loads, or the chosen role changes, prime the edit form from that role in one
  // pass: select the first role when none is chosen yet, and mirror the selected role's name and
  // capability subset into the controlled fields. Runs only on a selection or list change, never on an
  // in-progress edit (name/selected are not dependencies), so typing is never clobbered.
  useEffect(() => {
    const first = rows[0];
    if (!first) return;
    const target = rows.find((role) => role.id === selectedId) ?? first;
    if (target.id !== selectedId) setSelectedId(target.id);
    setName(target.name);
    setSelected(new Set(target.capabilities));
  }, [selectedId, rows]);

  const save = useMutation({
    mutationFn: () =>
      editCustomRole(api, organizationSlug, selectedId, { name, capabilities: [...selected] }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['admin-roles', organizationSlug] });
    },
  });

  const clone = useMutation({
    mutationFn: () => cloneCustomRole(api, organizationSlug, selectedId, { name: cloneName }),
    onSuccess: async () => {
      setCloned(true);
      setCloneName('');
      await queryClient.invalidateQueries({ queryKey: ['admin-roles', organizationSlug] });
    },
  });

  function toggle(capability: string): void {
    setSelected((currentSet) => {
      const next = new Set(currentSet);
      if (next.has(capability)) next.delete(capability);
      else next.add(capability);
      return next;
    });
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Edit a role"
      description="Edit an existing role's name and capabilities, or clone it under a new name. A role can only grant what you hold yourself."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-role-edit-heading">
        <h2 id="tm-role-edit-heading" className="tm-eyebrow">
          Choose a role
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
            No custom roles have been defined, so there is nothing to edit or clone.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <Select
            label="Role"
            name="role"
            value={selectedId}
            onChange={(event) => {
              setSaved(false);
              setCloned(false);
              setSelectedId(event.target.value);
            }}
            hint="Pick the role to edit or clone."
          >
            {rows.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        ) : null}
      </section>

      {current ? (
        <>
          <section className="tm-panel tm-stack" aria-labelledby="tm-role-edit-form-heading">
            <h2 id="tm-role-edit-form-heading" className="tm-eyebrow">
              Edit role
            </h2>

            <form
              className="tm-stack"
              noValidate
              aria-label="Edit the role"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                setSaved(false);
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
                <InlineAlert tone="danger" title="Could not save the role" live>
                  {describeError(save.error)}
                </InlineAlert>
              ) : null}
              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title="Role saved" live>
                  The role has been updated for your organization.
                </InlineAlert>
              ) : null}

              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={save.isPending}
                  loadingLabel="Saving"
                >
                  Save changes
                </Button>
              </div>
            </form>
          </section>

          <section className="tm-panel tm-stack" aria-labelledby="tm-role-clone-heading">
            <h2 id="tm-role-clone-heading" className="tm-eyebrow">
              Clone role
            </h2>

            <form
              className="tm-stack"
              noValidate
              aria-label="Clone the role"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                setCloned(false);
                if (!clone.isPending) clone.mutate();
              }}
            >
              <Field
                label="New role name"
                name="clone-name"
                value={cloneName}
                onChange={(event) => setCloneName(event.target.value)}
                hint="The clone copies this role's capabilities under a new, unique name."
              />

              {clone.isError ? (
                <InlineAlert tone="danger" title="Could not clone the role" live>
                  {describeError(clone.error)}
                </InlineAlert>
              ) : null}
              {cloned && !clone.isPending && !clone.isError ? (
                <InlineAlert tone="success" title="Role cloned" live>
                  A copy of the role has been created for your organization.
                </InlineAlert>
              ) : null}

              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={clone.isPending}
                  loadingLabel="Cloning"
                >
                  Clone role
                </Button>
              </div>
            </form>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
