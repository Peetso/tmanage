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
import { isServicePaused } from '../../lib/api/service-paused';
import { ServicePausedNotice, pausedButtonProps } from './ServicePausedNotice';

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
  /**
   * FIX5 item 6c (B-N8): the one app (registry key, e.g. `jira`) whose key panel is open. The
   * Integrations card is the only place an app is listed; its Connect (or Manage) opens this panel
   * for that app alone, so GitHub and Jira no longer appear a second time as rows.
   */
  only: string;
  /** Closes the panel (Cancel on the key form, or Done once connected). */
  onDone?: () => void;
}

/**
 * 54-01 — **Connected apps v2 > Connectors** (Figma R41 L2-54-01: EN 568:33186, AR 568:33302;
 * install card EN 568:33286, AR 568:33402). An app that connects with a key: its state, and the
 * key form (the key goes straight into the token vault) or Disconnect. Owners and admins only —
 * the screen does not mount this for anyone else.
 */
export function ConnectorDirectory({
  api,
  organizationSlug,
  only,
  onDone,
}: ConnectorDirectoryProps) {
  const t = useT();
  const tOr = useTOr();
  const queries = useQueryClient();
  const headingId = useId();
  const queryKey = ['connectors', organizationSlug];
  // The form opens at once for an app that is not connected yet: the card's Connect asked for it.
  const [formClosed, setFormClosed] = useState(false);

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
      setFormClosed(true);
    },
  });
  const uninstall = useMutation({
    mutationFn: (key: string) => uninstallConnector(api, organizationSlug, key),
    onSuccess: (view) => {
      replace(view);
      setFormClosed(false);
    },
  });

  const connector = list.data?.find((entry) => entry.key === only && entry.managed !== 'built-in');
  const name = connector?.name ?? only;
  const isConnected = connector ? STATE[connector.state].on : false;

  return (
    <section className="tm-connectors" aria-labelledby={headingId} id="tm-int-keys">
      <h2 className="tm-connectors__title" id={headingId}>
        {fillTemplate(tOr('ConnectorDirectory.keyPanelTitle', 'Connect {app} with a key'), {
          app: name,
        })}
      </h2>
      {list.isPending ? null : list.isError || !connector ? (
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
            <ConnectorRow
              connector={connector}
              disconnecting={uninstall.isPending}
              onDisconnect={() => uninstall.mutate(connector.key)}
            />
          </ul>
          {isServicePaused(install.error) ? <ServicePausedNotice service={connector.key} /> : null}
          {!isConnected && !formClosed ? (
            <InstallCard
              labelledBy={headingId}
              connector={connector}
              busy={install.isPending}
              failed={install.isError && !isServicePaused(install.error)}
              paused={isServicePaused(install.error)}
              onCancel={() => {
                setFormClosed(true);
                onDone?.();
              }}
              onInstall={(apiKey) => install.mutate({ key: connector.key, apiKey })}
            />
          ) : null}
          {isConnected && onDone ? (
            <div className="tm-connectors__install-actions">
              <Button tone="text" type="button" onClick={onDone}>
                {tOr('ConnectorDirectory.done', 'Done')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function ConnectorRow({
  connector,
  disconnecting,
  onDisconnect,
}: {
  connector: ConnectorView;
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  const t = useT();
  const state = STATE[connector.state];
  const what = WHAT[connector.key];
  const brand = BRAND_OF[connector.key];
  return (
    <li className="tm-connectors__row">
      {brand ? (
        <BrandLogo brand={brand} size={36} />
      ) : (
        <span className="tm-connectors__monogram" aria-hidden="true" dir="ltr">
          {connector.name.slice(0, 1)}
        </span>
      )}
      <div className="tm-connectors__identity">
        {/* The panel's own heading names the app; the row is not a second heading for it. */}
        <p className="tm-connectors__name" dir="ltr">
          {connector.name}
        </p>
        {what ? <p className="tm-connectors__what">{t(what)}</p> : null}
      </div>
      {/* FIX3 item 9 (live I2): no "API key" / "OAuth sign-in" chip — how an app signs in is not
          something a person should have to read. */}
      <StateCapsule state={state.on ? 'done' : 'neutral'}>{t(state.key)}</StateCapsule>
      {state.on ? (
        <Button
          tone="outline"
          loading={disconnecting}
          loadingLabel={t('ConnectorDirectory.uninstalling')}
          aria-label={fillTemplate(t('ConnectorDirectory.uninstallLabel'), {
            app: connector.name,
          })}
          onClick={onDisconnect}
        >
          {t('ConnectApps.disconnect')}
        </Button>
      ) : null}
    </li>
  );
}

function InstallCard({
  labelledBy,
  connector,
  busy,
  failed,
  paused,
  onCancel,
  onInstall,
}: {
  /** The panel heading that already names the app; the form is labelled by it. */
  labelledBy: string;
  connector: ConnectorView;
  busy: boolean;
  failed: boolean;
  /** ADMINSVC3: the platform paused this connector (Connect disabled). */
  paused: boolean;
  onCancel: () => void;
  onInstall: (apiKey: string) => void;
}) {
  const t = useT();
  const [apiKey, setApiKey] = useState('');
  return (
    <form
      className="tm-connectors__install"
      aria-labelledby={labelledBy}
      onSubmit={(event) => {
        event.preventDefault();
        if (apiKey.trim() !== '' && !busy && !paused) onInstall(apiKey.trim());
      }}
    >
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
          {...pausedButtonProps(connector.key, paused)}
        >
          {t('ConnectApps.connect')}
        </Button>
      </div>
    </form>
  );
}
