'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, StatusDot } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { fetchPlatformTeam, updatePlatformAdmin } from '../../../lib/api/platform-team';
import type { PlatformTeamMemberView } from '../../../lib/api/platform-team';
import { useT } from '../../../lib/i18n/use-t';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import { ReasonDialog } from '../shared/ReasonDialog';
import { missingPlatformPermission } from '../shared/usePlatformPermissions';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import { PLATFORM_TEAM_KEY, PRESET_LABELS, PlatformAdminDialog } from './PlatformAdminDialog';
import { withNumerals } from '../../../lib/i18n/display-format';

/** "4 min ago", "Yesterday", "12 Oct" — the drawn last step-up column. */
export function relativeMoment(iso: string | null, locale: string, now = Date.now()): string {
  if (iso === null) return '—';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '—';
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(withNumerals(locale), { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(Math.round(seconds), 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return format.format(Math.round(seconds / 86_400), 'day');
  return new Intl.DateTimeFormat(withNumerals(locale), { day: 'numeric', month: 'short' }).format(
    at,
  );
}

/** D5 · Platform admin team — `/platform/team` (frames 436:18889, 436:19172, 436:19614). */
export function PlatformTeamScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const [adding, setAdding] = useState(false);
  return (
    <PlatformGate
      api={api}
      section="team"
      subsection="team-admins"
      crumbs={[t('PlatformTeam.crumbTeam'), t('PlatformTeam.crumbAdmins')]}
      title={t('PlatformTeam.title')}
      description={t('PlatformTeam.description')}
      actions={(me) =>
        me.permissions.includes('platform.team.manage') ? (
          <Button type="button" tone="lime" onClick={() => setAdding(true)}>
            {t('PlatformTeam.addButton')}
          </Button>
        ) : null
      }
    >
      {(me) => (
        <>
          <TeamBody api={api} me={me} />
          {adding ? <PlatformAdminDialog api={api} onClose={() => setAdding(false)} /> : null}
        </>
      )}
    </PlatformGate>
  );
}

type PendingAction =
  | { kind: 'edit'; admin: PlatformTeamMemberView }
  | { kind: 'disable'; admin: PlatformTeamMemberView }
  | { kind: 'enable'; admin: PlatformTeamMemberView };

function TeamBody({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const t = useT();
  const locale = useActiveLocale();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const team = useQuery({ queryKey: PLATFORM_TEAM_KEY, queryFn: () => fetchPlatformTeam(api) });

  if (team.isPending)
    return <PlatformPageState state="loading" loadingLabel={t('PlatformTeam.loading')} />;
  if (team.isError) {
    const missing = missingPlatformPermission(team.error);
    if (missing !== null) {
      return <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />;
    }
    return (
      <PlatformPageState state="error" error={team.error} onRetry={() => void team.refetch()} />
    );
  }

  const view = team.data;
  const total = view.permissionCount;
  const nameOf = (admin: PlatformTeamMemberView) => admin.displayName ?? admin.email;

  return (
    <>
      <PlatformTable<PlatformTeamMemberView>
        label={t('PlatformTeam.tableLabel')}
        rows={view.admins}
        rowKey={(admin) => admin.id ?? `env:${admin.email}`}
        isMuted={(admin) => admin.status === 'disabled'}
        columns={[
          {
            id: 'admin',
            header: t('PlatformTeam.colAdmin'),
            cell: (admin) => (
              <>
                <span className="tm-cc-cell-title">
                  {nameOf(admin)}
                  {admin.self ? ` ${t('PlatformTeam.you')}` : ''}
                </span>
                <bdi dir="ltr" className="tm-cc-cell-sub">
                  {admin.email}
                </bdi>
              </>
            ),
          },
          {
            id: 'source',
            header: t('PlatformTeam.colSource'),
            cell: (admin) =>
              admin.source === 'env' ? (
                <span className="tm-cc-pill tm-cc-cell-mono">{t('PlatformTeam.sourceEnv')}</span>
              ) : (
                <span className="tm-cc-pill">{t('PlatformTeam.sourceDb')}</span>
              ),
          },
          {
            id: 'preset',
            header: t('PlatformTeam.colPreset'),
            cell: (admin) => t(PRESET_LABELS[admin.preset]),
          },
          {
            id: 'permissions',
            header: t('PlatformTeam.colPermissions'),
            cell: (admin) => `${admin.permissions.length} ${t('PlatformTeam.of')} ${total}`,
          },
          {
            id: 'status',
            header: t('PlatformTeam.colStatus'),
            cell: (admin) =>
              admin.status === 'active' ? (
                <StatusDot tone="success">{t('PlatformTeam.statusActive')}</StatusDot>
              ) : (
                <StatusDot tone="neutral">{t('PlatformTeam.statusDisabled')}</StatusDot>
              ),
          },
          {
            id: 'stepUp',
            header: t('PlatformTeam.colLastStepUp'),
            cell: (admin) => relativeMoment(admin.lastStepUpAt, locale),
          },
          {
            id: 'actions',
            header: <span className="tm-visually-hidden">{t('PlatformTeam.colActions')}</span>,
            cell: (admin) => {
              if (admin.locked || admin.self || admin.id === null) {
                return (
                  <span className="tm-cc-hero__actions">
                    <span className="tm-cc-pill tm-cc-pill--muted">{t('PlatformTeam.locked')}</span>
                    <span className="tm-cc-cell-sub">
                      {admin.self
                        ? t('PlatformTeam.selfReadOnly')
                        : t('PlatformTeam.managedInHostinger')}
                    </span>
                  </span>
                );
              }
              if (!view.canManage) return null;
              if (admin.status === 'disabled') {
                return (
                  <Button
                    type="button"
                    tone="outline"
                    onClick={() => setPending({ kind: 'enable', admin })}
                  >
                    {t('PlatformTeam.enable')}
                  </Button>
                );
              }
              return (
                <span className="tm-cc-hero__actions">
                  <Button
                    type="button"
                    tone="outline"
                    onClick={() => setPending({ kind: 'edit', admin })}
                  >
                    {t('PlatformTeam.edit')}
                  </Button>
                  <Button
                    type="button"
                    tone="text"
                    onClick={() => setPending({ kind: 'disable', admin })}
                  >
                    {t('PlatformTeam.disable')}
                  </Button>
                </span>
              );
            },
          },
        ]}
        footer={`${view.superAdmins} ${t('PlatformTeam.superAdminsNote1')} (${view.envSuperAdmins} ${t(
          'PlatformTeam.superAdminsNote2',
        )}). ${t('PlatformTeam.superAdminsNote3')}`}
      />

      {pending?.kind === 'edit' ? (
        <PlatformAdminDialog api={api} admin={pending.admin} onClose={() => setPending(null)} />
      ) : null}
      {pending?.kind === 'disable' && pending.admin.id !== null ? (
        <ReasonDialog
          title={`${t('PlatformTeam.disableTitle')} ${nameOf(pending.admin)}?`}
          body={`${nameOf(pending.admin)} ${t('PlatformTeam.disableBody')}`}
          reasonRequired
          destructive
          confirmLabel={t('PlatformTeam.disableConfirm')}
          note={t('PlatformTeam.disableNote')}
          onConfirm={async (reason) => {
            await updatePlatformAdmin(api, pending.admin.id as string, {
              status: 'disabled',
              reason: reason ?? '',
            });
            await team.refetch();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending?.kind === 'enable' && pending.admin.id !== null ? (
        <ReasonDialog
          title={`${t('PlatformTeam.enableTitle')} ${nameOf(pending.admin)}?`}
          body={`${nameOf(pending.admin)} ${t('PlatformTeam.enableBody')}`}
          reasonRequired
          confirmLabel={t('PlatformTeam.enableConfirm')}
          onConfirm={async (reason) => {
            await updatePlatformAdmin(api, pending.admin.id as string, {
              status: 'active',
              reason: reason ?? '',
            });
            await team.refetch();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </>
  );
}
