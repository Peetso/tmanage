'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { Button, StatusDot } from '@tmanage/ui';
import { CloseIcon, LockIcon, PopOutIcon, SparkleIcon } from './icons';
import { siteHost, type AssistantSite, type ConnectionState } from './assistant-sites';
import type { DesktopAiPanel } from './desktop-bridge';
import { ConnectorAddress } from './AiPopovers';
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, setPanelWidth } from './panel-store';
import { useAiPanelT } from './use-ai-panel-t';

export interface AiSidePanelProps {
  readonly bridge: DesktopAiPanel;
  readonly site: AssistantSite;
  readonly width: number;
  readonly state: ConnectionState;
  readonly address: string;
  /** The chooser opened from "Switch" draws over the website area while it is open. */
  readonly chooser: ReactNode;
  readonly onSwitch: () => void;
  readonly onPopOut: () => void;
  readonly onClose: () => void;
  readonly onCheckAgain: () => void;
}

const RESIZE_STEP = 16;

/**
 * Figma 402:5797 — the docked panel inside the desktop app. This page draws the chrome (header,
 * trust line, notices, status) and reports where the website area is; the desktop shell shows the
 * assistant's own website there in a view of its own, which this page cannot script or read.
 */
export function AiSidePanel({
  bridge,
  site,
  width,
  state,
  address,
  chooser,
  onSwitch,
  onPopOut,
  onClose,
  onCheckAgain,
}: AiSidePanelProps) {
  const t = useAiPanelT();
  const area = useRef<HTMLDivElement>(null);
  const name = { name: site.label };
  const host = siteHost(site);
  const covered = chooser !== null;

  const report = useCallback(() => {
    const element = area.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    void bridge.setBounds({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      visible: !covered,
    });
  }, [bridge, covered]);

  useEffect(() => {
    report();
    const element = area.current;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    if (element) observer?.observe(element);
    window.addEventListener('resize', report);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [report, state, width]);

  function startResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const rtl = document.documentElement.dir === 'rtl';
    const startX = event.clientX;
    const startWidth = width;
    const move = (next: globalThis.PointerEvent) => {
      const delta = rtl ? next.clientX - startX : startX - next.clientX;
      setPanelWidth(startWidth + delta);
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  function resizeByKey(event: KeyboardEvent<HTMLDivElement>) {
    const rtl = document.documentElement.dir === 'rtl';
    const grow = rtl ? 'ArrowRight' : 'ArrowLeft';
    const shrink = rtl ? 'ArrowLeft' : 'ArrowRight';
    if (event.key === grow) setPanelWidth(width + RESIZE_STEP);
    else if (event.key === shrink) setPanelWidth(width - RESIZE_STEP);
    else return;
    event.preventDefault();
  }

  const status =
    state === 'connected'
      ? { tone: 'success' as const, label: t('AiPanel.statusConnected') }
      : state === 'first-time'
        ? { tone: 'neutral' as const, label: t('AiPanel.statusSignIn', name) }
        : { tone: 'warning' as const, label: t('AiPanel.statusMissing') };

  return (
    <aside className="tm-ai-panel" aria-label={t('AiPanel.panelLabel')}>
      {/* A focusable separator with a value is the WAI-ARIA window-splitter widget: it is
          interactive, though the lint rules only know the plain, static separator. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="tm-ai-panel__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('AiPanel.resize')}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={width}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeByKey}
      >
        <span className="tm-ai-panel__grip" aria-hidden="true" />
      </div>
      <div className="tm-ai-panel__body">
        <div className="tm-ai-panel__header">
          <span className="tm-ai-panel__sparkle" aria-hidden="true">
            <SparkleIcon />
          </span>
          <h2 className="tm-ai-panel__name">{site.label}</h2>
          <span className="tm-ai-panel__spacer" />
          <span className="tm-ai-panel__switch">
            <Button tone="outline" size="default" className="tm-ai-button" onClick={onSwitch}>
              {t('AiPanel.switch')}
            </Button>
            {chooser}
          </span>
          <button
            type="button"
            className="tm-ai-panel__icon-button"
            aria-label={t('AiPanel.popOut')}
            onClick={onPopOut}
          >
            <PopOutIcon />
          </button>
          <button
            type="button"
            className="tm-ai-panel__icon-button"
            aria-label={t('AiPanel.close')}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="tm-ai-panel__trust">
          <span className="tm-ai-panel__lock" aria-hidden="true">
            <LockIcon />
          </span>
          <span className="tm-ai-panel__trust-text">{t('AiPanel.trust', name)}</span>
          <span className="tm-ai-panel__spacer" />
          <span className="tm-ai-panel__chip" dir="ltr">
            {host}
          </span>
        </div>
        <hr className="tm-ai-panel__divider" />

        {state === 'missing' ? (
          <div className="tm-ai-panel__notice">
            <ConnectorHint
              strong
              title={t('AiPanel.missingTitle', name)}
              site={site}
              address={address}
              action={
                <Button
                  tone="outline"
                  size="default"
                  className="tm-ai-button"
                  onClick={onCheckAgain}
                >
                  {t('AiPanel.checkAgain')}
                </Button>
              }
            />
          </div>
        ) : null}

        <div className="tm-ai-panel__area">
          <div ref={area} className="tm-ai-panel__site">
            <p className="tm-ai-panel__site-title">
              {state === 'first-time'
                ? t('AiPanel.signInTitle', name)
                : t('AiPanel.siteTitle', name)}
            </p>
            <p className="tm-ai-panel__site-body">
              {state === 'first-time'
                ? t('AiPanel.signInBody', name)
                : t('AiPanel.siteBody', { host })}
            </p>
          </div>
        </div>

        {state === 'first-time' ? (
          <div className="tm-ai-panel__setup">
            <ConnectorHint title={t('AiPanel.nextTitle', name)} site={site} address={address} />
          </div>
        ) : null}

        <div className="tm-ai-panel__status">
          <StatusDot tone={status.tone}>{status.label}</StatusDot>
        </div>
      </div>
    </aside>
  );
}

interface ConnectorHintProps {
  readonly title: string;
  readonly site: AssistantSite;
  readonly address: string;
  readonly strong?: boolean;
  readonly action?: ReactNode;
}

/** Figma "Connector hint" — where to add the TManage connector in the assistant. */
function ConnectorHint({ title, site, address, strong = false, action }: ConnectorHintProps) {
  const t = useAiPanelT();
  return (
    <div className="tm-ai-hint" data-strong={strong || undefined}>
      <p className="tm-ai-hint__title">{title}</p>
      <p className="tm-ai-hint__body">{t('AiPanel.addConnector', { name: site.label })}</p>
      <p className="tm-ai-hint__label">{t('AiPanel.connectorAddress')}</p>
      <ConnectorAddress address={address} />
      {action ? <div className="tm-ai-hint__actions">{action}</div> : null}
    </div>
  );
}
