'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../../../lib/api/browser-client';
import { ApiRequestError } from '../../../../../lib/api/errors';
import {
  clonePlatformOrgRole,
  createPlatformOrgRole,
  fetchPlatformOrgRoles,
} from '../../../../../lib/api/platform-permissions';
import type { PlatformOrgRoleView } from '../../../../../lib/api/platform-permissions';
import { useT } from '../../../../../lib/i18n/use-t';
import { PlatformGate } from '../../../../../components/platform/shared/platform-kit';
import { PlatformPageState } from '../../../../../components/platform/shared/PlatformPageState';
import {
  PlatformDialog,
  PlatformDialogActions,
} from '../../../../../components/platform/shared/ReasonDialog';
import { missingPlatformPermission } from '../../../../../components/platform/shared/usePlatformPermissions';
import { fill, roleLabel } from '../../../../../components/permissions/RoleMatrixEditor';
import '../../../../../styles/screens/permission-editor.css';

/**
 * Platform admin — one organization's roles (A6 roles tab, platform-admin v2 · PA-04): built-in
 * and custom, with holders and how many of the permissions each grants. Built-in roles open read
 * only; custom ones open the D7 editor. "Create role" starts a custom role from a built-in one.
 */
export default function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = use(params);
  return <PlatformOrgRolesScreen organizationId={organizationId} />;
}

function PlatformOrgRolesScreen({ organizationId }: { organizationId: string }) {
  const t = useT();
  const api = browserApiClient();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const view = useQuery({
    queryKey: ['platform-org-roles', organizationId],
    queryFn: () => fetchPlatformOrgRoles(api, organizationId),
  });
  const clone = useMutation({
    mutationFn: (role: PlatformOrgRoleView) =>
      clonePlatformOrgRole(api, organizationId, role.id, {
        name: fill(t('PermissionEditor.cloneDefaultName'), {
          role: role.builtIn ? roleLabel(t, role.id) : role.name,
        }),
      }),
    onSuccess: (written) =>
      router.push(`/platform/organizations/${organizationId}/roles/${written.role.id}`),
  });
  const data = view.data;
  const base = `/platform/organizations/${organizationId}/roles`;

  return (
    <PlatformGate
      api={api}
      section="organizations"
      crumbs={[
        t('PermissionEditor.crumbOrganizations'),
        data?.organizationName ?? '…',
        t('PermissionEditor.crumbRoles'),
      ]}
      title={t('PermissionEditor.rolesTitle')}
      description={t('PermissionEditor.rolesSub')}
      actions={(me) =>
        me.permissions.includes('platform.permissions.edit') && data ? (
          <Button type="button" tone="ink" onClick={() => setCreating(true)}>
            {t('PermissionEditor.createRole')}
          </Button>
        ) : null
      }
    >
      {(me) => {
        if (view.isPending) {
          return <PlatformPageState state="loading" loadingLabel={t('PermissionEditor.loading')} />;
        }
        if (view.isError || !data) {
          const missing = missingPlatformPermission(view.error);
          if (missing !== null) {
            return <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />;
          }
          return (
            <PlatformPageState
              state="error"
              error={view.error}
              onRetry={() => void view.refetch()}
            />
          );
        }
        const canEdit = me.permissions.includes('platform.permissions.edit');
        return (
          <div className="tm-pe">
            {clone.isError ? (
              <InlineAlert tone="danger" title={t('PermissionEditor.cloneFailed')} live>
                {clone.error instanceof ApiRequestError
                  ? clone.error.message
                  : t('PermissionEditor.errorGeneric')}
              </InlineAlert>
            ) : null}
            <section className="tm-cc-card">
              <table className="tm-pe-table" data-testid="platform-org-roles">
                <thead>
                  <tr>
                    <th scope="col">{t('PermissionEditor.colRole')}</th>
                    <th scope="col">{t('PermissionEditor.colType')}</th>
                    <th scope="col">{t('PermissionEditor.colHolders')}</th>
                    <th scope="col">{t('PermissionEditor.colPermissions')}</th>
                    <th scope="col">
                      <span className="tm-visually-hidden">{t('PermissionEditor.colActions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.roles.map((role) => (
                    <tr key={role.id} data-role={role.id}>
                      <td>
                        <strong className="tm-cc-cell-title">
                          {role.builtIn ? roleLabel(t, role.id) : role.name}
                        </strong>
                      </td>
                      <td>
                        <span className="tm-cc-pill">
                          {role.builtIn
                            ? t('PermissionEditor.typeBuiltIn')
                            : t('PermissionEditor.typeCustom')}
                        </span>
                      </td>
                      <td>{role.holders}</td>
                      <td>
                        {fill(t('PermissionEditor.permissionsOf'), {
                          count: role.capabilities.length,
                          total: data.permissionCount,
                        })}
                      </td>
                      <td>
                        <div className="tm-pe__actions">
                          <Link href={`${base}/${role.id}`}>
                            {role.builtIn || !canEdit
                              ? t('PermissionEditor.viewMatrix')
                              : t('PermissionEditor.editMatrix')}
                          </Link>
                          {canEdit ? (
                            <Button
                              type="button"
                              tone="text"
                              size="compact"
                              loading={clone.isPending && clone.variables?.id === role.id}
                              onClick={() => clone.mutate(role)}
                            >
                              {t('PermissionEditor.clone')}
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <p className="tm-cc-note">{t('PermissionEditor.rolesFootnote')}</p>
            {creating ? (
              <CreateRoleDialog
                roles={data.roles.filter((role) => role.builtIn && role.id !== 'owner')}
                onClose={() => setCreating(false)}
                onCreate={async (name, from) => {
                  const written = await createPlatformOrgRole(api, organizationId, {
                    name,
                    capabilities: from?.capabilities ?? [],
                  });
                  router.push(`${base}/${written.role.id}`);
                }}
              />
            ) : null}
          </div>
        );
      }}
    </PlatformGate>
  );
}

function CreateRoleDialog({
  roles,
  onClose,
  onCreate,
}: {
  roles: readonly PlatformOrgRoleView[];
  onClose: () => void;
  onCreate: (name: string, from: PlatformOrgRoleView | null) => Promise<unknown>;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim(), roles.find((role) => role.id === from) ?? null);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  };
  return (
    <PlatformDialog
      eyebrow={t('PermissionEditor.createEyebrow')}
      title={t('PermissionEditor.createTitle')}
      width={480}
      onClose={onClose}
    >
      <form className="tm-stack" onSubmit={(event) => void submit(event)}>
        <Field
          label={t('PermissionEditor.newRoleName')}
          name="role-name"
          value={name}
          maxLength={80}
          required
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Select
          label={t('PermissionEditor.startFrom')}
          value={from}
          onChange={(event) => setFrom(event.currentTarget.value)}
        >
          <option value="">{t('PermissionEditor.startEmpty')}</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {roleLabel(t, role.id)}
            </option>
          ))}
        </Select>
        {error ? (
          <InlineAlert tone="danger" title={t('PermissionEditor.createFailed')} live>
            {error instanceof ApiRequestError ? error.message : t('PermissionEditor.errorGeneric')}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={onClose}>
            {t('PermissionEditor.cancel')}
          </Button>
          <Button
            type="submit"
            tone="ink"
            loading={busy}
            loadingLabel={t('PermissionEditor.saving')}
            disabled={name.trim() === ''}
          >
            {t('PermissionEditor.createRole')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
