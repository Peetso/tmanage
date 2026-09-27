'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  connectIntegrationApp,
  listIntegrationApps,
  type IntegrationAppView,
} from '../../lib/api/integration-directory';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface IntegrationDirectoryScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Automations app directory (module 17, x165).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations ("app directory"). This screen reads the
 * static integration catalog merged with the organization's connections (`GET …/automations/apps`,
 * `org.manage`) and records a connection against a catalog app (`POST …/automations/apps/:appId/
 * connections`).
 *
 * ## What it does, and what it cannot
 *
 * - **No secrets.** The connect form collects a label and an optional non-secret setting only. Live
 *   OAuth / credential exchange is out of scope (Needs-Peter); the API rejects secret-shaped config
 *   keys, and this form never asks for one.
 * - **A connection is recorded, never edited or removed here.** The API grants create and read only
 *   this slice, so there is no edit or disconnect control.
 */
export function IntegrationDirectoryScreen({
  organizationSlug,
  organizationName,
  client,
}: IntegrationDirectoryScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const apps = useQuery({
    queryKey: ['integration-apps', organizationSlug],
    queryFn: () => listIntegrationApps(api, organizationSlug),
  });

  const [activeAppId, setActiveAppId] = useState('');
  const [label, setLabel] = useState('');
  const [settingKey, setSettingKey] = useState('');
  const [settingValue, setSettingValue] = useState('');
  const [connected, setConnected] = useState<{ appId: string; label: string } | null>(null);

  const rows = apps.data ?? [];
  const activeApp = rows.find((app) => app.id === activeAppId) ?? null;

  const connect = useMutation({
    mutationFn: (app: IntegrationAppView) => {
      const config: Record<string, string> = {};
      if (settingKey.trim() !== '' && settingValue.trim() !== '') {
        config[settingKey.trim()] = settingValue.trim();
      }
      return connectIntegrationApp(api, organizationSlug, app.id, {
        label: label.trim(),
        config,
      });
    },
    onSuccess: async (connection) => {
      setConnected({ appId: connection.appId, label: connection.label });
      setLabel('');
      setSettingKey('');
      setSettingValue('');
      await queryClient.invalidateQueries({ queryKey: ['integration-apps', organizationSlug] });
    },
  });

  const canConnect = activeApp !== null && label.trim() !== '' && !connect.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="App directory"
      description="Connect apps and integrations to your studio. Secrets are never stored here."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-apps-heading">
        <h2 id="tm-apps-heading" className="tm-eyebrow">
          Available apps
        </h2>

        {apps.isError ? (
          <InlineAlert tone="danger" title="Could not load the app directory" live>
            {describeError(apps.error)}
          </InlineAlert>
        ) : null}

        {apps.isPending ? (
          <LoadingRegion label="Loading the app directory.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!apps.isPending && !apps.isError ? (
          <ul className="tm-grid tm-grid--cards" aria-label="Apps in the directory">
            {rows.map((app) => (
              <li key={app.id} className="tm-card tm-stack">
                <h3 className="tm-card__title">{app.name}</h3>
                <p className="tm-muted">{app.category}</p>
                <p className="tm-prose">Capabilities: {app.capabilities.join(', ')}</p>
                <p className="tm-muted">
                  {app.connections.length === 0
                    ? 'Not connected'
                    : `${app.connections.length} connection${app.connections.length === 1 ? '' : 's'}`}
                </p>
                {app.connections.length > 0 ? (
                  <ul aria-label={`${app.name} connections`}>
                    {app.connections.map((connection) => (
                      <li key={connection.id}>
                        {connection.label} — {connection.status}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-connect-heading">
        <h2 id="tm-connect-heading" className="tm-eyebrow">
          Connect an app
        </h2>

        {connected ? (
          <InlineAlert tone="success" title="Connection recorded" live>
            &ldquo;{connected.label}&rdquo; was connected. Live credential exchange is set up
            separately.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canConnect && activeApp) connect.mutate(activeApp);
            }}
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-app-select">
                App
              </label>
              <select
                id="tm-app-select"
                className="tm-field__control"
                value={activeAppId}
                onChange={(event) => setActiveAppId(event.target.value)}
              >
                <option value="">Choose an app…</option>
                {rows.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </select>
            </div>

            <Field
              label="Connection label"
              name="label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              hint="A short handle, such as Ops workspace."
              required
            />

            <fieldset className="tm-stack tm-fieldset">
              <legend className="tm-field__label">Optional setting (non-secret)</legend>
              <Field
                label="Setting name"
                name="setting-key"
                value={settingKey}
                onChange={(event) => setSettingKey(event.target.value)}
                hint="For example, channel or repo. Never a token or password."
              />
              <Field
                label="Setting value"
                name="setting-value"
                value={settingValue}
                onChange={(event) => setSettingValue(event.target.value)}
              />
            </fieldset>

            {connect.isError ? (
              <InlineAlert tone="danger" title="Could not connect the app" live>
                {describeError(connect.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={connect.isPending}
                loadingLabel="Connecting"
                disabled={!canConnect}
              >
                Connect app
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
