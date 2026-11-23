'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, InfoButton, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { revokeConnectedApp } from '../../lib/api/connected-apps';
import type { AiPanelApp } from '../../lib/api/ai-panel';
import { formatLastUsed } from '../../lib/connected-apps-presentation';
import { useAiText } from '../ai-chat/use-ai-text';
import { desktopAiPanel } from './desktop-bridge';
import { SparkleIcon } from './icons';
import { showPanel } from './panel-store';
import { useAiPanelT } from './use-ai-panel-t';

export interface ConnectedAppCardProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly app: AiPanelApp;
  readonly now: Date;
  readonly onDisconnected: () => void;
  /** Injected by stories to draw the confirm dialog open. */
  readonly initialConfirm?: boolean;
}

/**
 * One connected AI app (Figma 857:1014 "Connected apps"; Fix 3: no vendor logos). The generic
 * connected-app mark and the app's name as plain text; "Open" only for an app the server
 * recognised by its verified client id (`openUrl`), never from the name. Open (Outline), Manage
 * (Text), a spacer, then Disconnect alone at the far end, behind a confirm dialog.
 */
export function ConnectedAppCard({
  api,
  organizationSlug,
  app,
  now,
  onDisconnected,
  initialConfirm = false,
}: ConnectedAppCardProps) {
  const t = useAiPanelT();
  const { day, locale } = useAiText();
  const nameId = useId();
  const [confirming, setConfirming] = useState(initialConfirm);
  const disconnectButton = useRef<HTMLSpanElement>(null);
  const since = t('AiPanel.apps.since', { date: day(app.connectedAt) });
  const used =
    app.lastUsedAt === null
      ? t('AiPanel.apps.neverUsed')
      : t('AiPanel.apps.lastUsed', { when: formatLastUsed(app.lastUsedAt, now, locale) });

  function openApp() {
    // In the desktop app the assistant opens docked beside TManage, as the top-bar button did.
    const bridge = desktopAiPanel();
    if (bridge && app.app) showPanel(app.app);
  }

  return (
    <article className="tm-aip-card tm-aip-app" aria-labelledby={nameId}>
      <div className="tm-aip-card__head">
        <span className="tm-aip-app__mark" aria-hidden="true">
          <SparkleIcon size={16} />
        </span>
        <h4 id={nameId} className="tm-aip-card__title">
          <bdi>{app.clientName}</bdi>
        </h4>
        <span className="tm-aip-spacer" />
        <StateCapsule state="done" className="tm-aip-capsule">
          {t('AiPanel.apps.connected')}
        </StateCapsule>
      </div>
      <p className="tm-aip-note">{`${since} · ${used}`}</p>
      <div className="tm-aip-app__actions">
        {app.openUrl !== null ? (
          desktopAiPanel() && app.app ? (
            <Button tone="outline" size="compact" className="tm-aip-touch" onClick={openApp}>
              {t('AiPanel.apps.open')}
            </Button>
          ) : (
            <a
              className="tm-button tm-button--outline tm-button--compact tm-aip-touch"
              href={app.openUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('AiPanel.apps.openIn', { name: app.clientName })}
            >
              {t('AiPanel.apps.open')}
            </a>
          )
        ) : null}
        <Link
          className="tm-button tm-button--text tm-button--compact tm-aip-touch"
          href={`/${encodeURIComponent(organizationSlug)}/settings/connected-apps`}
          aria-label={t('AiPanel.apps.manageFor', { name: app.clientName })}
        >
          {t('AiPanel.apps.manage')}
        </Link>
        <span className="tm-aip-spacer" />
        <span ref={disconnectButton}>
          <Button
            tone="text"
            size="compact"
            className="tm-aip-touch"
            aria-label={t('AiPanel.apps.disconnectFor', { name: app.clientName })}
            onClick={() => setConfirming(true)}
          >
            {t('AiPanel.apps.disconnect')}
          </Button>
        </span>
      </div>
      {confirming ? (
        <DisconnectDialog
          api={api}
          organizationSlug={organizationSlug}
          app={app}
          onDone={() => {
            setConfirming(false);
            onDisconnected();
          }}
          onCancel={() => {
            setConfirming(false);
            disconnectButton.current?.querySelector('button')?.focus();
          }}
        />
      ) : null}
    </article>
  );
}

/**
 * "Disconnect Claude?" (Figma states 858:906): Cancel, and Disconnect (destructive) at the far
 * end; the ⓘ says what happens. A native modal `<dialog>`, so focus stays inside and Escape cancels
 * (UX-9: native HTML first).
 */
function DisconnectDialog({
  api,
  organizationSlug,
  app,
  onDone,
  onCancel,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly app: AiPanelApp;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const t = useAiPanelT();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    if (typeof element.showModal === 'function' && !element.open) element.showModal();
    else element.setAttribute('open', '');
    element.querySelector<HTMLButtonElement>('button[data-cancel]')?.focus();
    return () => {
      if (element.open && typeof element.close === 'function') element.close();
    };
  }, []);

  async function disconnect() {
    setBusy(true);
    setFailed(false);
    try {
      await revokeConnectedApp(api, organizationSlug, app.grantId);
      onDone();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="tm-aip-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="tm-aip-dialog__head">
        <h3 id={titleId} className="tm-aip-dialog__title">
          <bdi>{t('AiPanel.apps.disconnectTitle', { name: app.clientName })}</bdi>
        </h3>
        <InfoButton
          title={t('AiPanel.apps.disconnectTitle', { name: app.clientName })}
          label={t('AiPanel.apps.disconnectInfoLabel')}
        >
          {t('AiPanel.apps.disconnectInfo', { name: app.clientName })}
        </InfoButton>
      </div>
      {failed ? (
        <InlineAlert tone="danger" live>
          {t('AiPanel.apps.disconnectFailed')}
        </InlineAlert>
      ) : null}
      <div className="tm-aip-card__actions">
        <Button tone="outline" data-cancel className="tm-aip-touch" onClick={onCancel}>
          {t('AiPanel.cancel')}
        </Button>
        <span className="tm-aip-spacer" />
        <Button
          tone="destructive"
          className="tm-aip-touch"
          loading={busy}
          onClick={() => void disconnect()}
        >
          {t('AiPanel.apps.disconnect')}
        </Button>
      </div>
    </dialog>
  );
}
