'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Switch } from '@tmanage/ui';
import { formatLastUsed } from '../../lib/connected-apps-presentation';
import { PopOutIcon, SparkleIcon } from './icons';
import type { AssistantChoice, AssistantSite } from './assistant-sites';
import { useAiPanelT } from './use-ai-panel-t';

/** The address an assistant is given (Figma "Connector address"), with its Copy button. */
export function ConnectorAddress({ address }: { readonly address: string }) {
  const t = useAiPanelT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // No clipboard permission: the address stays on screen to select by hand.
    }
  }

  return (
    <div className="tm-ai-address">
      <code className="tm-ai-address__value" dir="ltr">
        {address}
      </code>
      <Button tone="outline" size="default" className="tm-ai-button" onClick={() => void copy()}>
        <span aria-live="polite">{copied ? t('AiPanel.copied') : t('AiPanel.copy')}</span>
      </Button>
    </div>
  );
}

/** Connected apps is a page, so its controls are links drawn as the design's buttons. */
const OUTLINE_LINK = 'tm-button tm-button--outline tm-button--default tm-ai-button';
const INK_LINK = 'tm-button tm-button--ink tm-button--compact';

/** The 32px sunken disc that carries the sparkle in the chooser and the empty state. */
function AssistantMark() {
  return (
    <span className="tm-ai-mark" aria-hidden="true">
      <SparkleIcon />
    </span>
  );
}

export interface AiChooserProps {
  readonly choices: readonly AssistantChoice[];
  readonly rememberedKey: string | null;
  readonly locale: string;
  readonly now: Date;
  readonly onPick: (site: AssistantSite, remember: boolean) => void;
  readonly connectedAppsHref: string;
  readonly onLeave: () => void;
}

/** Figma 402:6222 — the connected assistants, with "Always open …" and Connected apps. */
export function AiChooser({
  choices,
  rememberedKey,
  locale,
  now,
  onPick,
  connectedAppsHref,
  onLeave,
}: AiChooserProps) {
  const t = useAiPanelT();
  const [remember, setRemember] = useState(rememberedKey !== null);
  const [activeKey, setActiveKey] = useState(rememberedKey ?? choices[0]?.site.key ?? null);
  const firstRow = useRef<HTMLButtonElement>(null);
  useEffect(() => firstRow.current?.focus(), []);
  const active = choices.find((choice) => choice.site.key === activeKey) ?? choices[0];

  return (
    <div
      className="tm-ai-popover tm-ai-chooser"
      role="dialog"
      aria-labelledby="tm-ai-chooser-title"
    >
      <div className="tm-ai-chooser__heading">
        <p id="tm-ai-chooser-title" className="tm-ai-chooser__title">
          {t('AiPanel.chooserTitle')}
        </p>
        <p className="tm-ai-chooser__hint">{t('AiPanel.chooserHint')}</p>
      </div>
      <ul className="tm-ai-chooser__list">
        {choices.map((choice, index) => {
          const { connection, site } = choice;
          const detail = connection.lastUsedAt
            ? t('AiPanel.connectedByUsed', {
                name: connection.memberName,
                when: formatLastUsed(connection.lastUsedAt, now, locale),
              })
            : t('AiPanel.connectedByUnused', { name: connection.memberName });
          return (
            <li key={site.key}>
              <button
                ref={index === 0 ? firstRow : undefined}
                type="button"
                className="tm-ai-chooser__row"
                data-active={site.key === active?.site.key || undefined}
                onMouseEnter={() => setActiveKey(site.key)}
                onFocus={() => setActiveKey(site.key)}
                onClick={() => onPick(site, remember)}
              >
                <AssistantMark />
                <span className="tm-ai-chooser__text">
                  <span className="tm-ai-chooser__name">{site.label}</span>
                  <span className="tm-ai-chooser__detail">{detail}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <hr className="tm-ai-chooser__divider" />
      <div className="tm-ai-chooser__foot">
        <Switch
          className="tm-ai-chooser__remember"
          label={t('AiPanel.alwaysOpen', { name: active?.site.label ?? '' })}
          checked={remember}
          onChange={(event) => setRemember(event.currentTarget.checked)}
        />
        <Link href={connectedAppsHref} className={OUTLINE_LINK} onClick={onLeave}>
          {t('AiPanel.connectedApps')}
        </Link>
      </div>
    </div>
  );
}

export interface AiEmptyStateProps {
  readonly address: string;
  readonly connectedAppsHref: string;
  readonly onNotNow: () => void;
}

/** Figma 402:6355 — nothing connected yet: the connector address and the way to Connected apps. */
export function AiEmptyState({ address, connectedAppsHref, onNotNow }: AiEmptyStateProps) {
  const t = useAiPanelT();
  return (
    <div className="tm-ai-popover tm-ai-card" role="dialog" aria-labelledby="tm-ai-empty-title">
      <div className="tm-ai-card__title-row">
        <AssistantMark />
        <p id="tm-ai-empty-title" className="tm-ai-card__title">
          {t('AiPanel.emptyTitle')}
        </p>
      </div>
      <p className="tm-ai-card__body">{t('AiPanel.emptyBody')}</p>
      <ConnectorAddress address={address} />
      <div className="tm-ai-card__actions">
        <Button tone="outline" size="default" className="tm-ai-button" onClick={onNotNow}>
          {t('AiPanel.notNow')}
        </Button>
        <Link href={connectedAppsHref} className={INK_LINK} onClick={onNotNow}>
          {t('AiPanel.openConnectedApps')}
        </Link>
      </div>
    </div>
  );
}

export interface AiWindowPopoverProps {
  readonly site: AssistantSite;
  readonly appHost: string;
  readonly onOpen: () => void;
  readonly onNotNow: () => void;
}

/** Figma 402:6473 — on the website the assistant opens in its own window beside TManage. */
export function AiWindowPopover({ site, appHost, onOpen, onNotNow }: AiWindowPopoverProps) {
  const t = useAiPanelT();
  const name = { name: site.label };
  return (
    <div
      className="tm-ai-popover tm-ai-card tm-ai-card--window"
      role="dialog"
      aria-labelledby="tm-ai-window-title"
    >
      <div className="tm-ai-card__title-row">
        <span className="tm-ai-card__glyph" aria-hidden="true">
          <PopOutIcon size={18} />
        </span>
        <p id="tm-ai-window-title" className="tm-ai-card__title">
          {t('AiPanel.windowTitle', name)}
        </p>
      </div>
      <p className="tm-ai-card__body">{t('AiPanel.windowBody', name)}</p>
      <div className="tm-ai-placement" aria-hidden="true">
        <span className="tm-ai-placement__app">TManage</span>
        <span className="tm-ai-placement__assistant">{site.label}</span>
      </div>
      <p className="tm-ai-card__note">{t('AiPanel.windowPopups', { host: appHost })}</p>
      <div className="tm-ai-card__actions">
        <Button tone="outline" size="default" className="tm-ai-button" onClick={onNotNow}>
          {t('AiPanel.notNow')}
        </Button>
        <Button tone="ink" size="compact" onClick={onOpen}>
          {t('AiPanel.open', name)}
        </Button>
      </div>
    </div>
  );
}
