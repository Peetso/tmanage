'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, SearchField, Switch, VisuallyHidden } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  PLATFORM_FLAGS_QUERY_KEY,
  fetchPlatformFlagOrganizations,
  fetchPlatformFlags,
  updatePlatformFlag,
} from '../../../lib/api/platform-settings';
import type {
  FlagOverrideInput,
  PlatformFlagKey,
  PlatformFlagOrganizationView,
  PlatformFlagRollout,
  PlatformFlagView,
} from '../../../lib/api/platform-settings';
import type { MessageKey } from '../../../lib/i18n/t';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformGate } from '../shared/platform-kit';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformTable } from '../shared/PlatformTable';
import {
  PlatformDialog,
  PlatformDialogActions,
  REASON_MAX,
  REASON_MIN,
  platformErrorText,
} from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY, missingPlatformPermission } from '../shared/usePlatformPermissions';
import { ChipGroup, SettingsSubNav, fill } from './settings-kit';

/**
 * D2 · Feature flags (`/platform/settings/flags`, frame 435:19744). Only the keys in code
 * (`OPTIONAL_MODULE_FLAGS`) are listed; a flag can be on for everyone, chosen organizations or a
 * percentage of them, forced per organization, or locked by the server (`TMANAGE_FLAG_LOCKS`).
 */

export const FLAG_LABELS: Record<PlatformFlagKey, MessageKey> = {
  chat: 'PlatformSettings.flagChat',
  meetings: 'PlatformSettings.flagMeetings',
  docs: 'PlatformSettings.flagDocs',
  people: 'PlatformSettings.flagPeople',
  insights: 'PlatformSettings.flagInsights',
  automations: 'PlatformSettings.flagAutomations',
  client_portal: 'PlatformSettings.flagClientPortal',
  billing: 'PlatformSettings.flagBilling',
  copilot: 'PlatformSettings.flagCopilot',
};

type Filter = 'all' | 'on' | 'off' | 'locked';

export function PlatformFlagsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="settings"
      crumbs={[t('PlatformSettings.crumbSettings'), t('PlatformSettings.navFlags')]}
      title={t('PlatformSettings.flagsTitle')}
      description={t('PlatformSettings.flagsDescription')}
    >
      {(me) => <FlagsBody api={api} me={me} />}
    </PlatformGate>
  );
}

/** Whether a flag counts as on for the filter: the server lock wins, then the default. */
export function flagIsOn(flag: PlatformFlagView): boolean {
  return flag.lockedValue ?? flag.enabled;
}

export function filterFlags(flags: readonly PlatformFlagView[], filter: Filter) {
  if (filter === 'locked') return flags.filter((flag) => flag.lockedValue !== null);
  if (filter === 'on') return flags.filter((flag) => flagIsOn(flag));
  if (filter === 'off') return flags.filter((flag) => !flagIsOn(flag));
  return flags;
}

function FlagsBody({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<PlatformFlagView | null>(null);
  const flags = useQuery({
    queryKey: PLATFORM_FLAGS_QUERY_KEY,
    queryFn: () => fetchPlatformFlags(api),
  });
  const canEdit = me.permissions.includes('platform.flags.edit');

  if (flags.isPending) {
    return (
      <>
        <SettingsSubNav active="flags" />
        <PlatformPageState state="loading" loadingLabel={t('PlatformSettings.flagsLoading')} />
      </>
    );
  }
  if (flags.isError) {
    const missing = missingPlatformPermission(flags.error);
    return (
      <>
        <SettingsSubNav active="flags" />
        {missing !== null ? (
          <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
        ) : (
          <PlatformPageState
            state="error"
            error={flags.error}
            onRetry={() => void flags.refetch()}
          />
        )}
      </>
    );
  }

  const all = flags.data.flags;
  const rows = filterFlags(all, filter);
  const rollout = (flag: PlatformFlagView) => {
    if (flag.rollout === 'allowlist') {
      return fill(t('PlatformSettings.rolloutAllowlistCount'), {
        count: flag.allowlistOrganizationIds.length,
      });
    }
    if (flag.rollout === 'percentage') {
      return fill(t('PlatformSettings.rolloutPercentageValue'), { percent: flag.percentage ?? 0 });
    }
    return t('PlatformSettings.rolloutEveryone');
  };

  return (
    <div className="tm-stack">
      <SettingsSubNav active="flags" />
      <ChipGroup<Filter>
        label={t('PlatformSettings.filterLabel')}
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: `${t('PlatformSettings.filterAll')} · ${all.length}` },
          {
            value: 'on',
            label: `${t('PlatformSettings.filterOn')} · ${filterFlags(all, 'on').length}`,
          },
          {
            value: 'off',
            label: `${t('PlatformSettings.filterOff')} · ${filterFlags(all, 'off').length}`,
          },
          {
            value: 'locked',
            label: `${t('PlatformSettings.filterLocked')} · ${filterFlags(all, 'locked').length}`,
          },
        ]}
      />
      <PlatformTable<PlatformFlagView>
        label={t('PlatformSettings.flagsTitle')}
        rows={rows}
        rowKey={(flag) => flag.key}
        isMuted={(flag) => flag.lockedValue !== null}
        columns={[
          {
            id: 'flag',
            header: t('PlatformSettings.colFlag'),
            cell: (flag) => (
              <>
                <span className="tm-cc-cell-title">{t(FLAG_LABELS[flag.key])}</span>
                <bdi dir="ltr" className="tm-cc-cell-mono">
                  {flag.key}
                </bdi>
              </>
            ),
          },
          {
            id: 'default',
            header: t('PlatformSettings.colDefault'),
            cell: (flag) =>
              flag.lockedValue !== null ? (
                <span className="tm-cc-pill tm-cc-pill--muted">
                  {flag.lockedValue
                    ? t('PlatformSettings.lockedOn')
                    : t('PlatformSettings.lockedOff')}
                </span>
              ) : (
                <span
                  className={`tm-cc-pill${flag.enabled ? ' tm-cc-pill--on' : ' tm-cc-pill--muted'}`}
                >
                  {flag.enabled ? t('PlatformSettings.on') : t('PlatformSettings.off')}
                </span>
              ),
          },
          { id: 'rollout', header: t('PlatformSettings.colRollout'), cell: rollout },
          {
            id: 'overrides',
            header: t('PlatformSettings.colOrgOverrides'),
            cell: (flag) => {
              const parts: string[] = [];
              if (flag.forcedOn > 0) {
                parts.push(fill(t('PlatformSettings.forcedOnCount'), { count: flag.forcedOn }));
              }
              if (flag.forcedOff > 0) {
                parts.push(fill(t('PlatformSettings.forcedOffCount'), { count: flag.forcedOff }));
              }
              return parts.length > 0 ? parts.join(' · ') : '—';
            },
          },
          {
            id: 'used',
            header: t('PlatformSettings.colUsedBy'),
            kind: 'mono',
            cell: (flag) => `${flag.usedByOrganizations} / ${flags.data.organizationCount}`,
          },
          {
            id: 'edit',
            header: <VisuallyHidden>{t('PlatformSettings.edit')}</VisuallyHidden>,
            cell: (flag) => (
              <Button
                type="button"
                tone="outline"
                size="compact"
                disabled={!canEdit || flag.lockedValue !== null}
                onClick={() => setEditing(flag)}
              >
                {t('PlatformSettings.edit')}
              </Button>
            ),
          },
        ]}
        footer={<span className="tm-cc-cell-sub">{t('PlatformSettings.flagsFooter')}</span>}
      />
      {editing ? <FlagDrawer api={api} flag={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

type ForcedState = 'on' | 'off';

/** The flag drawer: default, rollout, the allowlist, forced organizations, an optional reason. */
function FlagDrawer({
  api,
  flag,
  onClose,
}: {
  api: ApiClient;
  flag: PlatformFlagView;
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(flag.enabled);
  const [rollout, setRollout] = useState<PlatformFlagRollout>(flag.rollout);
  const [percentage, setPercentage] = useState(String(flag.percentage ?? 25));
  const [allowlist, setAllowlist] = useState<readonly string[]>(flag.allowlistOrganizationIds);
  const [forced, setForced] = useState<ReadonlyMap<string, ForcedState | null>>(new Map());
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());

  const known = useQuery({
    queryKey: [...PLATFORM_FLAGS_QUERY_KEY, flag.key, 'organizations'],
    queryFn: () => fetchPlatformFlagOrganizations(api, flag.key, ''),
  });
  const found = useQuery({
    queryKey: [...PLATFORM_FLAGS_QUERY_KEY, flag.key, 'search', search.trim()],
    queryFn: () => fetchPlatformFlagOrganizations(api, flag.key, search),
    enabled: search.trim().length >= 2,
  });

  const nameOf = useMemo(() => {
    const map = new Map(names);
    for (const organization of known.data?.organizations ?? [])
      map.set(organization.id, organization.name);
    for (const organization of found.data?.organizations ?? [])
      map.set(organization.id, organization.name);
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [names, known.data, found.data]);

  const forcedRows = useMemo(() => {
    const rows = new Map<string, ForcedState>();
    for (const organization of known.data?.organizations ?? []) {
      if (organization.forced) rows.set(organization.id, organization.forced);
    }
    for (const [id, state] of forced) {
      if (state === null) rows.delete(id);
      else rows.set(id, state);
    }
    return [...rows.entries()];
  }, [known.data, forced]);

  const percent = Number(percentage);
  const percentInvalid =
    rollout === 'percentage' && (!Number.isInteger(percent) || percent < 0 || percent > 100);
  const trimmedReason = reason.trim();
  const reasonInvalid =
    trimmedReason.length > 0 &&
    (trimmedReason.length < REASON_MIN || trimmedReason.length > REASON_MAX);

  const save = useMutation({
    mutationFn: () => {
      const overrides: FlagOverrideInput[] = [...forced.entries()].map(
        ([organizationId, state]) => ({
          organizationId,
          state: state ?? 'none',
        }),
      );
      return updatePlatformFlag(api, flag.key, {
        enabled,
        rollout,
        ...(rollout === 'percentage' ? { percentage: percent } : {}),
        ...(rollout === 'allowlist' ? { allowlistOrganizationIds: allowlist } : {}),
        ...(overrides.length > 0 ? { overrides } : {}),
        ...(trimmedReason !== '' ? { reason: trimmedReason } : {}),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PLATFORM_FLAGS_QUERY_KEY });
      onClose();
    },
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
      }
    },
  });

  function remember(organization: PlatformFlagOrganizationView) {
    setNames((current) => new Map(current).set(organization.id, organization.name));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (percentInvalid || reasonInvalid) return;
    save.mutate();
  }

  const visibleAllowlist = allowlist.slice(0, 6);
  return (
    <PlatformDialog
      eyebrow={`${t('PlatformSettings.flagEyebrow')} · ${flag.key}`}
      title={t(FLAG_LABELS[flag.key])}
      width={640}
      onClose={onClose}
    >
      <form className="tm-stack" onSubmit={submit} noValidate>
        <div className="tm-cc-card__head">
          <div className="tm-stack tm-stack--tight">
            <span className="tm-cc-cell-title">{t('PlatformSettings.onByDefault')}</span>
            <span className="tm-cc-note">{t('PlatformSettings.onByDefaultBody')}</span>
          </div>
          <Switch
            label={<VisuallyHidden>{t('PlatformSettings.onByDefault')}</VisuallyHidden>}
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
        </div>
        <ChipGroup<PlatformFlagRollout>
          label={t('PlatformSettings.rolloutLabel')}
          value={rollout}
          onChange={setRollout}
          options={[
            { value: 'everyone', label: t('PlatformSettings.rolloutEveryone') },
            { value: 'allowlist', label: t('PlatformSettings.rolloutChosen') },
            { value: 'percentage', label: t('PlatformSettings.rolloutPercentage') },
          ]}
        />
        {rollout === 'percentage' ? (
          <Field
            label={t('PlatformSettings.percentageLabel')}
            hint={t('PlatformSettings.percentageHint')}
            inputMode="numeric"
            value={percentage}
            onChange={(event) => setPercentage(event.target.value)}
            {...(percentInvalid ? { error: t('PlatformSettings.percentageError') } : {})}
          />
        ) : null}
        {rollout === 'allowlist' && allowlist.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)' }}>
            {visibleAllowlist.map((id) => (
              <button
                key={id}
                type="button"
                className="tm-cc-pill"
                aria-label={fill(t('PlatformSettings.removeFromAllowlist'), { name: nameOf(id) })}
                onClick={() => setAllowlist((current) => current.filter((value) => value !== id))}
              >
                {nameOf(id)} ×
              </button>
            ))}
            {allowlist.length > visibleAllowlist.length ? (
              <span className="tm-cc-pill tm-cc-pill--muted">
                {fill(t('PlatformSettings.moreCount'), {
                  count: allowlist.length - visibleAllowlist.length,
                })}
              </span>
            ) : null}
          </div>
        ) : null}
        <SearchField
          label={t('PlatformSettings.addOrganization')}
          labelVisible
          placeholder={t('PlatformSettings.searchOrganizations')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search.trim().length >= 2 && found.data ? (
          <ul className="tm-cc-rows" aria-label={t('PlatformSettings.searchResults')}>
            {found.data.organizations.length === 0 ? (
              <li className="tm-cc-cell-sub">{t('PlatformSettings.noOrganizationsFound')}</li>
            ) : null}
            {found.data.organizations.map((organization) => (
              <li key={organization.id} className="tm-cc-card__head">
                <span>
                  <span className="tm-cc-cell-title">{organization.name}</span>{' '}
                  <bdi dir="ltr" className="tm-cc-cell-sub">
                    {organization.slug}
                  </bdi>
                </span>
                <span className="tm-cc-hero__actions">
                  {rollout === 'allowlist' ? (
                    <Button
                      type="button"
                      tone="outline"
                      size="compact"
                      disabled={allowlist.includes(organization.id)}
                      onClick={() => {
                        remember(organization);
                        setAllowlist((current) => [...current, organization.id]);
                      }}
                    >
                      {t('PlatformSettings.addToAllowlist')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    tone="text"
                    size="compact"
                    onClick={() => {
                      remember(organization);
                      setForced((current) => new Map(current).set(organization.id, 'on'));
                    }}
                  >
                    {t('PlatformSettings.forceOn')}
                  </Button>
                  <Button
                    type="button"
                    tone="text"
                    size="compact"
                    onClick={() => {
                      remember(organization);
                      setForced((current) => new Map(current).set(organization.id, 'off'));
                    }}
                  >
                    {t('PlatformSettings.forceOff')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="tm-cc-eyebrow">{t('PlatformSettings.forcedPerOrganization')}</p>
        {forcedRows.length === 0 ? (
          <p className="tm-cc-cell-sub">{t('PlatformSettings.noneForced')}</p>
        ) : (
          <table className="tm-cc-table">
            <thead>
              <tr>
                <th scope="col">{t('PlatformSettings.colOrganization')}</th>
                <th scope="col">{t('PlatformSettings.colState')}</th>
                <th scope="col">
                  <VisuallyHidden>{t('PlatformSettings.remove')}</VisuallyHidden>
                </th>
              </tr>
            </thead>
            <tbody>
              {forcedRows.map(([id, state]) => (
                <tr key={id}>
                  <td>{nameOf(id)}</td>
                  <td>
                    <span
                      className={`tm-cc-pill${state === 'on' ? ' tm-cc-pill--on' : ' tm-cc-pill--danger'}`}
                    >
                      {state === 'on'
                        ? t('PlatformSettings.forcedOn')
                        : t('PlatformSettings.forcedOff')}
                    </span>
                  </td>
                  <td>
                    <Button
                      type="button"
                      tone="text"
                      size="compact"
                      onClick={() => setForced((current) => new Map(current).set(id, null))}
                    >
                      {t('PlatformSettings.remove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <InlineAlert tone="neutral">
          {fill(t('PlatformSettings.usedByNow'), { count: flag.usedByOrganizations })}
        </InlineAlert>
        <Field
          label={t('PlatformSettings.reasonOptionalLabel')}
          value={reason}
          maxLength={REASON_MAX}
          onChange={(event) => setReason(event.target.value)}
          {...(reasonInvalid ? { error: t('PlatformShared.reasonError') } : {})}
        />
        {save.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={onClose}>
            {t('PlatformShared.cancel')}
          </Button>
          <Button
            type="submit"
            tone="ink"
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {t('PlatformSettings.saveFlag')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
