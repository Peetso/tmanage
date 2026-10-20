'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { readCustomRoles } from '../../lib/api/admin-roles';
import { cloneCustomRole, editCustomRole } from '../../lib/api/admin-role-edit';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { CAPABILITIES_BY_AREA, capabilityLabel } from '../../lib/capability-labels';

export interface RoleEditScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const FORM_ID = 'tm-role-edit-form';

/**
 * **Role editor** — ADM-03 "Permission matrix + effect preview" (custom role clone + edit, x195).
 *
 * The left column lists the organization's custom roles (the frame's role list); the chosen one is
 * edited in the centre — its name and a capability matrix over the fixed `CAPABILITIES` allowlist,
 * with every row that differs from the saved role marked — and the aside previews the effect of the
 * edit (what it grants and removes) and offers the clone. Save and Discard sit in the header as the
 * frame draws them; Save submits the edit form.
 *
 * It is a faithful reader of the API: an edit PUTs the name and capability subset, a clone POSTs a new
 * name, and the server validates both against its allowlist and refuses to let a role widen past the
 * caller (the privilege-escalation boundary is the server's; this screen only presents it).
 */
export function RoleEditScreen({
  organizationSlug,
  organizationName,
  client,
}: RoleEditScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

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

  // Default to the first role, and re-prime the form whenever the chosen role (or its saved copy)
  // changes, so the fields always start from what the API holds.
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

  function discard(): void {
    if (!current) return;
    setSaved(false);
    setName(current.name);
    setSelected(new Set(current.capabilities));
  }

  const savedSet = useMemo(() => new Set(current?.capabilities ?? []), [current]);
  const granted = [...selected].filter((capability) => !savedSet.has(capability));
  const removed = [...savedSet].filter((capability) => !selected.has(capability));
  const renamed = current !== undefined && name.trim() !== current.name;
  const changeCount = granted.length + removed.length + (renamed ? 1 : 0);

  // Drawn by ControlCenterShell inside the section map, under its groups.
  const rail = (
    <div>
      <p className="tm-cc-sections__label" id="tm-role-edit-list">
        {t('RoleEditScreen.roles')}
      </p>
      {rows.length > 0 ? (
        <ul className="tm-cc-sections__group" aria-labelledby="tm-role-edit-list">
          {rows.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                className="tm-cc-sections__item"
                aria-pressed={role.id === selectedId}
                onClick={() => {
                  setSaved(false);
                  setCloned(false);
                  setSelectedId(role.id);
                }}
              >
                {role.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Link
        href={`/${organizationSlug}/admin/roles`}
        className="tm-cc-sections__item tm-cc-sections__new"
      >
        {t('RoleEditScreen.newRole')}
      </Link>
    </div>
  );

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="roles"
      crumbs={current ? [t('RoleEditScreen.roles'), current.name] : [t('RoleEditScreen.roles')]}
      title={current?.name ?? t('RoleEditScreen.roleEditor')}
      description={t('RoleEditScreen.description')}
      {...(current
        ? {
            actions: (
              <>
                <Button
                  type="button"
                  tone="outline"
                  size="compact"
                  onClick={discard}
                  disabled={changeCount === 0 || save.isPending}
                >
                  {t('RoleEditScreen.discard')}
                </Button>
                <Button
                  type="submit"
                  form={FORM_ID}
                  tone="ink"
                  size="compact"
                  loading={save.isPending}
                  loadingLabel={t('RoleEditScreen.saving')}
                >
                  {t('RoleEditScreen.saveChanges')}
                </Button>
              </>
            ),
          }
        : {})}
      rail={rail}
    >
      {roles.isError ? (
        <InlineAlert tone="danger" title={t('RoleEditScreen.loadFailed')} live>
          {describeError(roles.error)}
        </InlineAlert>
      ) : null}

      {roles.isPending ? (
        <LoadingRegion label={t('RoleEditScreen.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!roles.isPending && !roles.isError && rows.length === 0 ? (
        <div className="tm-cc-card tm-cc-card--quiet">
          <p className="tm-cc-card__title">{t('RoleEditScreen.emptyTitle')}</p>
          <p className="tm-cc-card__body">{t('RoleEditScreen.emptyBody')}</p>
        </div>
      ) : null}

      {current ? (
        <div className="tm-cc-split">
          <section className="tm-cc-column" aria-labelledby="tm-role-edit-form-heading">
            <h2 id="tm-role-edit-form-heading" className="tm-visually-hidden">
              {t('RoleEditScreen.editRole')}
            </h2>

            <form
              id={FORM_ID}
              className="tm-stack"
              noValidate
              aria-label={t('RoleEditScreen.editTheRole')}
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                setSaved(false);
                if (!save.isPending) save.mutate();
              }}
            >
              <Field
                label={t('RoleEditScreen.roleName')}
                name="role-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                hint={t('RoleEditScreen.roleNameHint')}
              />

              <fieldset className="tm-cc-matrix tm-cc-card tm-cc-card--flush">
                <legend className="tm-visually-hidden">{t('RoleEditScreen.capabilities')}</legend>
                <div className="tm-cc-matrix__head" aria-hidden="true">
                  <span>{t('RoleEditScreen.capability')}</span>
                  <span>{t('RoleEditScreen.granted')}</span>
                </div>
                <ul className="tm-cc-matrix__list">
                  {CAPABILITIES_BY_AREA.map((capability) => (
                    <li
                      key={capability}
                      data-changed={
                        selected.has(capability) !== savedSet.has(capability) ? 'true' : undefined
                      }
                    >
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
              <p className="tm-cc-note">{t('RoleEditScreen.matrixNote')}</p>

              {save.isError ? (
                <InlineAlert tone="danger" title={t('RoleEditScreen.saveFailed')} live>
                  {describeError(save.error)}
                </InlineAlert>
              ) : null}
              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title={t('RoleEditScreen.savedTitle')} live>
                  {t('RoleEditScreen.savedBody')}
                </InlineAlert>
              ) : null}
            </form>
          </section>

          <div className="tm-cc-column">
            <section
              className="tm-cc-card tm-cc-card--ink"
              aria-labelledby="tm-role-edit-effect-heading"
            >
              <p className="tm-cc-eyebrow">{t('RoleEditScreen.effectEyebrow')}</p>
              <h2 id="tm-role-edit-effect-heading" className="tm-cc-card__lead">
                {changeCount === 0
                  ? `Nothing changes yet for anyone holding ${current.name}.`
                  : `Everyone holding ${current.name} ${describeEffect(granted.length, removed.length, renamed)}.`}
              </h2>
              {granted.length > 0 ? (
                <p className="tm-cc-card__body">
                  {t('RoleEditScreen.gainsPrefix')}
                  {granted.map(capabilityLabel).join(', ')}
                </p>
              ) : null}
              {removed.length > 0 ? (
                <p className="tm-cc-card__body">
                  {t('RoleEditScreen.losesPrefix')}
                  {removed.map(capabilityLabel).join(', ')}
                </p>
              ) : null}
              {renamed ? (
                <p className="tm-cc-card__body">
                  {t('RoleEditScreen.renamedPrefix')}
                  {current.name}
                  {t('RoleEditScreen.renamedMiddle')}
                  {name.trim() || t('RoleEditScreen.emptyName')}
                </p>
              ) : null}
            </section>

            <section className="tm-cc-card" aria-labelledby="tm-role-clone-heading">
              <h2 id="tm-role-clone-heading" className="tm-cc-card__title">
                {t('RoleEditScreen.cloneRole')}
              </h2>

              <form
                className="tm-stack"
                noValidate
                aria-label={t('RoleEditScreen.cloneForm')}
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  setCloned(false);
                  if (!clone.isPending) clone.mutate();
                }}
              >
                <Field
                  label={t('RoleEditScreen.newRoleName')}
                  name="clone-name"
                  value={cloneName}
                  onChange={(event) => setCloneName(event.target.value)}
                  hint={t('RoleEditScreen.cloneHint')}
                />

                {clone.isError ? (
                  <InlineAlert tone="danger" title={t('RoleEditScreen.cloneFailed')} live>
                    {describeError(clone.error)}
                  </InlineAlert>
                ) : null}
                {cloned && !clone.isPending && !clone.isError ? (
                  <InlineAlert tone="success" title={t('RoleEditScreen.clonedTitle')} live>
                    {t('RoleEditScreen.clonedBody')}
                  </InlineAlert>
                ) : null}

                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="outline"
                    size="accessible"
                    loading={clone.isPending}
                    loadingLabel={t('RoleEditScreen.cloning')}
                  >
                    {t('RoleEditScreen.cloneRole')}
                  </Button>
                </div>
              </form>
            </section>
          </div>
        </div>
      ) : null}
    </ControlCenterShell>
  );
}

/** "gains 2 capabilities and loses 1" — the effect card's sentence. */
function describeEffect(gains: number, losses: number, renamed: boolean): string {
  const parts: string[] = [];
  if (gains > 0) parts.push(`gains ${gains} ${gains === 1 ? 'capability' : 'capabilities'}`);
  if (losses > 0) parts.push(`loses ${losses} ${losses === 1 ? 'capability' : 'capabilities'}`);
  if (renamed) parts.push('sees the role under a new name');
  return parts.join(' and ');
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
