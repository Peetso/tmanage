'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import { browserApiClient } from '../../../../../../lib/api/browser-client';
import {
  clonePlatformOrgRole,
  deletePlatformOrgRole,
  fetchPlatformOrgRoles,
  updatePlatformOrgRole,
} from '../../../../../../lib/api/platform-permissions';
import type { Capability } from '@tmanage/domain';
import { useT } from '../../../../../../lib/i18n/use-t';
import { PlatformGate } from '../../../../../../components/platform/shared/platform-kit';
import { PlatformPageState } from '../../../../../../components/platform/shared/PlatformPageState';
import { missingPlatformPermission } from '../../../../../../components/platform/shared/usePlatformPermissions';
import {
  RoleMatrixEditor,
  fill,
  roleLabel,
} from '../../../../../../components/permissions/RoleMatrixEditor';
import type { RoleEditorDialog } from '../../../../../../components/permissions/RoleMatrixEditor';

/**
 * Platform admin — D7 role matrix editor (Figma `439:19450`, platform-admin v2 · PA-04). The
 * platform edits as the organization's owner would (no ceiling); every save records a reason in
 * the platform audit. Built-in roles open read only. Delete moves the holders to another role first.
 */
export default function Page({
  params,
}: {
  params: Promise<{ organizationId: string; roleId: string }>;
}) {
  const { organizationId, roleId } = use(params);
  return <PlatformOrgRoleScreen organizationId={organizationId} roleId={roleId} />;
}

function PlatformOrgRoleScreen({
  organizationId,
  roleId,
}: {
  organizationId: string;
  roleId: string;
}) {
  const t = useT();
  const api = browserApiClient();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<RoleEditorDialog>(null);
  const key = ['platform-org-roles', organizationId] as const;
  const view = useQuery({
    queryKey: key,
    queryFn: () => fetchPlatformOrgRoles(api, organizationId),
  });
  const save = useMutation({
    mutationFn: (input: { capabilities: readonly Capability[]; reason: string }) =>
      updatePlatformOrgRole(api, organizationId, roleId, {
        capabilities: input.capabilities,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const data = view.data;
  const role = data?.roles.find((entry) => entry.id === roleId) ?? null;
  const name = role ? (role.builtIn ? roleLabel(t, role.id) : role.name) : '…';
  const base = `/platform/organizations/${organizationId}/roles`;

  return (
    <PlatformGate
      api={api}
      section="organizations"
      crumbs={[
        t('PermissionEditor.crumbOrganizations'),
        data?.organizationName ?? '…',
        t('PermissionEditor.crumbRoles'),
        name,
      ]}
      title={name}
      {...(role
        ? {
            description: role.builtIn
              ? t('PermissionEditor.builtInReadOnlyBody')
              : fill(t('PermissionEditor.heldBy'), { holders: role.holders }),
          }
        : {})}
      actions={(me) =>
        role && me.permissions.includes('platform.permissions.edit') ? (
          <>
            <Button type="button" tone="outline" onClick={() => setDialog('clone')}>
              {t('PermissionEditor.cloneRole')}
            </Button>
            {role.builtIn ? null : (
              <Button type="button" tone="destructive" onClick={() => setDialog('delete')}>
                {t('PermissionEditor.deleteRole')}
              </Button>
            )}
          </>
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
        if (!role) {
          return (
            <PlatformPageState
              state="empty"
              title={t('PermissionEditor.roleMissing')}
              body={t('PermissionEditor.backToRoles')}
            />
          );
        }
        const canEdit = me.permissions.includes('platform.permissions.edit');
        const builtInRoles = data.roles
          .filter((entry) => entry.builtIn)
          .map((entry) => ({ id: entry.id, kind: entry.kind, capabilities: entry.capabilities }));
        const reassignOptions = data.roles
          .filter(
            (entry) => entry.id !== role.id && entry.id !== 'owner' && entry.kind === role.kind,
          )
          .map((entry) => ({
            id: entry.id,
            label: entry.builtIn ? roleLabel(t, entry.id) : entry.name,
          }));
        return (
          <RoleMatrixEditor
            role={{
              id: role.id,
              name,
              builtIn: role.builtIn || !canEdit,
              capabilities: role.capabilities,
              holders: role.holders,
            }}
            builtInRoles={builtInRoles}
            withReason
            saving={save.isPending}
            saveError={save.error}
            onSave={(capabilities, reason) =>
              save.mutateAsync({ capabilities, reason }).catch(() => undefined)
            }
            dialog={canEdit ? dialog : null}
            onDialogClose={() => setDialog(null)}
            onClone={async (cloneName) => {
              const written = await clonePlatformOrgRole(api, organizationId, role.id, {
                name: cloneName,
              });
              await queryClient.invalidateQueries({ queryKey: key });
              setDialog(null);
              router.push(`${base}/${written.role.id}`);
            }}
            onDelete={async (reassignTo) => {
              await deletePlatformOrgRole(api, organizationId, role.id, { reassignTo });
              await queryClient.invalidateQueries({ queryKey: key });
              setDialog(null);
              router.push(base);
            }}
            reassignOptions={reassignOptions}
          />
        );
      }}
    </PlatformGate>
  );
}
