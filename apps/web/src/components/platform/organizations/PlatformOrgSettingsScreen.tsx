'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Switch } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import {
  fetchPlatformOrgSettings,
  removePlatformOrgLogo,
  setPlatformOrgFlag,
  setPlatformOrgPolicy,
  setPlatformOrgSetting,
  updatePlatformOrgProfile,
} from '../../../lib/api/platform-organizations';
import type {
  PlatformOrgDetailView,
  PlatformOrgSettingsView,
} from '../../../lib/api/platform-organizations';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import type { ScreenProps } from '../shared/platform-kit';
import { platformErrorText, ReasonDialog } from '../shared/ReasonDialog';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { ORGS_KEY, orgKey } from './org-kit';
import { OrgPage } from './OrgPage';

/** A4 `/platform/organizations/[id]/settings` — profile, settings, access policy and flags (frame A4). */
export function PlatformOrgSettingsScreen({
  client,
  organizationId,
}: ScreenProps & { organizationId: string }) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <OrgPage
      api={api}
      organizationId={organizationId}
      tab="settings"
      title={t('PlatformOrgs.tabSettings')}
    >
      {(detail) => <SettingsBody api={api} detail={detail} />}
    </OrgPage>
  );
}

function SettingsBody({ api, detail }: { api: ApiClient; detail: PlatformOrgDetailView }) {
  const t = useT();
  const id = detail.organization.id;
  const settings = useQuery({
    queryKey: orgKey(id, 'settings'),
    queryFn: () => fetchPlatformOrgSettings(api, id),
    retry: false,
  });
  return (
    <>
      <ProfileCard api={api} detail={detail} hasLogo={settings.data?.hasLogo ?? false} />
      {settings.isPending ? <PlatformPageState state="loading" /> : null}
      {settings.isError ? (
        <PlatformPageState
          state="error"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : null}
      {settings.isSuccess ? (
        <div className="tm-cc-split tm-cc-split--even">
          <SettingsCard api={api} id={id} view={settings.data} />
          <div className="tm-cc-column">
            <PolicyCard api={api} id={id} view={settings.data} />
            <FlagsCard api={api} id={id} view={settings.data} />
          </div>
        </div>
      ) : null}
      <p className="tm-cc-note">{t('PlatformOrgs.settingsAuditNote')}</p>
    </>
  );
}

interface ProfileDraft {
  name: string;
  slug: string;
  defaultLocale: string;
  timezone: string;
  operatorNotes: string;
}

function draftOf(detail: PlatformOrgDetailView): ProfileDraft {
  return {
    name: detail.organization.name,
    slug: detail.organization.slug,
    defaultLocale: detail.profile.defaultLocale,
    timezone: detail.profile.timezone,
    operatorNotes: detail.profile.operatorNotes ?? '',
  };
}

function ProfileCard({
  api,
  detail,
  hasLogo,
}: {
  api: ApiClient;
  detail: PlatformOrgDetailView;
  hasLogo: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const permissions = usePlatformPermissions(api);
  const canEdit = permissions.has('platform.orgs.edit');
  const id = detail.organization.id;
  const [saved, setSaved] = useState<ProfileDraft>(() => draftOf(detail));
  const [draft, setDraft] = useState<ProfileDraft>(saved);
  const [removingLogo, setRemovingLogo] = useState(false);
  const dirty = (Object.keys(draft) as (keyof ProfileDraft)[]).some(
    (key) => draft[key] !== saved[key],
  );
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const save = useMutation({
    mutationFn: () =>
      updatePlatformOrgProfile(api, id, {
        ...(draft.name !== saved.name ? { name: draft.name.trim() } : {}),
        ...(draft.slug !== saved.slug ? { slug: draft.slug.trim() } : {}),
        ...(draft.defaultLocale !== saved.defaultLocale
          ? { defaultLocale: draft.defaultLocale }
          : {}),
        ...(draft.timezone !== saved.timezone ? { timezone: draft.timezone } : {}),
        ...(draft.operatorNotes !== saved.operatorNotes
          ? { operatorNotes: draft.operatorNotes.trim() === '' ? null : draft.operatorNotes }
          : {}),
      }),
    onSuccess: async () => {
      setSaved(draft);
      await queryClient.invalidateQueries({ queryKey: ORGS_KEY });
    },
  });
  const slugTaken = save.error instanceof ApiRequestError && save.error.status === 409;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty) save.mutate();
  }
  const set = (key: keyof ProfileDraft) => (value: string) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  return (
    <section className="tm-cc-card" aria-labelledby="tm-org-profile">
      <div className="tm-cc-card__head">
        <h2 id="tm-org-profile" className="tm-cc-card__title">
          {t('PlatformOrgs.profile')}
        </h2>
        {dirty ? (
          <span className="tm-cc-pill tm-cc-pill--warning">{t('PlatformOrgs.unsavedChanges')}</span>
        ) : null}
      </div>
      <form className="tm-cc-form" onSubmit={submit} noValidate>
        <div className="tm-cc-form__pair">
          <Field
            label={t('PlatformOrgs.fieldOrgName')}
            value={draft.name}
            onChange={(e) => set('name')(e.target.value)}
            disabled={!canEdit}
          />
          <Field
            label={t('PlatformOrgs.fieldSlug')}
            hint={t('PlatformOrgs.slugHint')}
            value={draft.slug}
            onChange={(e) => set('slug')(e.target.value.toLowerCase())}
            disabled={!canEdit}
            {...(slugTaken ? { error: t('PlatformOrgs.slugTaken') } : {})}
          />
        </div>
        <div className="tm-cc-form__pair">
          <Field
            label={t('PlatformOrgs.fieldLocale')}
            value={draft.defaultLocale}
            onChange={(e) => set('defaultLocale')(e.target.value)}
            disabled={!canEdit}
          />
          <Field
            label={t('PlatformOrgs.fieldTimezone')}
            value={draft.timezone}
            onChange={(e) => set('timezone')(e.target.value)}
            disabled={!canEdit}
          />
        </div>
        <Field
          label={t('PlatformOrgs.operatorNotes')}
          hint={t('PlatformOrgs.operatorNotesHint')}
          value={draft.operatorNotes}
          onChange={(e) => set('operatorNotes')(e.target.value)}
          disabled={!canEdit}
        />
        <div className="tm-cc-hero__actions">
          <span className="tm-cc-note">
            {hasLogo ? t('PlatformOrgs.logoSet') : t('PlatformOrgs.noLogo')}
          </span>
          {hasLogo && canEdit ? (
            <Button
              type="button"
              tone="outline"
              size="compact"
              onClick={() => setRemovingLogo(true)}
            >
              {t('PlatformOrgs.removeLogo')}
            </Button>
          ) : null}
        </div>
        {save.isError && !slugTaken ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(save.error, t)}
          </InlineAlert>
        ) : null}
        {canEdit ? (
          <div className="tm-cc-card__actions tm-cc-card__actions--end">
            <Button type="button" tone="outline" disabled={!dirty} onClick={() => setDraft(saved)}>
              {t('PlatformOrgs.discard')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              disabled={!dirty}
              loading={save.isPending}
              loadingLabel={t('PlatformShared.working')}
            >
              {t('PlatformOrgs.saveChanges')}
            </Button>
          </div>
        ) : null}
      </form>
      {removingLogo ? (
        <ReasonDialog
          title={t('PlatformOrgs.removeLogo')}
          reasonRequired={false}
          destructive
          confirmLabel={t('PlatformOrgs.removeLogo')}
          onConfirm={() => removePlatformOrgLogo(api, id)}
          onClose={(done) => {
            setRemovingLogo(false);
            if (done) void queryClient.invalidateQueries({ queryKey: orgKey(id) });
          }}
        />
      ) : null}
    </section>
  );
}

function SettingsCard({
  api,
  id,
  view,
}: {
  api: ApiClient;
  id: string;
  view: PlatformOrgSettingsView;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const canEdit = usePlatformPermissions(api).has('platform.orgs.edit');
  const change = useMutation({
    mutationFn: (input: { key: string; value: string }) =>
      setPlatformOrgSetting(api, id, input.key, input.value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey(id, 'settings') }),
  });
  return (
    <section className="tm-cc-card" aria-labelledby="tm-org-settings">
      <div className="tm-cc-card__head">
        <h2 id="tm-org-settings" className="tm-cc-card__title">
          {t('PlatformOrgs.organizationSettings')}
        </h2>
      </div>
      {view.settings.length === 0 ? (
        <p className="tm-cc-note">{t('PlatformOrgs.noSettings')}</p>
      ) : null}
      {view.settings.map((setting) =>
        setting.value === 'true' || setting.value === 'false' ? (
          <div key={setting.key} className="tm-cc-setting">
            <Switch
              label={<span className="tm-cc-cell-mono">{setting.key}</span>}
              {...(setting.ownerOnly ? { hint: t('PlatformOrgs.ownerOnly') } : {})}
              checked={setting.value === 'true'}
              disabled={!canEdit || change.isPending}
              onChange={(e) =>
                change.mutate({ key: setting.key, value: e.target.checked ? 'true' : 'false' })
              }
            />
          </div>
        ) : (
          <div key={setting.key} className="tm-cc-setting">
            <span className="tm-cc-cell-mono">{setting.key}</span>
            <span>{setting.value}</span>
          </div>
        ),
      )}
      {change.isError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(change.error, t)}
        </InlineAlert>
      ) : null}
    </section>
  );
}

function PolicyCard({
  api,
  id,
  view,
}: {
  api: ApiClient;
  id: string;
  view: PlatformOrgSettingsView;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const canEdit = usePlatformPermissions(api).has('platform.orgs.edit');
  const [hours, setHours] = useState(String(view.policy.session_max_hours));
  const [domains, setDomains] = useState(view.policy.invite_domain_allowlist.join(', '));
  const change = useMutation({
    mutationFn: (patch: Record<string, unknown>) => setPlatformOrgPolicy(api, id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey(id, 'settings') }),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const allowlist = domains
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    change.mutate({ session_max_hours: Number(hours), invite_domain_allowlist: allowlist });
  }
  return (
    <section className="tm-cc-card" aria-labelledby="tm-org-policy">
      <div className="tm-cc-card__head">
        <h2 id="tm-org-policy" className="tm-cc-card__title">
          {t('PlatformOrgs.accessPolicy')}
        </h2>
      </div>
      <form className="tm-cc-form" onSubmit={submit} noValidate>
        <Switch
          label={t('PlatformOrgs.guestAccess')}
          checked={view.policy.guest_access_enabled}
          disabled={!canEdit || change.isPending}
          onChange={(e) => change.mutate({ guest_access_enabled: e.target.checked })}
        />
        <Field
          label={t('PlatformOrgs.sessionMaxHours')}
          type="number"
          min={1}
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          disabled={!canEdit}
        />
        <Field
          label={t('PlatformOrgs.inviteDomains')}
          hint={t('PlatformOrgs.inviteDomainsHint')}
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          disabled={!canEdit}
        />
        {change.isError ? (
          <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
            {platformErrorText(change.error, t)}
          </InlineAlert>
        ) : null}
        {canEdit ? (
          <div className="tm-cc-card__actions tm-cc-card__actions--end">
            <Button
              type="submit"
              tone="outline"
              loading={change.isPending}
              loadingLabel={t('PlatformShared.working')}
            >
              {t('PlatformOrgs.savePolicy')}
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function FlagsCard({
  api,
  id,
  view,
}: {
  api: ApiClient;
  id: string;
  view: PlatformOrgSettingsView;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const canEdit = usePlatformPermissions(api).has('platform.orgs.edit');
  const change = useMutation({
    mutationFn: (input: { key: string; enabled: boolean | null }) =>
      setPlatformOrgFlag(api, id, input.key, input.enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey(id, 'settings') }),
  });
  return (
    <section className="tm-cc-card" aria-labelledby="tm-org-flags">
      <div className="tm-cc-card__head">
        <h2 id="tm-org-flags" className="tm-cc-card__title">
          {t('PlatformOrgs.featureFlags')}
        </h2>
      </div>
      {view.flags.length === 0 ? <p className="tm-cc-note">{t('PlatformOrgs.noFlags')}</p> : null}
      {view.flags.map((flag) => (
        <div key={flag.key} className="tm-cc-setting">
          <Switch
            label={<span className="tm-cc-cell-mono">{flag.key}</span>}
            hint={flag.isDefault ? t('PlatformOrgs.platformDefault') : t('PlatformOrgs.overridden')}
            checked={flag.enabled}
            disabled={!canEdit || change.isPending}
            onChange={(e) => change.mutate({ key: flag.key, enabled: e.target.checked })}
          />
          {!flag.isDefault && canEdit ? (
            <Button
              type="button"
              tone="text"
              size="compact"
              onClick={() => change.mutate({ key: flag.key, enabled: null })}
            >
              {t('PlatformOrgs.useDefault')}
            </Button>
          ) : null}
        </div>
      ))}
      {change.isError ? (
        <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
          {platformErrorText(change.error, t)}
        </InlineAlert>
      ) : null}
    </section>
  );
}
