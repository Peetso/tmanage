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
import { useT } from '../../lib/i18n/use-t';
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
  const t = useT();

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

  const title = loaded ? directoryTitle(rows) : t('IntegrationDirectoryScreen.titleFallback');

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('IntegrationDirectoryScreen.eyebrow')}
      title={title}
      description={t('IntegrationDirectoryScreen.description')}
      actions={
        <>
          <Link href={`/${organizationSlug}/admin/audit`} className="tm-aut-btn">
            {t('IntegrationDirectoryScreen.auditAccess')}
          </Link>
          <a href="#tm-connect" className="tm-aut-btn tm-aut-btn--ink">
            {t('IntegrationDirectoryScreen.connectATool')}
          </a>
        </>
      }
    >
      <div className="tm-aut">
        {loaded ? (
          <fieldset className="tm-aut-filters tm-aut-filters--end">
            <legend className="tm-visually-hidden">{t('IntegrationDirectoryScreen.show')}</legend>
            {(
              [
                ['all', `${t('IntegrationDirectoryScreen.filterAll')} · ${rows.length}`],
                [
                  'connected',
                  `${t('IntegrationDirectoryScreen.filterConnected')} · ${connectedApps.length}`,
                ],
                [
                  'available',
                  `${t('IntegrationDirectoryScreen.filterAvailable')} · ${availableApps.length}`,
                ],
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
          <InlineAlert tone="danger" title={t('IntegrationDirectoryScreen.loadErrorTitle')} live>
            {describeError(apps.error)}
          </InlineAlert>
        ) : null}

        {apps.isPending ? (
          <LoadingRegion label={t('IntegrationDirectoryScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {loaded && filter !== 'available' && connectedApps.length > 0 ? (
          <section aria-labelledby="tm-apps-connected-heading" className="tm-aut-col">
            <h2 id="tm-apps-connected-heading" className="tm-visually-hidden">
              {t('IntegrationDirectoryScreen.connected')}
            </h2>
            <ul className="tm-aut-tools" aria-label={t('IntegrationDirectoryScreen.connectedApps')}>
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
                        {live
                          ? t('IntegrationDirectoryScreen.stateConnected')
                          : t('IntegrationDirectoryScreen.statePending')}
                      </span>
                    </div>
                    <h3 className="tm-aut-tool__name">{app.name}</h3>
                    <p className="tm-aut-tool__body">{describeApp(app)}</p>
                    <ul
                      className="tm-aut-tool__foot"
                      aria-label={`${app.name} ${t('IntegrationDirectoryScreen.connectionsSuffix')}`}
                    >
                      {app.connections.map((connection) => (
                        <li key={connection.id} className="tm-aut-tool__conn">
                          <span className="tm-aut-mono">{connection.label}</span>
                          <span className="tm-aut-mono">
                            <span className="tm-visually-hidden">
                              {connection.status}
                              {t('IntegrationDirectoryScreen.commaAdded')}
                            </span>
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
                {filter === 'connected'
                  ? t('IntegrationDirectoryScreen.connected')
                  : t('IntegrationDirectoryScreen.available')}
              </h2>
              <span className="tm-aut-section-head__meta">
                {t('IntegrationDirectoryScreen.sectionMeta')}
              </span>
            </div>

            {!apps.isPending ? (
              <ul
                className="tm-aut-list"
                aria-label={t('IntegrationDirectoryScreen.appsInDirectory')}
              >
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
                          ? ` · ${app.connections.length} ${
                              app.connections.length === 1
                                ? t('IntegrationDirectoryScreen.connectionSingular')
                                : t('IntegrationDirectoryScreen.connectionPlural')
                            }`
                          : ''}
                      </span>
                    </div>
                    <div className="tm-aut-list__end">
                      <a
                        href="#tm-connect"
                        className="tm-aut-btn"
                        aria-label={`${t('IntegrationDirectoryScreen.connectVerb')} ${app.name}`}
                        onClick={() => setActiveAppId(app.id)}
                      >
                        {t('IntegrationDirectoryScreen.connect')}
                      </a>
                    </div>
                  </li>
                ))}
                <li>
                  <span className="tm-aut-glyph tm-aut-glyph--small" aria-hidden="true">
                    {'{ }'}
                  </span>
                  <div className="tm-aut-list__main">
                    <h3 className="tm-aut-rowtitle">{t('IntegrationDirectoryScreen.webhooks')}</h3>
                    <span className="tm-aut-rowsub">
                      {t('IntegrationDirectoryScreen.webhooksSub')}
                    </span>
                  </div>
                  <div className="tm-aut-list__end">
                    <Link
                      href={`/${organizationSlug}/admin/automations/webhooks`}
                      className="tm-aut-btn"
                    >
                      {t('IntegrationDirectoryScreen.manage')}
                    </Link>
                  </div>
                </li>
                <li>
                  <span className="tm-aut-glyph tm-aut-glyph--small" aria-hidden="true">
                    ✦
                  </span>
                  <div className="tm-aut-list__main">
                    <h3 className="tm-aut-rowtitle">
                      {t('IntegrationDirectoryScreen.aiAssistant')}
                    </h3>
                    <span className="tm-aut-rowsub">
                      {t('IntegrationDirectoryScreen.aiAssistantSub')}
                    </span>
                  </div>
                  <div className="tm-aut-list__end">
                    <Link
                      href={`/${organizationSlug}/settings/ai-assistant`}
                      className="tm-aut-btn"
                    >
                      {t('IntegrationDirectoryScreen.setUp')}
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
            <p className="tm-aut-eyebrow">{t('IntegrationDirectoryScreen.ruleEyebrow')}</p>
            <h2 id="tm-connect-heading" className="tm-aut-card__title">
              {t('IntegrationDirectoryScreen.ruleTitle')}
            </h2>
            <ul className="tm-aut-facts">
              <li>{t('IntegrationDirectoryScreen.fact1')}</li>
              <li>{t('IntegrationDirectoryScreen.fact2')}</li>
              <li>{t('IntegrationDirectoryScreen.fact3')}</li>
            </ul>

            {connected ? (
              <InlineAlert
                tone="success"
                title={t('IntegrationDirectoryScreen.connectionRecorded')}
                live
              >
                &ldquo;{connected.label}&rdquo; {t('IntegrationDirectoryScreen.wasConnected')}
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
                    {t('IntegrationDirectoryScreen.appLabel')}
                  </label>
                  <select
                    id="tm-app-select"
                    className="tm-field__control"
                    value={activeAppId}
                    onChange={(event) => setActiveAppId(event.target.value)}
                  >
                    <option value="">{t('IntegrationDirectoryScreen.chooseAnApp')}</option>
                    {rows.map((app) => (
                      <option key={app.id} value={app.id}>
                        {app.name}
                      </option>
                    ))}
                  </select>
                </div>

                <Field
                  label={t('IntegrationDirectoryScreen.connectionLabel')}
                  name="label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  hint={t('IntegrationDirectoryScreen.connectionLabelHint')}
                  required
                />

                <fieldset className="tm-aut-pair tm-fieldset">
                  <legend className="tm-field__label">
                    {t('IntegrationDirectoryScreen.optionalSetting')}
                  </legend>
                  <Field
                    label={t('IntegrationDirectoryScreen.settingName')}
                    name="setting-key"
                    value={settingKey}
                    onChange={(event) => setSettingKey(event.target.value)}
                    hint={t('IntegrationDirectoryScreen.settingNameHint')}
                  />
                  <Field
                    label={t('IntegrationDirectoryScreen.settingValue')}
                    name="setting-value"
                    value={settingValue}
                    onChange={(event) => setSettingValue(event.target.value)}
                  />
                </fieldset>

                {connect.isError ? (
                  <InlineAlert
                    tone="danger"
                    title={t('IntegrationDirectoryScreen.connectErrorTitle')}
                    live
                  >
                    {describeError(connect.error)}
                  </InlineAlert>
                ) : null}

                <div className="tm-aut-actions">
                  <Button
                    type="submit"
                    tone="lime"
                    size="accessible"
                    loading={connect.isPending}
                    loadingLabel={t('IntegrationDirectoryScreen.connecting')}
                    disabled={!canConnect}
                  >
                    {t('IntegrationDirectoryScreen.connectApp')}
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
