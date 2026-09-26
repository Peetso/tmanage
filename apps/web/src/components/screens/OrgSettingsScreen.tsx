'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Organization settings"
      description="Organization-wide policy. Changes apply to everyone in this organization."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-org-settings-heading">
        <h2 id="tm-org-settings-heading" className="tm-eyebrow">
          Policy
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

        {rows.map((entry) => {
          const meta = LABELS[entry.key];
          return (
            <form
              key={entry.key}
              className="tm-stack"
              noValidate
              aria-label={`${meta?.label ?? entry.key} setting`}
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (!save.isPending) save.mutate(entry.key);
              }}
            >
              <Field
                label={meta?.label ?? entry.key}
                name={`setting-${entry.key}`}
                value={drafts[entry.key] ?? entry.value}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [entry.key]: event.target.value }))
                }
                hint={meta?.hint}
              />
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
              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={save.isPending && save.variables === entry.key}
                  loadingLabel="Saving"
                >
                  Save
                </Button>
              </div>
            </form>
          );
        })}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
