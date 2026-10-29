'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  addPlatformOrgMember,
  changePlatformOrgMemberRole,
  fetchPlatformOrgMembers,
  offboardPlatformOrgMember,
  revokePlatformOrgInvitation,
} from '../../../lib/api/platform-organizations';
import type {
  PlatformOrgDetailView,
  PlatformOrgMemberView,
  PlatformOrgMembersView,
} from '../../../lib/api/platform-organizations';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import type { PlatformColumn } from '../shared/PlatformTable';
import type { ScreenProps } from '../shared/platform-kit';
import {
  PlatformDialog,
  PlatformDialogActions,
  platformErrorText,
  ReasonDialog,
} from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { formatDay, ORGS_KEY, orgKey, useRelative } from './org-kit';
import { OrgPage } from './OrgPage';

type SubTab = 'internal' | 'clients' | 'invitations';

/** A6 `/platform/organizations/[id]/members` — internal people, clients and invitations (frame A6). */
export function PlatformOrgMembersScreen({
  client,
  organizationId,
}: ScreenProps & { organizationId: string }) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <OrgPage
      api={api}
      organizationId={organizationId}
      tab="members"
      title={t('PlatformOrgs.tabMembers')}
    >
      {(detail) => <MembersBody api={api} detail={detail} />}
    </OrgPage>
  );
}

function MembersBody({ api, detail }: { api: ApiClient; detail: PlatformOrgDetailView }) {
  const t = useT();
  const id = detail.organization.id;
  const canEdit = usePlatformPermissions(api).has('platform.orgs.edit');
  const [tab, setTab] = useState<SubTab>('internal');
  const [adding, setAdding] = useState(false);
  const members = useQuery({
    queryKey: orgKey(id, 'members'),
    queryFn: () => fetchPlatformOrgMembers(api, id),
    retry: false,
  });
  const tabs: readonly { id: SubTab; label: string; count: number | undefined }[] = [
    { id: 'internal', label: t('PlatformOrgs.subInternal'), count: members.data?.internal.length },
    { id: 'clients', label: t('PlatformOrgs.subClients'), count: members.data?.clients.length },
    {
      id: 'invitations',
      label: t('PlatformOrgs.subInvitations'),
      count: members.data?.invitations.length,
    },
  ];
  return (
    <section className="tm-cc-card" aria-labelledby="tm-org-members">
      <div className="tm-cc-card__head">
        <h2 id="tm-org-members" className="tm-cc-card__title">
          {t('PlatformOrgs.tabMembers')}
        </h2>
        {canEdit ? (
          <Button type="button" tone="ink" size="compact" onClick={() => setAdding(true)}>
            {t('PlatformOrgs.addMember')}
          </Button>
        ) : null}
      </div>
      <div className="tm-chip-row" role="group" aria-label={t('PlatformOrgs.tabMembers')}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'tm-chip tm-chip--active' : 'tm-chip'}
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.count !== undefined ? ` ${item.count}` : ''}
          </button>
        ))}
        <Link className="tm-chip" href={`/platform/organizations/${id}/roles`}>
          {t('PlatformOrgs.subRoles')}
        </Link>
      </div>
      {members.isPending ? <PlatformPageState state="loading" /> : null}
      {members.isError ? (
        <PlatformPageState
          state="error"
          error={members.error}
          onRetry={() => void members.refetch()}
        />
      ) : null}
      {members.isSuccess && tab === 'internal' ? (
        <InternalTable api={api} id={id} view={members.data} />
      ) : null}
      {members.isSuccess && tab === 'clients' ? <ClientsTable view={members.data} /> : null}
      {members.isSuccess && tab === 'invitations' ? (
        <InvitationsTable api={api} id={id} view={members.data} />
      ) : null}
      {adding && members.data ? (
        <AddMemberDialog
          api={api}
          id={id}
          roles={members.data.roles}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </section>
  );
}

function InternalTable({
  api,
  id,
  view,
}: {
  api: ApiClient;
  id: string;
  view: PlatformOrgMembersView;
}) {
  const t = useT();
  const relative = useRelative();
  const queryClient = useQueryClient();
  const canEdit = usePlatformPermissions(api).has('platform.orgs.edit');
  const [offboarding, setOffboarding] = useState<PlatformOrgMemberView | null>(null);
  const role = useMutation({
    mutationFn: (input: { membershipId: string; role: string }) =>
      changePlatformOrgMemberRole(api, id, input.membershipId, input.role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ORGS_KEY }),
  });
  const columns: readonly PlatformColumn<PlatformOrgMemberView>[] = [
    {
      id: 'person',
      header: t('PlatformOrgs.colPerson'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <span className="tm-cc-cell-title">{row.displayName}</span>
          <span className="tm-cc-cell-mono">{row.email}</span>
        </div>
      ),
    },
    {
      id: 'role',
      header: t('PlatformOrgs.colRole'),
      cell: (row) =>
        row.role === 'owner' || !canEdit ? (
          <span className="tm-chip">
            {row.role}
            {row.role === 'owner' ? ` · ${t('PlatformOrgs.locked')}` : ''}
          </span>
        ) : (
          <Select
            label={`${t('PlatformOrgs.colRole')} · ${row.displayName}`}
            value={row.role}
            disabled={role.isPending}
            onChange={(e) => role.mutate({ membershipId: row.membershipId, role: e.target.value })}
          >
            {view.roles.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        ),
    },
    { id: 'status', header: t('PlatformOrgs.colStatus'), cell: (row) => row.status },
    {
      id: 'signin',
      header: t('PlatformOrgs.colLastSignIn'),
      cell: (row) => relative(row.lastSignInAt),
    },
    {
      id: 'mfa',
      header: t('PlatformOrgs.colTwoStep'),
      cell: (row) => (row.mfaEnabled ? t('PlatformOrgs.on') : t('PlatformOrgs.off')),
    },
    {
      id: 'overrides',
      header: t('PlatformOrgs.colOverrides'),
      cell: (row) => (
        <Link href={`/platform/organizations/${id}/members/${row.membershipId}/permissions`}>
          {row.overrides > 0
            ? `${row.overrides} ${t('PlatformOrgs.overridesWord')}`
            : t('PlatformOrgs.permissions')}
        </Link>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: (row) =>
        canEdit && row.role !== 'owner' && row.status !== 'offboarded' ? (
          <Button type="button" tone="text" size="compact" onClick={() => setOffboarding(row)}>
            {t('PlatformOrgs.offboard')}
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      {role.isError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(role.error, t)}
        </InlineAlert>
      ) : null}
      {view.internal.length === 0 ? (
        <p className="tm-cc-note">{t('PlatformOrgs.noMembers')}</p>
      ) : (
        <PlatformTable
          label={t('PlatformOrgs.subInternal')}
          columns={columns}
          rows={view.internal}
          rowKey={(row) => row.membershipId}
          isMuted={(row) => row.status !== 'active'}
        />
      )}
      {offboarding ? (
        <ReasonDialog
          title={`${t('PlatformOrgs.offboard')} ${offboarding.displayName}`}
          body={t('PlatformOrgs.offboardBody')}
          reasonRequired
          destructive
          confirmLabel={t('PlatformOrgs.offboard')}
          onConfirm={(reason) =>
            offboardPlatformOrgMember(api, id, offboarding.membershipId, reason ?? '')
          }
          onClose={(done) => {
            setOffboarding(null);
            if (done) void queryClient.invalidateQueries({ queryKey: ORGS_KEY });
          }}
        />
      ) : null}
    </>
  );
}

function ClientsTable({ view }: { view: PlatformOrgMembersView }) {
  const t = useT();
  type Row = PlatformOrgMembersView['clients'][number];
  const columns: readonly PlatformColumn<Row>[] = [
    {
      id: 'person',
      header: t('PlatformOrgs.colPerson'),
      cell: (row) => (
        <div className="tm-stack tm-stack--tight">
          <span className="tm-cc-cell-title">{row.displayName}</span>
          <span className="tm-cc-cell-mono">{row.email}</span>
        </div>
      ),
    },
    { id: 'client', header: t('PlatformOrgs.colClient'), cell: (row) => row.clientName ?? '—' },
    { id: 'role', header: t('PlatformOrgs.colRole'), cell: (row) => row.role },
    { id: 'status', header: t('PlatformOrgs.colStatus'), cell: (row) => row.status },
  ];
  if (view.clients.length === 0) return <p className="tm-cc-note">{t('PlatformOrgs.noClients')}</p>;
  return (
    <PlatformTable
      label={t('PlatformOrgs.subClients')}
      columns={columns}
      rows={view.clients}
      rowKey={(row) => row.membershipId}
    />
  );
}

function InvitationsTable({
  api,
  id,
  view,
}: {
  api: ApiClient;
  id: string;
  view: PlatformOrgMembersView;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const canEdit = usePlatformPermissions(api).has('platform.orgs.edit');
  const [revoking, setRevoking] = useState<string | null>(null);
  type Row = PlatformOrgMembersView['invitations'][number];
  const columns: readonly PlatformColumn<Row>[] = [
    { id: 'email', header: t('PlatformOrgs.colEmail'), kind: 'mono', cell: (row) => row.email },
    { id: 'role', header: t('PlatformOrgs.colRole'), cell: (row) => row.role },
    { id: 'by', header: t('PlatformOrgs.colInvitedBy'), cell: (row) => row.invitedByEmail ?? '—' },
    {
      id: 'expires',
      header: t('PlatformOrgs.colExpires'),
      cell: (row) => formatDay(row.expiresAt),
    },
    {
      id: 'actions',
      header: '',
      cell: (row) =>
        canEdit ? (
          <Button type="button" tone="text" size="compact" onClick={() => setRevoking(row.id)}>
            {t('PlatformOrgs.revoke')}
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      {view.invitations.length === 0 ? (
        <p className="tm-cc-note">{t('PlatformOrgs.noInvitations')}</p>
      ) : (
        <PlatformTable
          label={t('PlatformOrgs.subInvitations')}
          columns={columns}
          rows={view.invitations}
          rowKey={(row) => row.id}
        />
      )}
      {revoking ? (
        <ReasonDialog
          title={t('PlatformOrgs.revoke')}
          reasonRequired={false}
          destructive
          confirmLabel={t('PlatformOrgs.revoke')}
          onConfirm={() => revokePlatformOrgInvitation(api, id, revoking)}
          onClose={(done) => {
            setRevoking(null);
            if (done) void queryClient.invalidateQueries({ queryKey: orgKey(id, 'members') });
          }}
        />
      ) : null}
    </>
  );
}

function AddMemberDialog({
  api,
  id,
  roles,
  onClose,
}: {
  api: ApiClient;
  id: string;
  roles: readonly string[];
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roles.includes('member') ? 'member' : (roles[0] ?? 'member'));
  const add = useMutation({
    mutationFn: () => addPlatformOrgMember(api, id, email.trim(), role),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ORGS_KEY });
      onClose();
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate();
  }
  return (
    <PlatformDialog title={t('PlatformOrgs.addMember')} onClose={onClose}>
      <form className="tm-stack" onSubmit={submit} noValidate>
        <p className="tm-cc-note">{t('PlatformOrgs.addMemberBody')}</p>
        <Field
          label={t('PlatformOrgs.colEmail')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Select
          label={t('PlatformOrgs.colRole')}
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          {roles.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
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
            loading={add.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformOrgs.addMember')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
