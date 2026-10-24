'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { hasCapability, isRole } from '@tmanage/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import {
  MEMBER_SWITCH_KEYS,
  memberSwitches,
  readOrgSettings,
  setOrgSetting,
  type MemberSwitchKey,
} from '../../lib/api/org-settings';
import {
  LOGO_ACCEPT,
  readOrganizationProfile,
  removeOrganizationLogo,
  renameOrganization,
  setOrganizationLogo,
  uploadOrganizationLogo,
} from '../../lib/api/organizations';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useOrganizationName, useOrganizationRole } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { DownloadScanPolicyCard } from './DownloadScanPolicyCard';
import './org-settings.css';

export interface OrgSettingsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** Injected by tests: the logo upload (defaults to the real upload pipeline). */
  uploadLogo?: (file: File) => Promise<string>;
}

/** The switch rows, in the frame's order, with their English defaults until the catalog merges. */
const SWITCH_COPY: Readonly<Record<MemberSwitchKey, { label: string; hint?: string }>> = {
  members_can_create_projects: { label: 'Members can create projects' },
  members_can_invite_clients: {
    label: 'Members can invite clients',
    hint: 'When off, only admins and project leads can.',
  },
  clients_can_upload_files: { label: 'Clients can upload files' },
  require_two_step: {
    label: 'Everyone must use two-step sign-in',
    hint: 'People without it are asked to set it up at their next sign-in.',
  },
};

/** "Northstar Studio" → "NS"; one word gives its first two letters. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

/**
 * **Organization settings (A11, Figma `fq12-organization-settings`).**
 *
 * One card: the organization's logo (initials until one is uploaded) and name, then "What members
 * can do" — four switches stored as allowlisted org settings. Upload logo / Remove apply at once;
 * the name and the switches are drafts until Save changes, which writes the name (when it changed)
 * and each switch that changed. Cancel puts every draft back.
 *
 * `/settings` is behind `org.manage` (ACT-13): a person whose role cannot manage the organization
 * is sent to their own Preferences, and the refused reads are never made.
 */
export function OrgSettingsScreen({
  organizationSlug,
  organizationName: passedOrganizationName,
  client,
  uploadLogo,
}: OrgSettingsScreenProps) {
  const organizationName = useOrganizationName(organizationSlug, passedOrganizationName);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const tr = useTOr();

  const { role, known } = useOrganizationRole(organizationSlug);
  const mayManage = known
    ? role !== undefined && isRole(role) && hasCapability(role, 'org.manage')
    : null;
  useEffect(() => {
    if (mayManage === false) window.location.replace(`/${organizationSlug}/preferences`);
  }, [mayManage, organizationSlug]);

  const settings = useQuery({
    queryKey: ['org-settings', organizationSlug],
    queryFn: () => readOrgSettings(api, organizationSlug),
    enabled: mayManage === true,
  });
  const profile = useQuery({
    queryKey: ['org-profile', organizationSlug],
    queryFn: () => readOrganizationProfile(api, organizationSlug),
    enabled: mayManage === true,
  });

  const loadedSwitches = memberSwitches(settings.data);
  const loadedName = profile.data?.name ?? '';
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [switchDrafts, setSwitchDrafts] = useState<Partial<Record<MemberSwitchKey, boolean>>>({});
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const name = nameDraft ?? loadedName;
  const switchValue = (key: MemberSwitchKey) => switchDrafts[key] ?? loadedSwitches[key];
  const changedSwitches = MEMBER_SWITCH_KEYS.filter(
    (key) => switchDrafts[key] !== undefined && switchDrafts[key] !== loadedSwitches[key],
  );
  const nameChanged = nameDraft !== null && nameDraft.trim() !== loadedName;
  const dirty = nameChanged || changedSwitches.length > 0;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['org-settings', organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ['org-profile', organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ['shell', 'organizations'] }),
    ]);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (nameChanged) await renameOrganization(api, organizationSlug, (nameDraft ?? '').trim());
      for (const key of changedSwitches) {
        await setOrgSetting(api, organizationSlug, key, String(switchDrafts[key]));
      }
    },
    onSuccess: async () => {
      setNameDraft(null);
      setSwitchDrafts({});
      setSaved(true);
      await refresh();
    },
  });

  const logo = useMutation({
    mutationFn: async (action: { kind: 'upload'; file: File } | { kind: 'remove' }) => {
      if (action.kind === 'remove') return removeOrganizationLogo(api, organizationSlug);
      const fileId = await (
        uploadLogo ?? ((file: File) => uploadOrganizationLogo(api, organizationSlug, file))
      )(action.file);
      return setOrganizationLogo(api, organizationSlug, fileId);
    },
    onSuccess: async (view) => {
      queryClient.setQueryData(['org-profile', organizationSlug], view);
      await refresh();
    },
  });

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) logo.mutate({ kind: 'upload', file });
  };

  const cancel = () => {
    setNameDraft(null);
    setSwitchDrafts({});
    setSaved(false);
    save.reset();
  };

  if (mayManage === false) return null;

  const loading = settings.isPending || profile.isPending;
  const loadError = settings.isError || profile.isError;
  const logoFileId = profile.data?.logoFileId ?? null;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="organization"
      crumbs={[t('OrgSettingsScreen.crumbOrganization')]}
      title={organizationName}
    >
      <section className="tm-orgset" aria-labelledby="tm-orgset-title">
        <h2 id="tm-orgset-title" className="tm-orgset__title">
          {tr('OrgSettingsScreen.a11.title', 'Organization')}
        </h2>

        {loadError ? (
          <InlineAlert
            tone="danger"
            title={tr('OrgSettingsScreen.a11.loadError', 'Could not load the settings')}
            live
          >
            {tr('OrgSettingsScreen.a11.tryAgain', 'Reload the page to try again.')}
          </InlineAlert>
        ) : null}

        {loading && !loadError ? (
          <LoadingRegion label={t('OrgSettingsScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!loading && !loadError ? (
          <>
            <div className="tm-orgset-logo">
              <span className="tm-orgset-logo__orb" aria-hidden="true">
                {logoFileId ? (
                  <img
                    src={`${apiBaseUrl()}/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(logoFileId)}/content`}
                    alt=""
                  />
                ) : (
                  initialsOf(loadedName || organizationName)
                )}
              </span>
              <div className="tm-orgset-logo__text">
                <p className="tm-orgset-logo__label" id="tm-orgset-logo-label">
                  {tr('OrgSettingsScreen.a11.logo', 'Logo')}
                </p>
                <p className="tm-orgset-logo__hint">
                  {tr(
                    'OrgSettingsScreen.a11.logoHint',
                    'PNG or SVG, at least 256 px. Shown in the app, in emails and in the client portal.',
                  )}
                </p>
              </div>
              <div className="tm-orgset-logo__actions">
                {logoFileId ? (
                  <Button
                    type="button"
                    tone="text"
                    onClick={() => logo.mutate({ kind: 'remove' })}
                    disabled={logo.isPending}
                  >
                    {tr('OrgSettingsScreen.a11.removeLogo', 'Remove')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  tone="outline"
                  className="tm-orgset-btn"
                  loading={logo.isPending}
                  loadingLabel={tr('OrgSettingsScreen.a11.uploading', 'Uploading')}
                  onClick={() => fileInput.current?.click()}
                >
                  {tr('OrgSettingsScreen.a11.uploadLogo', 'Upload logo')}
                </Button>
                <input
                  ref={fileInput}
                  className="tm-orgset-file"
                  type="file"
                  accept={LOGO_ACCEPT}
                  aria-labelledby="tm-orgset-logo-label"
                  tabIndex={-1}
                  onChange={onFile}
                />
              </div>
            </div>
            {logo.isError ? (
              <InlineAlert
                tone="danger"
                title={tr('OrgSettingsScreen.a11.logoError', 'Could not change the logo')}
                live
              >
                {logoProblem(logo.error, tr)}
              </InlineAlert>
            ) : null}

            <div className="tm-orgset-name">
              <Field
                label={tr('OrgSettingsScreen.a11.name', 'Organization name')}
                name="organization-name"
                value={name}
                maxLength={190}
                onChange={(event) => {
                  setSaved(false);
                  setNameDraft(event.target.value);
                }}
              />
            </div>

            <hr className="tm-orgset-rule" />

            <h3 className="tm-orgset__section">
              {tr('OrgSettingsScreen.a11.membersTitle', 'What members can do')}
            </h3>
            <ul className="tm-orgset-switches">
              {MEMBER_SWITCH_KEYS.map((key) => {
                const copy = SWITCH_COPY[key];
                const labelId = `tm-orgset-${key}-label`;
                const hintId = `tm-orgset-${key}-hint`;
                return (
                  <li key={key} className="tm-orgset-switch">
                    <span className="tm-orgset-switch__text">
                      <span className="tm-orgset-switch__label" id={labelId}>
                        {tr(`OrgSettingsScreen.a11.${key}`, copy.label)}
                      </span>
                      {copy.hint ? (
                        <span className="tm-orgset-switch__hint" id={hintId}>
                          {tr(`OrgSettingsScreen.a11.${key}Hint`, copy.hint)}
                        </span>
                      ) : null}
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      className="tm-switch"
                      aria-labelledby={labelId}
                      aria-describedby={copy.hint ? hintId : undefined}
                      checked={switchValue(key)}
                      onChange={(event) => {
                        setSaved(false);
                        const checked = event.target.checked;
                        setSwitchDrafts((current) => ({ ...current, [key]: checked }));
                      }}
                    />
                  </li>
                );
              })}
            </ul>

            <hr className="tm-orgset-rule" />

            {save.isError ? (
              <InlineAlert
                tone="danger"
                title={tr('OrgSettingsScreen.a11.saveError', 'Could not save the changes')}
                live
              >
                {save.error instanceof ApiRequestError
                  ? save.error.message
                  : tr('OrgSettingsScreen.a11.tryAgainLater', 'Something went wrong. Try again.')}
              </InlineAlert>
            ) : null}
            {saved && !dirty ? (
              <InlineAlert
                tone="success"
                title={tr('OrgSettingsScreen.a11.saved', 'Changes saved')}
                live
              >
                {tr('OrgSettingsScreen.a11.savedBody', 'They apply to everyone right away.')}
              </InlineAlert>
            ) : null}

            <div className="tm-orgset-footer">
              <Button
                type="button"
                tone="outline"
                className="tm-orgset-btn"
                onClick={cancel}
                disabled={save.isPending}
              >
                {tr('OrgSettingsScreen.a11.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                tone="ink"
                className="tm-orgset-btn"
                loading={save.isPending}
                loadingLabel={t('OrgSettingsScreen.saving')}
                disabled={nameChanged && (nameDraft ?? '').trim() === ''}
                onClick={() => save.mutate()}
              >
                {tr('OrgSettingsScreen.a11.save', 'Save changes')}
              </Button>
            </div>
          </>
        ) : null}
      </section>

      {mayManage === true ? (
        <DownloadScanPolicyCard
          organizationSlug={organizationSlug}
          client={api}
          isOwner={role === 'owner'}
        />
      ) : null}
    </ControlCenterShell>
  );
}

/** The sentence for a failed logo change. */
function logoProblem(error: unknown, tr: (key: string, english: string) => string): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.message === 'logo_type') {
    return tr('OrgSettingsScreen.a11.logoType', 'Choose a PNG or SVG file.');
  }
  if (error instanceof Error && error.message === 'logo_no_project') {
    return tr(
      'OrgSettingsScreen.a11.logoNoProject',
      'Create a project first, then upload the logo.',
    );
  }
  return tr('OrgSettingsScreen.a11.tryAgainLater', 'Something went wrong. Try again.');
}
