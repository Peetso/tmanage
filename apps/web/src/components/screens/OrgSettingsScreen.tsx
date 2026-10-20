'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { hasCapability, isRole } from '@tmanage/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { readOrgSettings, setOrgSetting } from '../../lib/api/org-settings';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useOrganizationName, useOrganizationRole } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';

export interface OrgSettingsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Human labels and hints for the allowlisted keys. A key without an entry falls back to its raw name. */
const LABELS: Readonly<Record<string, { label: string; hint: string }>> = {
  default_timezone: {
    label: 'Default timezone',
    hint: 'An IANA name such as Europe/London. New projects and deadlines fall back to this.',
  },
  require_reauth_minutes: {
    label: 'Re-authentication window (minutes)',
    hint: 'How long before a sensitive action asks for the password again. 0 disables it.',
  },
  client_visible_project_default: {
    label: 'New projects client-visible by default',
    hint: 'Enter true or false. Off by default, so nothing is shared until you choose to.',
  },
  working_week: { label: 'Working week', hint: 'mon-fri, sun-thu, sat-wed or mon-sat.' },
  operating_template: {
    label: 'Operating template',
    hint: 'delivery-client-review, intake-commitment, internal-delivery or empty.',
  },
};

/**
 * **Organization settings / policy (Administration module 18, x153).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration (org settings/policy). This screen reads the organization's
 * settings — every allowlisted key with its current value — and sets one at a time. It is a faithful
 * reader of the API's fixed-key allowlist: the fields shown are exactly the keys the API returns, and
 * a save PUTs one key, which the API validates against its allowlist and per-key validator.
 *
 * ## What it does, and what it cannot
 *
 * - **The role / capability editor is not here.** ADM-03 is blocked pending the permission-matrix
 *   work; this screen is the flat key/value policy surface only. Security-policy escalations are
 *   deferred (NEXT-SCOPES-13).
 * - **A setting is set, never cleared here.** The API grants no delete path, so there is no reset
 *   control — a setting is changed to a new value, and the default stands until it is.
 */
export function OrgSettingsScreen({
  organizationSlug,
  organizationName: passedOrganizationName,
  client,
}: OrgSettingsScreenProps) {
  const organizationName = useOrganizationName(organizationSlug, passedOrganizationName);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  // ACT-13: `/settings` is the organization's settings, behind `org.manage`. A person whose role
  // cannot manage the organization (a member who typed the address) is sent to their own
  // Preferences instead of the admin menu and a permission error — and the refused read, which
  // would only add a denied row to the audit log, is never made.
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

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savedKey, setSavedKey] = useState<string | null>(null);

  // Seed the editable drafts from the loaded values once they arrive, without clobbering edits.
  useEffect(() => {
    if (!settings.data) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const entry of settings.data.settings) {
        if (!(entry.key in next)) next[entry.key] = entry.value;
      }
      return next;
    });
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (key: string) => setOrgSetting(api, organizationSlug, key, drafts[key] ?? ''),
    onSuccess: async (_data, key) => {
      setSavedKey(key);
      await queryClient.invalidateQueries({ queryKey: ['org-settings', organizationSlug] });
    },
  });

  const rows = settings.data?.settings ?? [];

  if (mayManage === false) return null;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="organization"
      crumbs={[t('OrgSettingsScreen.crumbOrganization')]}
      title={organizationName}
      actions={
        <Link
          href={`/${organizationSlug}/admin`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          {t('OrgSettingsScreen.controlCenter')}
        </Link>
      }
    >
      <div className="tm-cc-split tm-cc-split--even">
        <section className="tm-cc-card" aria-labelledby="tm-org-settings-heading">
          <h2 id="tm-org-settings-heading" className="tm-cc-eyebrow">
            {t('OrgSettingsScreen.settingsHeading')}
          </h2>

          {settings.isError ? (
            <InlineAlert tone="danger" title={t('OrgSettingsScreen.loadErrorTitle')} live>
              {describeError(settings.error)}
            </InlineAlert>
          ) : null}

          {settings.isPending ? (
            <LoadingRegion label={t('OrgSettingsScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!settings.isPending && !settings.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title={t('OrgSettingsScreen.emptyTitle')}>
              {t('OrgSettingsScreen.emptyBody')}
            </InlineAlert>
          ) : null}

          {rows.length > 0 ? (
            <ul className="tm-cc-rows">
              {rows.map((entry) => {
                const meta = LABELS[entry.key];
                return (
                  <li key={entry.key}>
                    <form
                      className="tm-stack tm-cc-rows__grow"
                      noValidate
                      aria-label={`${meta?.label ?? entry.key} ${t('OrgSettingsScreen.settingSuffix')}`}
                      onSubmit={(event: FormEvent<HTMLFormElement>) => {
                        event.preventDefault();
                        if (!save.isPending) save.mutate(entry.key);
                      }}
                    >
                      <div className="tm-cc-setting">
                        <Field
                          label={meta?.label ?? entry.key}
                          name={`setting-${entry.key}`}
                          value={drafts[entry.key] ?? entry.value}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [entry.key]: event.target.value,
                            }))
                          }
                          hint={meta?.hint}
                        />
                        <Button
                          type="submit"
                          tone="ink"
                          size="default"
                          loading={save.isPending && save.variables === entry.key}
                          loadingLabel={t('OrgSettingsScreen.saving')}
                        >
                          {t('OrgSettingsScreen.save')}
                        </Button>
                      </div>
                      {save.isError && save.variables === entry.key ? (
                        <InlineAlert
                          tone="danger"
                          title={t('OrgSettingsScreen.saveErrorTitle')}
                          live
                        >
                          {describeError(save.error)}
                        </InlineAlert>
                      ) : null}
                      {savedKey === entry.key && !save.isPending && !save.isError ? (
                        <InlineAlert tone="success" title={t('OrgSettingsScreen.savedTitle')} live>
                          {t('OrgSettingsScreen.savedBody')}
                        </InlineAlert>
                      ) : null}
                    </form>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <div className="tm-cc-column">
          <section className="tm-cc-card" aria-labelledby="tm-org-settings-elsewhere">
            <h2 id="tm-org-settings-elsewhere" className="tm-cc-card__title">
              {t('OrgSettingsScreen.elsewhereTitle')}
            </h2>
            <ul className="tm-cc-rows">
              <li>
                <div className="tm-cc-rows__text">
                  <p className="tm-cc-rows__title">{t('OrgSettingsScreen.signInTitle')}</p>
                  <p className="tm-cc-rows__sub">{t('OrgSettingsScreen.signInSub')}</p>
                </div>
                <Link
                  href={`/${organizationSlug}/admin/security`}
                  className="tm-button tm-button--outline tm-button--compact"
                >
                  {t('OrgSettingsScreen.security')}
                </Link>
              </li>
              <li>
                <div className="tm-cc-rows__text">
                  <p className="tm-cc-rows__title">{t('OrgSettingsScreen.sessionTitle')}</p>
                  <p className="tm-cc-rows__sub">{t('OrgSettingsScreen.sessionSub')}</p>
                </div>
                <Link
                  href={`/${organizationSlug}/policies`}
                  className="tm-button tm-button--outline tm-button--compact"
                >
                  {t('OrgSettingsScreen.accessPolicy')}
                </Link>
              </li>
              <li>
                <div className="tm-cc-rows__text">
                  <p className="tm-cc-rows__title">{t('OrgSettingsScreen.modulesTitle')}</p>
                  <p className="tm-cc-rows__sub">{t('OrgSettingsScreen.modulesSub')}</p>
                </div>
                <Link
                  href={`/${organizationSlug}/admin/feature-flags`}
                  className="tm-button tm-button--outline tm-button--compact"
                >
                  {t('OrgSettingsScreen.modules')}
                </Link>
              </li>
            </ul>
          </section>

          <section
            className="tm-cc-card tm-cc-card--quiet tm-cc-card--fill"
            aria-labelledby="tm-org-settings-effect"
          >
            <p className="tm-cc-eyebrow">{t('OrgSettingsScreen.effectEyebrow')}</p>
            <h2 id="tm-org-settings-effect" className="tm-cc-card__title">
              {t('OrgSettingsScreen.effectTitle')}
            </h2>
            <p className="tm-cc-card__body">
              {t('OrgSettingsScreen.effectBodyPrefix')} {organizationName}{' '}
              {t('OrgSettingsScreen.effectBodySuffix')}
            </p>
          </section>
        </div>
      </div>
    </ControlCenterShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
