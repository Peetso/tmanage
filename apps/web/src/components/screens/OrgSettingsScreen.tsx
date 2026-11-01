'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import {
  MEMBER_SWITCH_KEYS,
  memberSwitches,
  readOrgSettings,
  setOrgSetting,
  type MemberSwitchKey,
} from '../../lib/api/org-settings';
import { readOrganizationProfile, renameOrganization } from '../../lib/api/organizations';
import { setTwoStepRequirement } from '../../lib/api/admin-security';
import {
  LOGO_IMAGE_ACCEPT,
  logoImageUrl,
  readOrganizationLogo,
  removeOrganizationLogoImage,
  uploadOrganizationLogoImage,
  type OrganizationLogoView,
} from '../../lib/api/organization-logo';
import {
  DEFAULT_SETTING_KEYS,
  OPERATING_TEMPLATE_OPTIONS,
  WORKING_WEEK_OPTIONS,
  defaultSettings,
  isValidReauthMinutes,
  type DefaultSettingKey,
} from '../../lib/api/org-defaults';
import { ApiRequestError } from '../../lib/api/errors';
import { TimeZoneSelect } from '../TimeZoneSelect';
import type { ApiClient } from '../../lib/api/client';
import { useOrganizationName, useOrganizationRole } from '../../lib/use-organization-names';
import { roleMayUse } from '../../lib/role-capability';
import { useT } from '../../lib/i18n/use-t';
import {
  OFFERED_LOCALES,
  isBetaLocale,
  localeLangAttribute,
  localeNativeName,
} from '../../lib/i18n/catalog-status';
import { useTOr } from '../../lib/i18n/use-t-or';
import { DownloadScanPolicyCard } from './DownloadScanPolicyCard';
import { DataLocationCard } from './DataLocationCard';
import './org-settings.css';

export interface OrgSettingsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** Injected by tests: the logo upload (defaults to the organization logo route). */
  uploadLogo?: (file: File) => Promise<OrganizationLogoView>;
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

/**
 * "Northstar Studio" → "NS"; one word gives its first two letters. The first two words, the same
 * rule the organization picker uses, so one organization never shows two different monograms
 * ("QA test (delete me)" read "QM" here and "QT" in the picker, live test 2026-10-31).
 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
}

/**
 * **Organization settings (A11, Figma `fq12-organization-settings`).**
 *
 * One card: the organization's logo (initials until one is uploaded) and name, then "What members
 * can do" — four switches stored as allowlisted org settings — then "Time and defaults" (C6): the
 * pre-A11 settings (timezone, working week, operating template, re-authentication window, new
 * projects client-visible) as plain fields. Upload logo / Remove apply at once;
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

  // H1: a custom role whose set holds `org.manage` opens the page too.
  const { role, capabilities, known } = useOrganizationRole(organizationSlug);
  const mayManage = known ? roleMayUse(role, capabilities, 'org.manage') : null;
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
  const logoInfo = useQuery({
    queryKey: ['org-logo', organizationSlug],
    queryFn: () => readOrganizationLogo(api, organizationSlug),
    enabled: mayManage === true,
  });

  const loadedSwitches = memberSwitches(settings.data);
  const loadedName = profile.data?.name ?? '';
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [switchDrafts, setSwitchDrafts] = useState<Partial<Record<MemberSwitchKey, boolean>>>({});
  const loadedDefaults = defaultSettings(settings.data);
  const [defaultDrafts, setDefaultDrafts] = useState<Partial<Record<DefaultSettingKey, string>>>(
    {},
  );
  // R12 R2 (Figma "Languages (R2)" 501:29345): the workspace's default language, stored on
  // `organizations.default_locale` (legacy `en`/`ar` read as their offered locale).
  const storedLocale = settings.data?.settings.find(
    (entry) => entry.key === 'default_locale',
  )?.value;
  const loadedLocale =
    storedLocale === 'ar'
      ? 'ar-EG'
      : storedLocale === 'en' || !storedLocale
        ? 'en-US'
        : storedLocale;
  const [localeDraft, setLocaleDraft] = useState<string | null>(null);
  const localeChanged = localeDraft !== null && localeDraft !== loadedLocale;
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const name = nameDraft ?? loadedName;
  const switchValue = (key: MemberSwitchKey) => switchDrafts[key] ?? loadedSwitches[key];
  const changedSwitches = MEMBER_SWITCH_KEYS.filter(
    (key) => switchDrafts[key] !== undefined && switchDrafts[key] !== loadedSwitches[key],
  );
  const defaultValue = (key: DefaultSettingKey) => defaultDrafts[key] ?? loadedDefaults[key];
  const changedDefaults = DEFAULT_SETTING_KEYS.filter(
    (key) => defaultDrafts[key] !== undefined && defaultDrafts[key] !== loadedDefaults[key],
  );
  const reauthValid = isValidReauthMinutes(defaultValue('require_reauth_minutes'));
  const nameChanged = nameDraft !== null && nameDraft.trim() !== loadedName;
  const dirty =
    nameChanged || changedSwitches.length > 0 || changedDefaults.length > 0 || localeChanged;
  const setDefault = (key: DefaultSettingKey, value: string) => {
    setSaved(false);
    setDefaultDrafts((current) => ({ ...current, [key]: value }));
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['org-settings', organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ['org-profile', organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ['org-logo', organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ['shell', 'organizations'] }),
    ]);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (nameChanged) await renameOrganization(api, organizationSlug, (nameDraft ?? '').trim());
      for (const key of changedSwitches) {
        // Wave 9 S8 (F09/F12b): the two-step requirement is the owner's, saved on its own route.
        if (key === 'require_two_step') {
          await setTwoStepRequirement(api, organizationSlug, switchDrafts[key] === true);
          continue;
        }
        await setOrgSetting(api, organizationSlug, key, String(switchDrafts[key]));
      }
      for (const key of changedDefaults) {
        await setOrgSetting(api, organizationSlug, key, (defaultDrafts[key] ?? '').trim());
      }
      if (localeChanged) {
        await setOrgSetting(api, organizationSlug, 'default_locale', localeDraft ?? loadedLocale);
      }
    },
    onSuccess: async () => {
      setLocaleDraft(null);
      setNameDraft(null);
      setSwitchDrafts({});
      setDefaultDrafts({});
      setSaved(true);
      await refresh();
    },
  });

  const logo = useMutation({
    mutationFn: async (action: { kind: 'upload'; file: File } | { kind: 'remove' }) => {
      if (action.kind === 'remove') return removeOrganizationLogoImage(api, organizationSlug);
      return (
        uploadLogo ?? ((file: File) => uploadOrganizationLogoImage(api, organizationSlug, file))
      )(action.file);
    },
    onSuccess: async (view) => {
      queryClient.setQueryData(['org-logo', organizationSlug], view);
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
    setDefaultDrafts({});
    setSaved(false);
    save.reset();
  };

  if (mayManage === false) return null;

  const loading = settings.isPending || profile.isPending || logoInfo.isPending;
  const loadError = settings.isError || profile.isError || logoInfo.isError;
  const logoFileId = profile.data?.logoFileId ?? null;
  const logoImage = logoInfo.data?.logo ?? null;
  const logoSrc = logoImage
    ? logoImageUrl(apiBaseUrl(), organizationSlug, logoImage.version)
    : logoFileId
      ? `${apiBaseUrl()}/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(logoFileId)}/content`
      : null;

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
                {logoSrc ? (
                  <img src={logoSrc} alt="" />
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
                    'OrgSettingsScreen.a11.logoHintTypes',
                    'PNG, JPEG, WebP or SVG, at least 256 px and up to 512 KB. Shown in the app, in emails and in the client portal.',
                  )}
                </p>
              </div>
              <div className="tm-orgset-logo__actions">
                {logoSrc ? (
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
                  accept={LOGO_IMAGE_ACCEPT}
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
                // Wave 9 S8: only the company owner changes the two-step requirement; others read it.
                const ownerOnly = key === 'require_two_step' && known && role !== 'owner';
                return (
                  <li key={key} className="tm-orgset-switch">
                    <span className="tm-orgset-switch__text">
                      <span className="tm-orgset-switch__label" id={labelId}>
                        {tr(`OrgSettingsScreen.a11.${key}`, copy.label)}
                      </span>
                      {copy.hint ? (
                        <span className="tm-orgset-switch__hint" id={hintId}>
                          {ownerOnly
                            ? tr(
                                'OrgSettingsScreen.s8.twoStepOwnerOnly',
                                'Only the company owner can change this setting.',
                              )
                            : tr(`OrgSettingsScreen.a11.${key}Hint`, copy.hint)}
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
                      disabled={ownerOnly}
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

            <h3 className="tm-orgset__section">
              {tr('OrgSettingsScreen.a11.defaultsTitle', 'Time and defaults')}
            </h3>
            <div className="tm-orgset-fields">
              <TimeZoneSelect
                label={tr('OrgSettingsScreen.a11.default_timezone', 'Default timezone')}
                hint={tr(
                  'OrgSettingsScreen.a11.default_timezoneHint',
                  'New projects and deadlines use this timezone.',
                )}
                name="default_timezone"
                value={defaultValue('default_timezone')}
                onChange={(zone) => setDefault('default_timezone', zone)}
              />
              <Select
                label={t('OrgSettings.defaultLanguage')}
                hint={t('OrgSettings.defaultLanguageHint')}
                name="default_locale"
                value={localeDraft ?? loadedLocale}
                onChange={(event) => {
                  setSaved(false);
                  setLocaleDraft(event.target.value);
                }}
              >
                {OFFERED_LOCALES.map((value) => (
                  <option key={value} value={value} lang={localeLangAttribute(value)}>
                    {isBetaLocale(value)
                      ? `${localeNativeName(value)} · ${t('LanguagePicker.beta')}`
                      : localeNativeName(value)}
                  </option>
                ))}
              </Select>
              <Select
                label={tr('OrgSettingsScreen.a11.working_week', 'Working week')}
                name="working_week"
                value={defaultValue('working_week')}
                onChange={(event) => setDefault('working_week', event.target.value)}
              >
                {WORKING_WEEK_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </Select>
              <Select
                label={tr('OrgSettingsScreen.a11.operating_template', 'How work moves')}
                hint={tr(
                  'OrgSettingsScreen.a11.operating_templateHint',
                  'The workflow new projects start with.',
                )}
                name="operating_template"
                value={defaultValue('operating_template')}
                onChange={(event) => setDefault('operating_template', event.target.value)}
              >
                {OPERATING_TEMPLATE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </Select>
              <Field
                label={tr(
                  'OrgSettingsScreen.a11.require_reauth_minutes',
                  'Ask for the password again after (minutes)',
                )}
                hint={tr(
                  'OrgSettingsScreen.a11.require_reauth_minutesHint',
                  'Before a sensitive action. 0 turns it off; at most 1440 (a day).',
                )}
                name="require_reauth_minutes"
                inputMode="numeric"
                value={defaultValue('require_reauth_minutes')}
                error={
                  reauthValid
                    ? undefined
                    : tr(
                        'OrgSettingsScreen.a11.require_reauth_minutesError',
                        'Enter a whole number from 0 to 1440.',
                      )
                }
                onChange={(event) => setDefault('require_reauth_minutes', event.target.value)}
              />
            </div>
            <ul className="tm-orgset-switches">
              <li className="tm-orgset-switch">
                <span className="tm-orgset-switch__text">
                  <span
                    className="tm-orgset-switch__label"
                    id="tm-orgset-client_visible_project_default-label"
                  >
                    {tr(
                      'OrgSettingsScreen.a11.client_visible_project_default',
                      'New projects are visible to clients',
                    )}
                  </span>
                  <span
                    className="tm-orgset-switch__hint"
                    id="tm-orgset-client_visible_project_default-hint"
                  >
                    {tr(
                      'OrgSettingsScreen.a11.client_visible_project_defaultHint',
                      'When off, nothing in a new project is shared until you choose to.',
                    )}
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="tm-switch"
                  aria-labelledby="tm-orgset-client_visible_project_default-label"
                  aria-describedby="tm-orgset-client_visible_project_default-hint"
                  checked={defaultValue('client_visible_project_default') === 'true'}
                  onChange={(event) =>
                    setDefault('client_visible_project_default', String(event.target.checked))
                  }
                />
              </li>
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
                disabled={(nameChanged && (nameDraft ?? '').trim() === '') || !reauthValid}
                onClick={() => save.mutate()}
              >
                {tr('OrgSettingsScreen.a11.save', 'Save changes')}
              </Button>
            </div>
          </>
        ) : null}
      </section>

      <DataLocationCard organizationName={organizationName} client={api} />

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
    return tr('OrgSettingsScreen.a11.logoTypes', 'Choose a PNG, JPEG, WebP or SVG file.');
  }
  if (error instanceof Error && error.message === 'logo_size') {
    return tr(
      'OrgSettingsScreen.a11.logoSize',
      'The logo is larger than 512 KB. Save a smaller file and try again.',
    );
  }
  return tr('OrgSettingsScreen.a11.tryAgainLater', 'Something went wrong. Try again.');
}
