'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, Radio, RadioGroup, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import { listPlatformCompanies } from '../../../lib/api/platform-admin';
import {
  fetchPlatformEffectivePermissions,
  fetchPlatformOrgRoles,
} from '../../../lib/api/platform-permissions';
import {
  addPlatformPersonToOrganization,
  changePlatformMemberRole,
  fetchPlatformPersonOrganizations,
  offboardPlatformMember,
} from '../../../lib/api/platform-people';
import type {
  PlatformPersonDetailView,
  PlatformPersonMembershipView,
} from '../../../lib/api/platform-people';
import { useT } from '../../../lib/i18n/use-t';
import { EffectivePermissionsPanel } from '../../permissions/EffectivePermissionsPanel';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import {
  PlatformDialog,
  PlatformDialogActions,
  REASON_MAX,
  ReasonDialog,
  platformErrorText,
} from '../shared/ReasonDialog';
import { firstNameOf } from './people-format';
import { PersonFrame, roleName } from './PersonFrame';
import type { PersonScreenContext } from './PersonFrame';

type T = ReturnType<typeof useT>;

/** The roles an operator can give from B4 (owner moves only through Transfer ownership). */
const ASSIGNABLE = [
  'org_admin',
  'workspace_admin',
  'manager',
  'moderator',
  'member',
  'guest',
] as const;

/** The add dialog's drawn list: Org admin, Manager, Member, Guest, then the custom roles. */
const ADD_ROLES = ['org_admin', 'manager', 'member', 'guest'] as const;

/**
 * B4 · Organizations & permissions — `/platform/people/:userId/organizations` (435:18389, drawer
 * 435:18634, add dialog 435:18983). One card per membership: audience, status, scope, overrides,
 * the role select (PA-07), Edit overrides (PA-04's D8), "What can she do?" (the PA-04 panel
 * computed by the real authorize()), Make owner / Offboard.
 */
export function PersonOrganizationsScreen({ client, userId }: ScreenProps & { userId: string }) {
  const api = client ?? browserApiClient();
  return (
    <PersonFrame api={api} userId={userId} tab="organizations">
      {(context) => <OrganizationsBody {...context} />}
    </PersonFrame>
  );
}

type Pending =
  | { kind: 'role'; membership: PlatformPersonMembershipView; role: string }
  | { kind: 'offboard'; membership: PlatformPersonMembershipView }
  | { kind: 'drawer'; membership: PlatformPersonMembershipView }
  | { kind: 'add' }
  | null;

function OrganizationsBody({ api, me, person, refresh }: PersonScreenContext) {
  const t = useT();
  const [pending, setPending] = useState<Pending>(null);
  const canRoles = me.permissions.includes('platform.people.roles');
  const first = firstNameOf(person.displayName);
  const organizations = useQuery({
    queryKey: ['platform', 'people', 'organizations', person.id],
    queryFn: () => fetchPlatformPersonOrganizations(api, person.id),
  });
  const reload = async () => {
    await Promise.all([organizations.refetch(), refresh()]);
  };

  return (
    <div className="tm-stack">
      <div className="tm-cc-card__head">
        <div>
          <h3 className="tm-cc-card__title">{t('PlatformPeople.rolesTitle')}</h3>
          <p className="tm-cc-note">{t('PlatformPeople.rolesLead')}</p>
        </div>
        {canRoles ? (
          <Button type="button" tone="ink" onClick={() => setPending({ kind: 'add' })}>
            {t('PlatformPeople.addToOrganization')}
          </Button>
        ) : null}
      </div>

      {organizations.isPending ? (
        <PlatformPageState
          state="loading"
          loadingLabel={t('PlatformPeople.loadingOrganizations')}
        />
      ) : organizations.isError ? (
        <PlatformPageState
          state="error"
          error={organizations.error}
          onRetry={() => void organizations.refetch()}
        />
      ) : organizations.data.memberships.length === 0 ? (
        <section className="tm-cc-card tm-stack">
          <p className="tm-cc-eyebrow">{t('PlatformPeople.noOrganizationsEyebrow')}</p>
          <p className="tm-cc-note">{t('PlatformPeople.noOrganizations')}</p>
        </section>
      ) : (
        <div className="tm-stack">
          {organizations.data.memberships.map((membership) => (
            <MembershipCard
              key={membership.membershipId}
              membership={membership}
              first={first}
              canRoles={canRoles}
              t={t}
              onRole={(role) => setPending({ kind: 'role', membership, role })}
              onOffboard={() => setPending({ kind: 'offboard', membership })}
              onExplain={() => setPending({ kind: 'drawer', membership })}
            />
          ))}
        </div>
      )}

      {pending?.kind === 'role' ? (
        <ReasonDialog
          title={`${t('PlatformPeople.changeRoleTitle')} ${roleName(t, pending.role, null)}?`}
          body={`${first} · ${pending.membership.organizationName}. ${t('PlatformPeople.changeRoleBody')}`}
          reasonRequired={false}
          confirmLabel={t('PlatformPeople.changeRole')}
          onConfirm={async (reason) => {
            await changePlatformMemberRole(
              api,
              pending.membership.organizationId,
              pending.membership.membershipId,
              pending.role,
              reason,
            );
            await reload();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === 'offboard' ? (
        <ReasonDialog
          title={`${t('PlatformPeople.offboardTitle')} ${first} ${t('PlatformPeople.from')} ${pending.membership.organizationName}?`}
          body={t('PlatformPeople.offboardBody')}
          reasonRequired
          destructive
          confirmLabel={t('PlatformPeople.offboard')}
          onConfirm={async (reason) => {
            await offboardPlatformMember(
              api,
              pending.membership.organizationId,
              pending.membership.membershipId,
              reason ?? '',
            );
            await reload();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === 'drawer' ? (
        <PermissionsDrawer
          api={api}
          membership={pending.membership}
          first={first}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === 'add' ? (
        <AddToOrganizationDialog
          api={api}
          person={person}
          existing={organizations.data?.memberships ?? []}
          onDone={async () => {
            setPending(null);
            await reload();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

function MembershipCard({
  membership,
  first,
  canRoles,
  t,
  onRole,
  onOffboard,
  onExplain,
}: {
  membership: PlatformPersonMembershipView;
  first: string;
  canRoles: boolean;
  t: T;
  onRole: (role: string) => void;
  onOffboard: () => void;
  onExplain: () => void;
}) {
  const suspended = membership.organizationStatus !== 'active';
  const client = membership.audience === 'client';
  const overridesHref = `/platform/organizations/${membership.organizationId}/members/${membership.membershipId}/permissions`;
  const overrides = membership.overridesAllow + membership.overridesDeny;
  const scope =
    membership.scope === 'org_wide'
      ? t('PlatformPeople.scopeOrgWide')
      : client
        ? `${t('PlatformPeople.scopeShared')} (${membership.projects})`
        : `${t('PlatformPeople.scopeAssigned')} (${membership.projects})`;
  const overridesLine = membership.isOwner
    ? t('PlatformPeople.overridesOwner')
    : client && overrides === 0
      ? t('PlatformPeople.overridesClient')
      : overrides === 0
        ? t('PlatformPeople.overridesNone')
        : `${overrides} ${t('PlatformPeople.overridesWord')} · ${membership.overridesAllow} ${t('PlatformPeople.allow')} · ${membership.overridesDeny} ${t('PlatformPeople.deny')}`;

  return (
    <section
      className="tm-cc-card tm-stack"
      aria-label={membership.organizationName}
      {...(suspended ? { 'data-muted': 'true', style: { opacity: 0.7 } } : {})}
    >
      <div className="tm-cc-card__head">
        <span className="tm-cc-card__actions">
          <h4 className="tm-cc-card__title">{membership.organizationName}</h4>
          <span className={`tm-cc-pill${client ? ' tm-cc-pill--client' : ''}`}>
            {client
              ? `${t('PlatformPeople.client')}${membership.clientOrganizationName ? ` · ${membership.clientOrganizationName}` : ''}`
              : t('PlatformPeople.internal')}
          </span>
          {suspended ? (
            <span className="tm-cc-pill tm-cc-pill--warning">
              {membership.organizationStatus === 'suspended'
                ? t('PlatformPeople.orgSuspended')
                : t('PlatformPeople.orgArchived')}
            </span>
          ) : null}
          <span className="tm-cc-pill tm-cc-pill--muted">{scope}</span>
        </span>
        <span className="tm-cc-note">{overridesLine}</span>
      </div>
      {suspended ? <p className="tm-cc-note">{t('PlatformPeople.suspendedNote')}</p> : null}
      <div className="tm-cc-setting">
        {membership.isOwner ? (
          <Select
            label={t('PlatformPeople.roleLabel')}
            value="owner"
            disabled
            hint={t('PlatformPeople.ownerHint')}
          >
            <option value="owner">{t('PlatformPeople.role.owner')}</option>
          </Select>
        ) : (
          <Select
            label={t('PlatformPeople.roleLabel')}
            value={membership.role}
            disabled={!canRoles || client}
            onChange={(event) => {
              if (event.target.value !== membership.role) onRole(event.target.value);
            }}
          >
            {[...new Set<string>([membership.role, ...ASSIGNABLE])].map((role) => (
              <option key={role} value={role}>
                {role === membership.role
                  ? roleName(t, role, membership.customRoleName)
                  : roleName(t, role, null)}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="tm-cc-card__actions">
        {membership.isOwner ? null : (
          <Link href={overridesHref} className="tm-cc-pill">
            {t('PlatformPeople.editOverrides')}
          </Link>
        )}
        <Button type="button" tone="outline" size="compact" onClick={onExplain}>
          {`${t('PlatformPeople.whatCan')} ${first} ${t('PlatformPeople.doQuestion')}`}
        </Button>
        {canRoles && !membership.isOwner && !client ? (
          <Button type="button" tone="text" size="compact" onClick={() => onRole('owner')}>
            {t('PlatformPeople.makeOwner')}
          </Button>
        ) : null}
        {canRoles && membership.isOwner ? (
          <Link
            href={`/platform/organizations/${membership.organizationId}`}
            className="tm-cc-pill"
          >
            {t('PlatformPeople.transferOwnership')}
          </Link>
        ) : null}
        {canRoles && !membership.isOwner ? (
          <Button type="button" tone="text" size="compact" onClick={onOffboard}>
            {t('PlatformPeople.offboard')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** B4 drawer (435:18634): read only, computed by the real authorize(); simulate on a project. */
function PermissionsDrawer({
  api,
  membership,
  first,
  onClose,
}: {
  api: PersonScreenContext['api'];
  membership: PlatformPersonMembershipView;
  first: string;
  onClose: () => void;
}) {
  const t = useT();
  const [projectId, setProjectId] = useState<string | null>(null);
  const effective = useQuery({
    queryKey: ['platform', 'people', 'effective', membership.membershipId, projectId],
    queryFn: () =>
      fetchPlatformEffectivePermissions(
        api,
        membership.organizationId,
        membership.membershipId,
        projectId ?? undefined,
      ),
  });
  return (
    <PlatformDialog
      eyebrow={t('PlatformPeople.drawerEyebrow')}
      title={`${t('PlatformPeople.whatCan')} ${first} ${t('PlatformPeople.doIn')} ${membership.organizationName}?`}
      width={880}
      onClose={onClose}
    >
      {effective.isPending ? (
        <PlatformPageState state="loading" loadingLabel={t('PlatformPeople.loadingPermissions')} />
      ) : effective.isError ? (
        <PlatformPageState
          state="error"
          error={effective.error}
          onRetry={() => void effective.refetch()}
        />
      ) : (
        <EffectivePermissionsPanel
          effective={effective.data.permissions}
          projectId={projectId}
          roleName={roleName(t, membership.role, membership.customRoleName)}
          onSimulate={(next) => setProjectId(next)}
        />
      )}
      <PlatformDialogActions>
        <Button type="button" tone="outline" onClick={onClose}>
          {t('PlatformPeople.close')}
        </Button>
        {membership.isOwner ? null : (
          <Link
            href={`/platform/organizations/${membership.organizationId}/members/${membership.membershipId}/permissions`}
            className="tm-button tm-button--ink tm-button--default"
          >
            {t('PlatformPeople.editOverrides')}
          </Link>
        )}
      </PlatformDialogActions>
    </PlatformDialog>
  );
}

/** B4 add dialog (435:18983): adds a membership directly, no invitation. */
function AddToOrganizationDialog({
  api,
  person,
  existing,
  onDone,
  onClose,
}: {
  api: PersonScreenContext['api'];
  person: PlatformPersonDetailView;
  existing: readonly PlatformPersonMembershipView[];
  onDone: () => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const [organizationId, setOrganizationId] = useState('');
  const [internal, setInternal] = useState(true);
  const [role, setRole] = useState<string>('member');
  const [reason, setReason] = useState('');
  const companies = useQuery({
    queryKey: ['platform', 'people', 'organization-options'],
    queryFn: () => listPlatformCompanies(api),
  });
  const roles = useQuery({
    queryKey: ['platform', 'people', 'org-roles', organizationId],
    queryFn: () => fetchPlatformOrgRoles(api, organizationId),
    enabled: organizationId !== '',
  });
  const taken = new Set(existing.map((membership) => membership.organizationId));
  const options = (companies.data ?? []).filter((company) => !taken.has(company.id));
  const chosen = options.find((company) => company.id === organizationId) ?? null;
  const custom = (roles.data?.roles ?? []).filter(
    (item) => !item.builtIn && item.kind === 'internal',
  );
  const add = useMutation({
    mutationFn: () =>
      addPlatformPersonToOrganization(api, organizationId, {
        email: person.email,
        role,
        reason: reason.trim() || null,
      }),
    onSuccess: () => onDone(),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (organizationId !== '' && internal) add.mutate();
  }

  return (
    <PlatformDialog
      eyebrow={t('PlatformPeople.addEyebrow')}
      title={`${t('PlatformPeople.addTitle')} ${person.displayName} ${t('PlatformPeople.addTitleEnd')}`}
      onClose={onClose}
    >
      <form className="tm-stack" onSubmit={submit} noValidate>
        <Select
          label={t('PlatformPeople.organization')}
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
        >
          <option value="">{t('PlatformPeople.chooseOrganization')}</option>
          {options.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </Select>
        <fieldset className="tm-stack tm-stack--tight">
          <legend className="tm-cc-field-label">{t('PlatformPeople.audience')}</legend>
          <Checkbox
            label={t('PlatformPeople.internalMember')}
            checked={internal}
            onChange={(event) => setInternal(event.target.checked)}
          />
          <Checkbox
            label={t('PlatformPeople.clientOf')}
            checked={false}
            disabled
            hint={t('PlatformPeople.clientOfHint')}
          />
        </fieldset>
        <RadioGroup legend={t('PlatformPeople.roleLabel')} name="pa06-add-role">
          <Radio
            value="owner"
            label={t('PlatformPeople.ownerUseTransfer')}
            checked={false}
            disabled
            readOnly
          />
          {ADD_ROLES.map((item) => (
            <Radio
              key={item}
              value={item}
              label={roleName(t, item, null)}
              checked={role === item}
              onChange={() => setRole(item)}
            />
          ))}
          {custom.map((item) => (
            <Radio
              key={item.id}
              value={item.id}
              label={roleName(t, item.id, item.name)}
              checked={role === item.id}
              onChange={() => setRole(item.id)}
            />
          ))}
        </RadioGroup>
        {chosen ? (
          <InlineAlert tone="neutral">{`${chosen.name}${t('PlatformPeople.addInfo')}`}</InlineAlert>
        ) : null}
        <Field
          label={t('PlatformPeople.reasonOptional')}
          placeholder={t('PlatformPeople.reasonPlaceholder')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={REASON_MAX}
        />
        {add.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(add.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={onClose}>
            {t('PlatformShared.cancel')}
          </Button>
          <Button
            type="submit"
            tone="ink"
            disabled={organizationId === '' || !internal}
            loading={add.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformPeople.addToOrganization')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
