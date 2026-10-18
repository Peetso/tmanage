'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { readOrgSettings, setOrgSetting } from '../../lib/api/org-settings';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
  organizationName,
  client,
}: OrgSettingsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: ['org-settings', organizationSlug],
    queryFn: () => readOrgSettings(api, organizationSlug),
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

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="organization"
      crumbs={['Organization']}
      title={organizationName}
      actions={
        <Link
          href={`/${organizationSlug}/admin`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          Control center
        </Link>
      }
    >
      <div className="tm-cc-split tm-cc-split--even">
        <section className="tm-cc-card" aria-labelledby="tm-org-settings-heading">
          <h2 id="tm-org-settings-heading" className="tm-cc-eyebrow">
            Identity, time and policy · applies to everyone
          </h2>

          {settings.isError ? (
            <InlineAlert tone="danger" title="Could not load the settings" live>
              {describeError(settings.error)}
            </InlineAlert>
          ) : null}

          {settings.isPending ? (
            <LoadingRegion label="Loading the settings.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!settings.isPending && !settings.isError && rows.length === 0 ? (
            <InlineAlert tone="neutral" title="No settings available">
              There are no organization settings to configure yet.
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
                      aria-label={`${meta?.label ?? entry.key} setting`}
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
                          loadingLabel="Saving"
                        >
                          Save
                        </Button>
                      </div>
                      {save.isError && save.variables === entry.key ? (
                        <InlineAlert tone="danger" title="Could not save the setting" live>
                          {describeError(save.error)}
                        </InlineAlert>
                      ) : null}
                      {savedKey === entry.key && !save.isPending && !save.isError ? (
                        <InlineAlert tone="success" title="Saved" live>
                          This setting has been updated for the whole organization.
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
              Set elsewhere in the Control Center
            </h2>
            <ul className="tm-cc-rows">
              <li>
                <div className="tm-cc-rows__text">
                  <p className="tm-cc-rows__title">Sign-in and two-factor</p>
                  <p className="tm-cc-rows__sub">How people get in</p>
                </div>
                <Link
                  href={`/${organizationSlug}/admin/security`}
                  className="tm-button tm-button--outline tm-button--compact"
                >
                  Security
                </Link>
              </li>
              <li>
                <div className="tm-cc-rows__text">
                  <p className="tm-cc-rows__title">Session length and invitations</p>
                  <p className="tm-cc-rows__sub">
                    Who may be invited and for how long they stay in
                  </p>
                </div>
                <Link
                  href={`/${organizationSlug}/policies`}
                  className="tm-button tm-button--outline tm-button--compact"
                >
                  Access policy
                </Link>
              </li>
              <li>
                <div className="tm-cc-rows__text">
                  <p className="tm-cc-rows__title">Optional modules</p>
                  <p className="tm-cc-rows__sub">Chat, docs, portal and the rest</p>
                </div>
                <Link
                  href={`/${organizationSlug}/admin/feature-flags`}
                  className="tm-button tm-button--outline tm-button--compact"
                >
                  Modules
                </Link>
              </li>
            </ul>
          </section>

          <section
            className="tm-cc-card tm-cc-card--quiet tm-cc-card--fill"
            aria-labelledby="tm-org-settings-effect"
          >
            <p className="tm-cc-eyebrow">Changing a setting</p>
            <h2 id="tm-org-settings-effect" className="tm-cc-card__title">
              Each setting saves on its own
            </h2>
            <p className="tm-cc-card__body">
              A change applies to everyone in {organizationName} as soon as it is saved.
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
