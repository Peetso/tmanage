'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  fetchPlatformPresets,
  fetchPlatformTeam,
  savePlatformPreset,
} from '../../../lib/api/platform-team';
import type { PlatformPresetName, PlatformPresetsView } from '../../../lib/api/platform-team';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { ReasonDialog } from '../shared/ReasonDialog';
import { missingPlatformPermission } from '../shared/usePlatformPermissions';
import { PLATFORM_PRESETS_KEY, PLATFORM_TEAM_KEY, PRESET_LABELS } from './PlatformAdminDialog';
import { MATRIX_LABELS, PLATFORM_PERMISSIONS } from './permission-labels';

type Editable = 'support' | 'auditor';
const EDITABLE: readonly Editable[] = ['support', 'auditor'];
const CARDS: readonly PlatformPresetName[] = ['super_admin', 'support', 'auditor', 'custom'];

/** D6 · Platform permission presets — `/platform/team/presets` (frame 439:18886). */
export function PlatformPresetsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="team"
      subsection="team-presets"
      crumbs={[t('PlatformTeam.crumbTeam'), t('PlatformTeam.crumbPresets')]}
      title={t('PlatformTeam.presetsTitle')}
      description={t('PlatformTeam.presetsDescription')}
    >
      {(me) => <PresetsBody api={api} me={me} />}
    </PlatformGate>
  );
}

function PresetsBody({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const t = useT();
  const presets = useQuery({
    queryKey: PLATFORM_PRESETS_KEY,
    queryFn: () => fetchPlatformPresets(api),
  });
  const team = useQuery({ queryKey: PLATFORM_TEAM_KEY, queryFn: () => fetchPlatformTeam(api) });

  if (presets.isPending)
    return <PlatformPageState state="loading" loadingLabel={t('PlatformTeam.loadingPresets')} />;
  if (presets.isError) {
    const missing = missingPlatformPermission(presets.error);
    if (missing !== null)
      return <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />;
    return (
      <PlatformPageState
        state="error"
        error={presets.error}
        onRetry={() => void presets.refetch()}
      />
    );
  }
  return (
    <PresetsMatrix
      api={api}
      view={presets.data}
      adminsByPreset={(preset) =>
        (team.data?.admins ?? [])
          .filter((admin) => admin.preset === preset && admin.status === 'active')
          .map((admin) => admin.displayName ?? admin.email)
      }
      onSaved={async () => {
        await presets.refetch();
        await team.refetch();
      }}
    />
  );
}

function PresetsMatrix({
  api,
  view,
  adminsByPreset,
  onSaved,
}: {
  api: ApiClient;
  view: PlatformPresetsView;
  adminsByPreset: (preset: PlatformPresetName) => readonly string[];
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const saved = useMemo(() => {
    const map = new Map<PlatformPresetName, ReadonlySet<string>>();
    for (const preset of view.presets) map.set(preset.preset, new Set(preset.permissions));
    return map;
  }, [view]);
  const defaults = useMemo(() => {
    const map = new Map<PlatformPresetName, ReadonlySet<string>>();
    for (const preset of view.presets) map.set(preset.preset, new Set(preset.defaults));
    return map;
  }, [view]);
  const [draft, setDraft] = useState<Record<Editable, ReadonlySet<string>>>(() => ({
    support: saved.get('support') ?? new Set(),
    auditor: saved.get('auditor') ?? new Set(),
  }));
  const [confirming, setConfirming] = useState(false);

  const changes: { preset: Editable; permission: string; on: boolean }[] = [];
  for (const preset of EDITABLE) {
    const before = saved.get(preset) ?? new Set<string>();
    for (const permission of PLATFORM_PERMISSIONS) {
      const now = draft[preset].has(permission);
      if (now !== before.has(permission)) changes.push({ preset, permission, on: now });
    }
  }
  const changed = (preset: Editable, permission: string) =>
    changes.some((change) => change.preset === preset && change.permission === permission);
  const editable = (preset: Editable) =>
    view.canManage && (view.presets.find((p) => p.preset === preset)?.editable ?? false);

  function toggle(preset: Editable, permission: string, on: boolean) {
    const next = new Set(draft[preset]);
    if (on) next.add(permission);
    else next.delete(permission);
    setDraft({ ...draft, [preset]: next });
  }

  const countFor = (preset: PlatformPresetName) =>
    view.presets.find((p) => p.preset === preset)?.adminCount ?? 0;
  const affected = [...new Set(changes.flatMap((change) => adminsByPreset(change.preset)))];
  const first = changes[0];

  return (
    <div className="tm-stack">
      <div className="tm-cc-hero__actions" style={{ justifyContent: 'flex-end' }}>
        <Button
          type="button"
          tone="outline"
          disabled={!view.canManage}
          onClick={() =>
            setDraft({
              support: defaults.get('support') ?? new Set(),
              auditor: defaults.get('auditor') ?? new Set(),
            })
          }
        >
          {t('PlatformTeam.restoreDefaults')}
        </Button>
        <Button
          type="button"
          tone="ink"
          disabled={!view.canManage || changes.length === 0}
          onClick={() => setConfirming(true)}
        >
          {t('PlatformTeam.savePresets')}
        </Button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 'var(--s3)',
        }}
      >
        {CARDS.map((preset) => (
          <div key={preset} className="tm-cc-card tm-stack tm-stack--tight">
            <span className="tm-cc-cell-title">{t(PRESET_LABELS[preset])}</span>
            <span className="tm-cc-cell-sub">
              {countFor(preset)}{' '}
              {countFor(preset) === 1 ? t('PlatformTeam.adminOne') : t('PlatformTeam.adminMany')}
              {preset === 'super_admin' ? ` · ${t('PlatformTeam.fixed')}` : ''}
              {preset === 'custom' ? ` · ${t('PlatformTeam.setPerPerson')}` : ''}
            </span>
          </div>
        ))}
      </div>

      <section className="tm-cc-card tm-cc-card--flush" aria-label={t('PlatformTeam.matrixLabel')}>
        <table className="tm-table tm-cc-table" aria-label={t('PlatformTeam.matrixLabel')}>
          <thead>
            <tr>
              <th scope="col">{t('PlatformTeam.colPermission')}</th>
              <th scope="col">
                {t('PlatformTeam.presetSuperAdmin')} · {t('PlatformTeam.fixed')}
              </th>
              <th scope="col">{t('PlatformTeam.presetSupport')}</th>
              <th scope="col">{t('PlatformTeam.presetAuditor')}</th>
            </tr>
          </thead>
          <tbody>
            {PLATFORM_PERMISSIONS.map((permission) => {
              const rowChanged = EDITABLE.some((preset) => changed(preset, permission));
              const label = t(MATRIX_LABELS[permission]);
              return (
                <tr
                  key={permission}
                  {...(rowChanged
                    ? {
                        'data-changed': 'true',
                        style: { background: 'var(--tm-lime-wash, transparent)' },
                      }
                    : {})}
                >
                  <td>
                    <span className="tm-cc-cell-title">{label}</span>
                    <bdi dir="ltr" className="tm-cc-cell-mono">
                      {permission}
                    </bdi>
                  </td>
                  <td>
                    <Checkbox
                      label={
                        <span className="tm-visually-hidden">{`${t('PlatformTeam.presetSuperAdmin')}: ${label}`}</span>
                      }
                      checked={saved.get('super_admin')?.has(permission) ?? true}
                      disabled
                      readOnly
                    />
                  </td>
                  {EDITABLE.map((preset) => (
                    <td key={preset}>
                      <span
                        className={
                          changed(preset, permission) ? 'tm-cc-pill tm-cc-pill--on' : undefined
                        }
                      >
                        <Checkbox
                          label={
                            changed(preset, permission) ? (
                              t('PlatformTeam.changed')
                            ) : (
                              <span className="tm-visually-hidden">{`${t(PRESET_LABELS[preset])}: ${label}`}</span>
                            )
                          }
                          aria-label={`${t(PRESET_LABELS[preset])}: ${label}`}
                          checked={draft[preset].has(permission)}
                          disabled={!editable(preset) || permission === 'platform.team.manage'}
                          onChange={(event) => toggle(preset, permission, event.target.checked)}
                        />
                      </span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {changes.length > 0 && first ? (
        <InlineAlert tone="warning">
          {changes.length}{' '}
          {changes.length === 1 ? t('PlatformTeam.unsavedOne') : t('PlatformTeam.unsavedMany')}:{' '}
          {t(PRESET_LABELS[first.preset])}{' '}
          {first.on ? t('PlatformTeam.gains') : t('PlatformTeam.loses')} “
          {t(MATRIX_LABELS[first.permission as (typeof PLATFORM_PERMISSIONS)[number]])}”
          {changes.length > 1 ? ` ${t('PlatformTeam.andMore')}` : ''}.{' '}
          {affected.length > 0
            ? `${t('PlatformTeam.appliesTo')} ${affected.join(', ')} ${t('PlatformTeam.atNextRequest')} `
            : ''}
          {t('PlatformTeam.savingNeedsReason')}
        </InlineAlert>
      ) : null}

      {confirming ? (
        <ReasonDialog
          title={t('PlatformTeam.savePresetsTitle')}
          body={t('PlatformTeam.savePresetsBody')}
          reasonRequired
          confirmLabel={t('PlatformTeam.savePresets')}
          onConfirm={async (reason) => {
            for (const preset of EDITABLE) {
              if (changes.some((change) => change.preset === preset)) {
                await savePlatformPreset(api, preset, [...draft[preset]], reason ?? '');
              }
            }
            await onSaved();
          }}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
