'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_PRESETS } from '@tmanage/domain';
import { Button, Checkbox, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import { searchPlatformPeople } from '../../../lib/api/platform-admin';
import {
  addPlatformAdmin,
  fetchPlatformPresets,
  updatePlatformAdmin,
} from '../../../lib/api/platform-team';
import type { PlatformPresetName, PlatformTeamMemberView } from '../../../lib/api/platform-team';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import {
  PlatformDialog,
  PlatformDialogActions,
  REASON_MAX,
  REASON_MIN,
  platformErrorText,
} from '../shared/ReasonDialog';
import { PLATFORM_ME_QUERY_KEY } from '../shared/usePlatformPermissions';
import { AREA_LABELS, PLATFORM_PERMISSION_AREAS, SHORT_LABELS } from './permission-labels';
import type { PlatformPermission } from './permission-labels';

export const PLATFORM_TEAM_KEY = ['platform', 'team'] as const;
export const PLATFORM_PRESETS_KEY = ['platform', 'team', 'presets'] as const;

export const PRESET_LABELS: Record<PlatformPresetName, MessageKey> = {
  super_admin: 'PlatformTeam.presetSuperAdmin',
  support: 'PlatformTeam.presetSupport',
  auditor: 'PlatformTeam.presetAuditor',
  custom: 'PlatformTeam.presetCustom',
};

const PRESET_ORDER: readonly PlatformPresetName[] = ['super_admin', 'support', 'auditor', 'custom'];
const TEAM_MANAGE: PlatformPermission = 'platform.team.manage';

const GRID = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 'var(--s3)',
} as const;

/**
 * D5 "Add a platform admin" (frame 436:19172), and the same dialog for Edit: the verified account
 * (by email), the preset chips, the 18 permissions as checkboxes grouped by area — changing any box
 * makes it Custom — and the required reason. "Manage this team" comes only with Super admin.
 */
export function PlatformAdminDialog({
  api,
  admin,
  onClose,
}: {
  api: ApiClient;
  /** Edit this admin; omit to add one. */
  admin?: PlatformTeamMemberView;
  onClose: (done: boolean) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const editing = admin !== undefined;
  const presets = useQuery({
    queryKey: PLATFORM_PRESETS_KEY,
    queryFn: () => fetchPlatformPresets(api),
  });
  const presetSet = useMemo(() => {
    const stored = new Map<PlatformPresetName, readonly string[]>();
    for (const view of presets.data?.presets ?? []) stored.set(view.preset, view.permissions);
    return (preset: PlatformPresetName): readonly string[] =>
      preset === 'custom'
        ? []
        : (stored.get(preset) ?? PLATFORM_PRESETS[preset as Exclude<PlatformPresetName, 'custom'>]);
  }, [presets.data]);

  const [email, setEmail] = useState(admin?.email ?? '');
  const [preset, setPreset] = useState<PlatformPresetName>(admin?.preset ?? 'support');
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(admin?.permissions ?? PLATFORM_PRESETS.support),
  );
  const [touchedPreset, setTouchedPreset] = useState(editing);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const emailRef = useRef<HTMLDivElement>(null);

  // Until the operator picks something, the boxes follow the stored preset mapping.
  useEffect(() => {
    if (!touchedPreset && presets.isSuccess) setChecked(new Set(presetSet(preset)));
  }, [presets.isSuccess, presetSet, preset, touchedPreset]);

  useEffect(() => {
    emailRef.current?.querySelector('input')?.focus();
  }, []);

  const trimmedEmail = email.trim();
  const lookup = useQuery({
    queryKey: ['platform', 'team', 'lookup', trimmedEmail.toLowerCase()],
    queryFn: () => searchPlatformPeople(api, trimmedEmail),
    enabled: !editing && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmedEmail),
    retry: false,
  });
  const person = lookup.data?.find(
    (candidate) => candidate.email.toLowerCase() === trimmedEmail.toLowerCase(),
  );

  function choosePreset(next: PlatformPresetName) {
    setTouchedPreset(true);
    setPreset(next);
    if (next !== 'custom') setChecked(new Set(presetSet(next)));
  }

  function toggle(permission: string, on: boolean) {
    setTouchedPreset(true);
    const next = new Set(checked);
    if (on) next.add(permission);
    else next.delete(permission);
    // Any change away from a named preset makes this admin Custom (the drawn hint).
    const named = PRESET_ORDER.find((candidate) => {
      if (candidate === 'custom') return false;
      const set = presetSet(candidate);
      return set.length === next.size && set.every((key) => next.has(key));
    });
    // "Manage this team" never travels with a Custom set.
    if (named === undefined) next.delete(TEAM_MANAGE);
    setChecked(next);
    setPreset(named ?? 'custom');
  }

  const trimmedReason = reason.trim();
  const reasonInvalid = trimmedReason.length < REASON_MIN || trimmedReason.length > REASON_MAX;

  const save = useMutation({
    mutationFn: () => {
      const permissions =
        preset === 'custom' ? [...checked].filter((key) => key !== TEAM_MANAGE) : undefined;
      if (editing && admin.id !== null) {
        return updatePlatformAdmin(api, admin.id, {
          preset,
          ...(permissions ? { permissions } : {}),
          reason: trimmedReason,
        });
      }
      return addPlatformAdmin(api, {
        email: trimmedEmail,
        preset,
        ...(permissions ? { permissions } : {}),
        reason: trimmedReason,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PLATFORM_TEAM_KEY });
      onClose(true);
    },
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
      }
    },
  });

  const fieldErrors = save.error instanceof ApiRequestError ? save.error.fieldErrors() : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (reasonInvalid || (!editing && trimmedEmail === '')) return;
    save.mutate();
  }

  const name = admin ? (admin.displayName ?? admin.email) : '';
  const presetHeading = `${t('PlatformTeam.permissionsHeading')} · ${t(PRESET_LABELS[preset])} ${t(
    'PlatformTeam.presetWord',
  )} — ${t('PlatformTeam.changeToCustom')}`;

  return (
    <PlatformDialog
      eyebrow={`${editing ? t('PlatformTeam.editEyebrow') : t('PlatformTeam.addEyebrow')} · ${t(
        'PlatformShared.reasonRequiredTag',
      )}`}
      title={editing ? `${t('PlatformTeam.editTitle')} ${name}` : t('PlatformTeam.addTitle')}
      width={780}
      onClose={() => onClose(false)}
    >
      <form className="tm-stack" onSubmit={submit} noValidate>
        <div ref={emailRef}>
          <Field
            label={t('PlatformTeam.accountLabel')}
            type="email"
            autoComplete="off"
            value={email}
            disabled={editing}
            onChange={(event) => setEmail(event.target.value)}
            {...(person
              ? {
                  hint: `✓ ${person.displayName} · ${
                    person.emailVerified
                      ? t('PlatformTeam.emailVerified')
                      : t('PlatformTeam.emailNotVerified')
                  } · ${t('PlatformTeam.memberOf')} ${person.companies.length} ${t('PlatformTeam.organizationsWord')}`,
                }
              : {})}
            {...(fieldErrors?.get('email') ? { error: platformErrorText(save.error, t) } : {})}
          />
        </div>

        <fieldset className="tm-stack tm-stack--tight" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="tm-cc-eyebrow">{t('PlatformTeam.presetHeading')}</legend>
          <div
            className="tm-cc-hero__actions"
            role="radiogroup"
            aria-label={t('PlatformTeam.presetHeading')}
          >
            {PRESET_ORDER.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={preset === candidate}
                className={preset === candidate ? 'tm-cc-pill tm-cc-pill--on' : 'tm-cc-pill'}
                onClick={() => choosePreset(candidate)}
              >
                {t(PRESET_LABELS[candidate])}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="tm-stack tm-stack--tight" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="tm-cc-eyebrow">{presetHeading}</legend>
          <div style={GRID}>
            {PLATFORM_PERMISSION_AREAS.map((area) => (
              <div key={area.id} className="tm-cc-card tm-cc-card--quiet tm-stack tm-stack--tight">
                <p className="tm-cc-cell-title">{t(AREA_LABELS[area.id])}</p>
                {area.permissions.map((permission) => (
                  <Checkbox
                    key={permission}
                    label={t(SHORT_LABELS[permission])}
                    checked={checked.has(permission)}
                    disabled={permission === TEAM_MANAGE && preset !== 'super_admin'}
                    onChange={(event) => toggle(permission, event.target.checked)}
                  />
                ))}
              </div>
            ))}
          </div>
          <p className="tm-cc-cell-sub">{t('PlatformTeam.teamManageNote')}</p>
        </fieldset>

        <Field
          label={t('PlatformShared.reasonRequired')}
          placeholder={t('PlatformShared.reasonPlaceholder')}
          value={reason}
          maxLength={REASON_MAX}
          required
          onChange={(event) => setReason(event.target.value)}
          {...(tried && reasonInvalid ? { error: t('PlatformShared.reasonError') } : {})}
        />

        {save.isError && !fieldErrors?.get('email') ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}

        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={() => onClose(false)}>
            {t('PlatformShared.cancel')}
          </Button>
          <Button
            type="submit"
            tone="ink"
            loading={save.isPending}
            loadingLabel={t('PlatformShared.working')}
          >
            {editing ? t('PlatformTeam.saveChanges') : t('PlatformTeam.addAdmin')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
