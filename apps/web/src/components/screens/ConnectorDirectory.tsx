'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  installConnector,
  listConnectors,
  uninstallConnector,
  type ConnectorState,
  type ConnectorView,
} from '../../lib/api/connectors';
import { fillTemplate } from '../../lib/ai-approval-presentation';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/connector-directory.css';
import { BrandLogo, type BrandId } from '../brand/BrandLogo';

/** Registry key → the app's mark (the same tile as Integrations and Storage). */
const BRAND_OF: Readonly<Record<string, BrandId>> = {
  google_drive: 'google-drive',
  onedrive: 'onedrive',
  google_calendar: 'google-calendar',
  microsoft_calendar: 'outlook',
  github: 'github',
  jira: 'jira',
};

/** What the row says under the name, per registry key (connector names are never translated). */
const WHAT: Readonly<Record<string, MessageKey>> = {
  google_drive: 'ConnectorDirectory.what.storage',
  onedrive: 'ConnectorDirectory.what.storage',
  google_calendar: 'ConnectorDirectory.what.calendar',
  microsoft_calendar: 'ConnectorDirectory.what.calendar',
  jira: 'ConnectorDirectory.what.jira',
  github: 'ConnectorDirectory.what.github',
};

// FIX4 item 6: a key-based app reads "Connected" / "Not connected" like every other card, not
// "Installed".
const STATE: Readonly<Record<ConnectorState, { key: MessageKey; on: boolean }>> = {
  connected: { key: 'ConnectorDirectory.state.connected', on: true },
  not_connected: { key: 'ConnectorDirectory.state.notConnected', on: false },
  installed: { key: 'ConnectorDirectory.state.connected', on: true },
  not_installed: { key: 'ConnectorDirectory.state.notConnected', on: false },
};

export interface ConnectorDirectoryProps {
  api: ApiClient;
  organizationSlug: string;
}

/**
 * 54-01 — **Connected apps v2 > Connectors** (Figma R41 L2-54-01: EN 568:33186, AR 568:33302;
 * install card EN 568:33286, AR 568:33402). Every registered connector with its sign-in type and
 * state. Drive, OneDrive and the calendars are the existing connections ("Manage" goes to their
 * card); an API-key connector installs here, its key going straight into the token vault.
 * Owners and admins only — the screen does not mount this for anyone else.
 */
export function ConnectorDirectory({ api, organizationSlug }: ConnectorDirectoryProps) {
  const t = useT();
  const tOr = useTOr();
  const queries = useQueryClient();
  const headingId = useId();
  const queryKey = ['connectors', organizationSlug];
  const [installing, setInstalling] = useState<ConnectorView | null>(null);

  const list = useQuery({ queryKey, queryFn: () => listConnectors(api, organizationSlug) });

  const replace = (view: ConnectorView) =>
    queries.setQueryData<readonly ConnectorView[]>(queryKey, (current) =>
      current?.map((connector) => (connector.key === view.key ? view : connector)),
    );

  const install = useMutation({
    mutationFn: ({ key, apiKey }: { key: string; apiKey: string }) =>
      installConnector(api, organizationSlug, key, apiKey),
    onSuccess: (view) => {
      replace(view);
      setInstalling(null);
    },
  });
  const uninstall = useMutation({
    mutationFn: (key: string) => uninstallConnector(api, organizationSlug, key),
    onSuccess: replace,
  });

  return (
    <section className="tm-connectors" aria-labelledby={headingId} id="tm-int-keys">
      <h2 className="tm-connectors__title" id={headingId}>
        {tOr('ConnectorDirectory.keysTitle', 'Apps that connect with a key')}
      </h2>
      <p className="tm-connectors__hint">
        {tOr(
          'ConnectorDirectory.keysHint',
          'GitHub and Jira do not offer a one-click sign-in to TManage yet. An owner or admin pastes a key from the app once; it is stored encrypted and never shown again.',
        )}
      </p>
      {list.isPending ? null : list.isError ? (
        <InlineAlert tone="danger" title={t('ConnectorDirectory.loadError')}>
          {null}
        </InlineAlert>
      ) : (
        <>
          {uninstall.isError ? (
            <InlineAlert tone="danger" title={t('ConnectorDirectory.saveError')} live>
              {null}
            </InlineAlert>
          ) : null}
          <ul className="tm-connectors__list">
            {/* FIX4 item 6: Drive, OneDrive and the calendars are cards above; only the apps that
                connect with a key are listed here. */}
            {list.data
              .filter((connector) => connector.managed !== 'built-in')
              .map((connector) => {
                const state = STATE[connector.state];
                const what = WHAT[connector.key];
                return (
                  <li key={connector.key} className="tm-connectors__row">
                    {BRAND_OF[connector.key] ? (
                      <BrandLogo brand={BRAND_OF[connector.key]!} size={36} />
                    ) : (
                      <span className="tm-connectors__monogram" aria-hidden="true" dir="ltr">
                        {connector.name.slice(0, 1)}
                      </span>
                    )}
                    <div className="tm-connectors__identity">
                      <h3 className="tm-connectors__name" dir="ltr">
                        {connector.name}
                      </h3>
                      {what ? <p className="tm-connectors__what">{t(what)}</p> : null}
                    </div>
                    {/* FIX3 item 9 (live I2): no "API key" / "OAuth sign-in" chip — how an app
                    signs in is not something a person should have to read. */}
                    <StateCapsule state={state.on ? 'done' : 'neutral'}>
                      {t(state.key)}
                    </StateCapsule>
                    {connector.state === 'installed' ? (
                      <Button
                        tone="outline"
                        loading={uninstall.isPending && uninstall.variables === connector.key}
                        loadingLabel={t('ConnectorDirectory.uninstalling')}
                        aria-label={fillTemplate(t('ConnectorDirectory.uninstallLabel'), {
                          app: connector.name,
                        })}
                        onClick={() => uninstall.mutate(connector.key)}
                      >
                        {t('ConnectApps.disconnect')}
                      </Button>
                    ) : (
                      <Button
                        tone="ink"
                        aria-label={fillTemplate(t('ConnectorDirectory.installLabel'), {
                          app: connector.name,
                        })}
                        onClick={() => {
                          install.reset();
                          setInstalling(connector);
                        }}
                      >
                        {t('ConnectApps.connect')}
                      </Button>
                    )}
                  </li>
                );
              })}
          </ul>
        </>
      )}
      {installing ? (
        <InstallCard
          connector={installing}
          busy={install.isPending}
          failed={install.isError}
          onCancel={() => setInstalling(null)}
          onInstall={(apiKey) => install.mutate({ key: installing.key, apiKey })}
        />
      ) : null}
    </section>
  );
}

function InstallCard({
  connector,
  busy,
  failed,
  onCancel,
  onInstall,
}: {
  connector: ConnectorView;
  busy: boolean;
  failed: boolean;
  onCancel: () => void;
  onInstall: (apiKey: string) => void;
}) {
  const t = useT();
  const titleId = useId();
  const [apiKey, setApiKey] = useState('');
  return (
    <form
      className="tm-connectors__install"
      aria-labelledby={titleId}
      onSubmit={(event) => {
        event.preventDefault();
        if (apiKey.trim() !== '' && !busy) onInstall(apiKey.trim());
      }}
    >
      <h3 className="tm-connectors__install-title" id={titleId}>
        {fillTemplate(t('ConnectorDirectory.installTitle'), { app: connector.name })}
      </h3>
      <p className="tm-connectors__install-body">{t('ConnectorDirectory.installBody')}</p>
      <p className="tm-connectors__install-access">
        {fillTemplate(t('ConnectorDirectory.access'), { scopes: connector.scopes.join(', ') })}
      </p>
      {failed ? (
        <InlineAlert tone="danger" title={t('ConnectorDirectory.saveError')} live>
          {null}
        </InlineAlert>
      ) : null}
      <Field
        label={t('ConnectorDirectory.keyLabel')}
        type="password"
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        placeholder={t('ConnectorDirectory.keyPlaceholder')}
        value={apiKey}
        onChange={(event) => setApiKey(event.currentTarget.value)}
      />
      <div className="tm-connectors__install-actions">
        <Button tone="text" type="button" onClick={onCancel}>
          {t('ConnectorDirectory.cancel')}
        </Button>
        <Button
          tone="ink"
          type="submit"
          loading={busy}
          loadingLabel={t('ConnectorDirectory.installing')}
          disabled={apiKey.trim() === ''}
        >
          {t('ConnectApps.connect')}
        </Button>
      </div>
    </form>
  );
}
