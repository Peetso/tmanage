'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { InfoButton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { AiPanelView } from '../../lib/api/ai-panel';
import { usePendingAiApprovals } from '../ai-actions/pending-ai-actions';
import { AiChatPanel } from '../ai-chat/AiChatPanel';
import { BackIcon, CloseIcon } from '../ai-chat/icons';
import { useAiText } from '../ai-chat/use-ai-text';
import { tmanageAiOff, type AiPanelTab } from './ai-panel-model';
import { CountCapsule, TmanageAiOff, YourAiTab } from './YourAiTab';
import { useAiPanelT } from './use-ai-panel-t';
import './your-ai.css';

export interface AiPanelProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** `tabs`: both directions; `own-only`: Your AI alone, with a plain title. */
  readonly layout: 'tabs' | 'own-only';
  readonly view: AiPanelView;
  readonly initialTab: AiPanelTab;
  readonly address: string;
  readonly onClose: () => void;
  readonly onRetry: () => void;
  readonly failed?: boolean;
  readonly now?: () => Date;
}

/**
 * The AI panel with two tabs (Figma 851:906: 857:906 tab 1, 857:1014 tab 2, 857:1377 Your AI
 * only; phone 860:906 / 860:1021). Both directions are managed here: tab 1 is the TManage AI chat,
 * every feature kept; tab 2 is the member's own AI. The tab bar shows only when both can be used
 * (`panelLayout`); with Your AI alone the panel has a plain title and an ⓘ.
 *
 * The tabs follow the WAI-ARIA APG tabs pattern with automatic activation: one tab stop, arrow
 * keys move and select (mirrored in Arabic), Home and End jump. Both panels stay mounted so a
 * conversation survives a look at tab 2. Escape closes the panel; on a phone the close control is
 * Back (44 px).
 */
export function AiPanel({
  api,
  organizationSlug,
  layout,
  view,
  initialTab,
  address,
  onClose,
  onRetry,
  failed = false,
  now,
}: AiPanelProps) {
  const t = useAiPanelT();
  const text = useAiText();
  const ids = useId();
  const [tab, setTab] = useState<AiPanelTab>(layout === 'own-only' ? 'own' : initialTab);
  const tabRefs = useRef<Record<AiPanelTab, HTMLButtonElement | null>>({
    tmanage: null,
    own: null,
  });
  const title = useRef<HTMLHeadingElement>(null);
  const pending = usePendingAiApprovals(organizationSlug, api);
  // The same number as the "AI actions" badge (must-fix 6): the shared waiting list first.
  const count = pending.data?.length ?? view.pendingApprovals;

  // The panel takes focus on open: the selected tab, or the title without tabs.
  useEffect(() => {
    if (layout === 'tabs') tabRefs.current[tab]?.focus();
    else title.current?.focus();
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPanelKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const rtl = document.documentElement.dir === 'rtl';
    const order: AiPanelTab[] = ['tmanage', 'own'];
    const index = order.indexOf(tab);
    let next: AiPanelTab | null = null;
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = order[(index + 1) % 2]!;
    else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = order[(index + 1) % 2]!;
    else if (event.key === 'Home') next = 'tmanage';
    else if (event.key === 'End') next = 'own';
    if (next === null) return;
    event.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  const tabId = (which: AiPanelTab) => `${ids}-tab-${which}`;
  const panelId = (which: AiPanelTab) => `${ids}-panel-${which}`;
  // One close control per width: Back at the start on a phone (Figma 860:906), Close at the end
  // on wider screens. CSS shows one, so a screen reader meets one.
  const closeButton = (
    <button
      type="button"
      className="tm-aic__icon"
      aria-label={t('AiPanel.close')}
      onClick={onClose}
    >
      <CloseIcon />
    </button>
  );
  const backButton = (
    <button
      type="button"
      className="tm-aic__icon tm-aic__back"
      aria-label={t('AiPanel.close')}
      onClick={onClose}
    >
      <BackIcon />
    </button>
  );

  const yourAi = (
    <YourAiTab
      api={api}
      organizationSlug={organizationSlug}
      view={view}
      failed={failed}
      onRetry={onRetry}
      address={address}
      active={tab === 'own'}
      {...(now ? { now } : {})}
    />
  );

  if (layout === 'own-only') {
    return (
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
      <aside
        className="tm-aic tm-aip"
        data-variant="docked"
        aria-labelledby={`${ids}-title`}
        onKeyDown={onPanelKey}
      >
        <header className="tm-aip-header tm-aip-header--title">
          <span className="tm-aip-header__back">{backButton}</span>
          <h2 id={`${ids}-title`} ref={title} tabIndex={-1} className="tm-aic__title">
            {t('AiPanel.tabYourAi')}
          </h2>
          <InfoButton title={t('AiPanel.tabYourAi')} label={t('AiPanel.yourAi.infoLabel')}>
            {t('AiPanel.yourAi.info')}
          </InfoButton>
          <span className="tm-aic__spacer" />
          <span className="tm-aip-header__end">{closeButton}</span>
        </header>
        {yourAi}
        <p className="tm-aip-footer">{t('AiPanel.yourAi.trust')}</p>
      </aside>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      className="tm-aic tm-aip"
      data-variant="docked"
      aria-label={t('AiPanel.panelLabel')}
      onKeyDown={onPanelKey}
    >
      <header className="tm-aip-header">
        <span className="tm-aip-header__back">{backButton}</span>
        <div className="tm-aip-tabs" role="tablist" aria-label={t('AiPanel.panelLabel')}>
          {(['tmanage', 'own'] as const).map((which) => (
            <button
              key={which}
              ref={(element) => {
                tabRefs.current[which] = element;
              }}
              id={tabId(which)}
              type="button"
              role="tab"
              className="tm-aip-tab"
              aria-selected={tab === which}
              aria-controls={panelId(which)}
              tabIndex={tab === which ? 0 : -1}
              onClick={() => setTab(which)}
              onKeyDown={onTabKey}
            >
              <span>{which === 'tmanage' ? text.t('AiChat.title') : t('AiPanel.tabYourAi')}</span>
              {which === 'own' ? (
                <CountCapsule
                  count={count}
                  label={t('AiPanel.waitingCount', { count: String(count) })}
                />
              ) : null}
            </button>
          ))}
        </div>
        <span className="tm-aic__spacer" />
        <span className="tm-aip-header__end">{closeButton}</span>
      </header>

      {tmanageAiOff(view) ? (
        <div
          role="tabpanel"
          id={panelId('tmanage')}
          aria-labelledby={tabId('tmanage')}
          hidden={tab !== 'tmanage'}
          className="tm-aip-panel"
        >
          <TmanageAiOff
            organizationSlug={organizationSlug}
            canManage={view.tmanageAi.canManage}
            showYourAi
            onYourAi={() => {
              setTab('own');
              tabRefs.current.own?.focus();
            }}
          />
        </div>
      ) : (
        <AiChatPanel
          organizationSlug={organizationSlug}
          client={api}
          variant="tab"
          tabPanel={{
            id: panelId('tmanage'),
            labelledBy: tabId('tmanage'),
            hidden: tab !== 'tmanage',
          }}
        />
      )}

      <div
        role="tabpanel"
        id={panelId('own')}
        aria-labelledby={tabId('own')}
        hidden={tab !== 'own'}
        className="tm-aip-panel"
      >
        {yourAi}
        <p className="tm-aip-footer">{t('AiPanel.yourAi.trust')}</p>
      </div>
    </aside>
  );
}
