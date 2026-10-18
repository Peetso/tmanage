'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/automations.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  connectIntegrationApp,
  listIntegrationApps,
  type IntegrationAppView,
} from '../../lib/api/integration-directory';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  appState,
  describeApp,
  describeAppLine,
  directoryTitle,
  relativeAgo,
} from './integration-directory-view';

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
  const [filter, setFilter] = useState<DirectoryFilter>('all');

  const rows = apps.data ?? [];
  const activeApp = rows.find((app) => app.id === activeAppId) ?? null;
  const connectedApps = rows.filter((app) => app.connections.length > 0);
  const availableApps = rows.filter((app) => app.connections.length === 0);

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
  const loaded = !apps.isPending && !apps.isError;

  const title = loaded ? directoryTitle(rows) : 'Integrations';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow="Control center · Integrations"
      title={title}
      description="TManage stays the record. Integrations bring information in or copy it out; they never become the place a decision lives."
      actions={
        <>
          <Link href={`/${organizationSlug}/admin/audit`} className="tm-aut-btn">
            Audit access
          </Link>
          <a href="#tm-connect" className="tm-aut-btn tm-aut-btn--ink">
            Connect a tool
          </a>
        </>
      }
    >
      <div className="tm-aut">
        {loaded ? (
          <fieldset className="tm-aut-filters tm-aut-filters--end">
            <legend className="tm-visually-hidden">Show</legend>
            {(
              [
                ['all', `All · ${rows.length}`],
                ['connected', `Connected · ${connectedApps.length}`],
                ['available', `Available · ${availableApps.length}`],
              ] as const
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                className="tm-aut-filter"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {text}
              </button>
            ))}
          </fieldset>
        ) : null}

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

        {loaded && filter !== 'available' && connectedApps.length > 0 ? (
          <section aria-labelledby="tm-apps-connected-heading" className="tm-aut-col">
            <h2 id="tm-apps-connected-heading" className="tm-visually-hidden">
              Connected
            </h2>
            <ul className="tm-aut-tools" aria-label="Connected apps">
              {connectedApps.map((app) => {
                const live = appState(app) === 'live';
                return (
                  <li key={app.id} className="tm-aut-tool">
                    <div className="tm-aut-tool__head">
                      <span className="tm-aut-glyph" aria-hidden="true">
                        {glyphFor(app.category)}
                      </span>
                      <span
                        className={`tm-aut-state ${live ? 'tm-aut-state--live' : 'tm-aut-state--warning'}`}
                      >
                        {live ? 'Connected' : 'Pending'}
                      </span>
                    </div>
                    <h3 className="tm-aut-tool__name">{app.name}</h3>
                    <p className="tm-aut-tool__body">{describeApp(app)}</p>
                    <ul className="tm-aut-tool__foot" aria-label={`${app.name} connections`}>
                      {app.connections.map((connection) => (
                        <li key={connection.id} className="tm-aut-tool__conn">
                          <span className="tm-aut-mono">{connection.label}</span>
                          <span className="tm-aut-mono">
                            <span className="tm-visually-hidden">{connection.status}, added </span>
                            {relativeAgo(connection.createdAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <div className="tm-aut-split">
          <section className="tm-aut-col" aria-labelledby="tm-apps-heading">
            <div className="tm-aut-section-head">
              <h2 id="tm-apps-heading" className="tm-aut-section-head__title">
                {filter === 'connected' ? 'Connected' : 'Available'}
              </h2>
              <span className="tm-aut-section-head__meta">
                connecting one always shows what it may do first
              </span>
            </div>

            {!apps.isPending ? (
              <ul className="tm-aut-list" aria-label="Apps in the directory">
                {(filter === 'connected' ? connectedApps : availableApps).map((app) => (
                  <li key={app.id}>
                    <span className="tm-aut-glyph tm-aut-glyph--small" aria-hidden="true">
                      {glyphFor(app.category)}
                    </span>
                    <div className="tm-aut-list__main">
                      <h3 className="tm-aut-rowtitle">{app.name}</h3>
                      <span className="tm-aut-rowsub">
                        {describeAppLine(app)}
                        {app.connections.length > 0
                          ? ` · ${app.connections.length} connection${app.connections.length === 1 ? '' : 's'}`
                          : ''}
                      </span>
                    </div>
                    <div className="tm-aut-list__end">
                      <a
                        href="#tm-connect"
                        className="tm-aut-btn"
                        aria-label={`Connect ${app.name}`}
                        onClick={() => setActiveAppId(app.id)}
                      >
                        Connect
                      </a>
                    </div>
                  </li>
                ))}
                <li>
                  <span className="tm-aut-glyph tm-aut-glyph--small" aria-hidden="true">
                    {'{ }'}
                  </span>
                  <div className="tm-aut-list__main">
                    <h3 className="tm-aut-rowtitle">Webhooks</h3>
                    <span className="tm-aut-rowsub">
                      send automation events to an https endpoint you own
                    </span>
                  </div>
                  <div className="tm-aut-list__end">
                    <Link
                      href={`/${organizationSlug}/admin/automations/webhooks`}
                      className="tm-aut-btn"
                    >
                      Manage
                    </Link>
                  </div>
                </li>
              </ul>
            ) : null}
          </section>

          <section
            id="tm-connect"
            className="tm-aut-card tm-card--ink"
            aria-labelledby="tm-connect-heading"
          >
            <p className="tm-aut-eyebrow">The rule for every integration</p>
            <h2 id="tm-connect-heading" className="tm-aut-card__title">
              If it leaves TManage, a person chose to send it
            </h2>
            <ul className="tm-aut-facts">
              <li>Secrets are never stored here: only a label and non-secret settings.</li>
              <li>
                Live credential exchange is set up separately, after the connection is recorded.
              </li>
              <li>Every connection records who added it.</li>
            </ul>

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

                <fieldset className="tm-aut-pair tm-fieldset">
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

                <div className="tm-aut-actions">
                  <Button
                    type="submit"
                    tone="lime"
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
        </div>
      </div>
    </AppShell>
  );
}

type DirectoryFilter = 'all' | 'connected' | 'available';

/** The square glyph on each tool card, from the app's category (INT-01's ▦ ✉ ⇪ ◫). */
function glyphFor(category: string): string {
  const key = category.toLowerCase();
  if (key.includes('calendar')) return '▦';
  if (key.includes('mail')) return '✉';
  if (key.includes('storage') || key.includes('file')) return '⇪';
  if (key.includes('design')) return '◫';
  if (key.includes('chat') || key.includes('messag') || key.includes('communic')) return '◌';
  if (key.includes('time')) return '◔';
  if (key.includes('account') || key.includes('financ') || key.includes('billing')) return '◈';
  if (key.includes('dev') || key.includes('code')) return '‹›';
  return '◇';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
