'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Tooltip, MOTION_DELAY_TOOLTIP_MS } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getConnectedApps } from '../../lib/api/connected-apps';
import { connectorAddress, deploymentAddress } from '../../lib/ai-connector-address';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import {
  assistantChoices,
  besideWindowPlacement,
  connectionState,
  decideLaunch,
  readRemembered,
  rememberKey,
  siteByKey,
  writeRemembered,
  type AssistantSite,
} from './assistant-sites';
import { desktopAiPanel } from './desktop-bridge';
import { AiChooser, AiEmptyState, AiWindowPopover } from './AiPopovers';
import { AiSidePanel } from './AiSidePanel';
import { hidePanel, showPanel, usePanelState } from './panel-store';
import { useAiPanelT } from './use-ai-panel-t';
import { AiChatPanel, AI_CONVERSATIONS_KEY } from '../ai-chat/AiChatPanel';
import { listAiConversations } from '../../lib/api/ai-chat';
import { aiPanelKey, getAiPanel } from '../../lib/api/ai-panel';
import { AiPanel } from './AiPanel';
import { defaultTab, panelLayout } from './ai-panel-model';
import { takeYourAiRequest } from './open-your-ai';
import './ai-panel.css';

/** Which popover is open, and where: under the top-bar button, or under the panel's Switch. */
type Popover =
  | { readonly kind: 'none' }
  | { readonly kind: 'chooser'; readonly from: 'button' | 'panel' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'window'; readonly site: AssistantSite };

const NONE: Popover = { kind: 'none' };
/** How often the panel looks for a new connection while step 3 waits (as Settings › AI assistant). */
const WAIT_FOR_CONNECTION_MS = 8_000;
const EXPLAINED_KEY = 'tmanage.ai-panel.window-explained';

function windowExplained(siteKey: string): boolean {
  try {
    return (window.localStorage.getItem(EXPLAINED_KEY) ?? '').split(',').includes(siteKey);
  } catch {
    return false;
  }
}

function markWindowExplained(siteKey: string): void {
  try {
    const seen = new Set((window.localStorage.getItem(EXPLAINED_KEY) ?? '').split(','));
    seen.add(siteKey);
    window.localStorage.setItem(EXPLAINED_KEY, [...seen].filter(Boolean).join(','));
  } catch {
    // Without storage the explanation simply shows again next time.
  }
}

/** The website: the assistant's own site in a separate window beside TManage. */
function openBeside(site: AssistantSite): void {
  const rtl = document.documentElement.dir === 'rtl';
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
  const place = besideWindowPlacement(
    {
      availLeft: screen.availLeft ?? 0,
      availTop: screen.availTop ?? 0,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
    },
    window,
    rtl,
  );
  const features = `popup,noopener,noreferrer,left=${place.left},top=${place.top},width=${place.width},height=${place.height}`;
  window.open(site.home, `tmanage-ai-${site.key}`, features);
}

/**
 * "Let AI do the job" — the one control the app's top bar carries for the AI side panel (Figma
 * section 400:5399). Reads the person's Connected apps only once pressed.
 */
export function AiPanelLauncher({
  organizationSlug,
  variant = 'button',
}: {
  readonly organizationSlug: string;
  /** `orb`: My Day's AI orb at the end of the day bar (spec MYDAY-V4 §4.1), named in a tooltip. */
  readonly variant?: 'button' | 'orb';
}) {
  const t = useAiPanelT();
  const locale = useActiveLocale();
  const panel = usePanelState();
  const [popover, setPopover] = useState<Popover>(NONE);
  const [wanted, setWanted] = useState(panel.siteKey !== null);
  const anchor = useRef<HTMLDivElement>(null);
  const api = useMemo(() => browserApiClient(), []);
  const bridge = useMemo(() => desktopAiPanel(), []);

  const view = useQuery({
    queryKey: ['connected-apps', organizationSlug],
    queryFn: () => getConnectedApps(api, organizationSlug),
    enabled: wanted,
  });
  const [aiOpen, setAiOpen] = useState(false);
  // The approvals badge asked for tab 2 ("Your AI"): open the panel there once it is read.
  const [fromApprovals, setFromApprovals] = useState(false);
  useEffect(() => {
    if (!takeYourAiRequest()) return;
    setFromApprovals(true);
    setAiOpen(true);
  }, []);
  // AI panel with two tabs (Figma 851:906): one read lays the panel out (gap 4). While nothing is
  // connected and the panel is open, it is read again so step 3 turns into the connected view.
  const panelView = useQuery({
    queryKey: aiPanelKey(organizationSlug),
    queryFn: () => getAiPanel(api, organizationSlug),
    retry: false,
    staleTime: 30_000,
    refetchInterval: (query) =>
      aiOpen && query.state.data?.apps.length === 0 ? WAIT_FOR_CONNECTION_MS : false,
  });
  const layout = panelView.data ? panelLayout(panelView.data) : null;
  // Plan 62-15 fallback: if the panel read fails, a workspace with TManage AI still answers this
  // read and opens the chat; any other keeps the own-AI behaviour below.
  const tmanageAi = useQuery({
    queryKey: AI_CONVERSATIONS_KEY(organizationSlug),
    queryFn: () => listAiConversations(api, organizationSlug),
    retry: false,
    staleTime: 5 * 60_000,
    enabled: panelView.isError,
  });
  const chatOnly = layout === 'tmanage-only' || (panelView.isError && tmanageAi.isSuccess);
  const twoWays = layout === 'tabs' || layout === 'own-only';
  // Without a "Your AI" tab (the panel read failed, or only TManage AI is in use) the badge's
  // request goes to the AI actions list instead, where the same waiting actions are.
  const settled = panelView.isError ? !tmanageAi.isPending : panelView.isSuccess;
  useEffect(() => {
    if (!fromApprovals || !settled || twoWays) return;
    setFromApprovals(false);
    setAiOpen(false);
    window.location.assign(`/${encodeURIComponent(organizationSlug)}/settings/ai-actions`);
  }, [fromApprovals, settled, twoWays, organizationSlug]);
  const choices = useMemo(() => assistantChoices(view.data?.apps ?? []), [view.data]);
  const storageKey = rememberKey(organizationSlug, view.data?.viewerName ?? '');
  const address = connectorAddress(deploymentAddress());

  const close = useCallback(() => setPopover(NONE), []);

  const open = useCallback(
    (site: AssistantSite, fromGesture: boolean) => {
      setPopover(NONE);
      if (bridge) {
        showPanel(site.key);
        return;
      }
      if (fromGesture && windowExplained(site.key)) openBeside(site);
      else setPopover({ kind: 'window', site });
    },
    [bridge],
  );

  // The first press waits for the Connected apps read; it then decides, once.
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending || !view.data) return;
    setPending(false);
    const decision = decideLaunch(choices, readRemembered(storageKey));
    if (decision.kind === 'empty') setPopover({ kind: 'empty' });
    else if (decision.kind === 'choose') setPopover({ kind: 'chooser', from: 'button' });
    else open(decision.site, false);
  }, [pending, view.data, choices, storageKey, open]);

  function press() {
    if (chatOnly || twoWays) {
      setFromApprovals(false);
      setAiOpen((open) => !open);
      return;
    }
    if (popover.kind !== 'none') {
      close();
      return;
    }
    setWanted(true);
    if (!view.data) {
      setPending(true);
      return;
    }
    const decision = decideLaunch(choices, readRemembered(storageKey));
    if (decision.kind === 'empty') setPopover({ kind: 'empty' });
    else if (decision.kind === 'choose') setPopover({ kind: 'chooser', from: 'button' });
    else open(decision.site, true);
  }

  function pick(site: AssistantSite, remember: boolean) {
    writeRemembered(storageKey, remember ? site.key : null);
    open(site, true);
  }

  const connectedAppsHref = `/${organizationSlug}/settings/connected-apps`;

  // Escape and a press outside close a popover.
  useEffect(() => {
    if (popover.kind === 'none') return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.current?.contains(target)) return;
      if ((target as Element).closest?.('.tm-ai-panel__switch')) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [popover.kind, close]);

  // Inside the desktop app: open (or switch) the docked view when the panel's assistant changes.
  const openedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!bridge) return;
    if (panel.siteKey && panel.siteKey !== openedKey.current) {
      openedKey.current = panel.siteKey;
      void bridge.open({
        site: panel.siteKey,
        bounds: { x: 0, y: 0, width: 0, height: 0, visible: false },
      });
    }
    if (!panel.siteKey) openedKey.current = null;
  }, [bridge, panel.siteKey]);

  const chooser =
    popover.kind === 'chooser' ? (
      <AiChooser
        choices={choices}
        rememberedKey={readRemembered(storageKey)}
        locale={locale}
        now={new Date()}
        onPick={pick}
        connectedAppsHref={connectedAppsHref}
        onLeave={close}
      />
    ) : null;

  const panelSite = siteByKey(panel.siteKey);
  const panelChoice = choices.find((choice) => choice.site.key === panelSite?.key);

  const expanded =
    aiOpen ||
    (popover.kind !== 'none' && !(popover.kind === 'chooser' && popover.from === 'panel'));

  return (
    <div className="tm-ai-launcher" ref={anchor}>
      {variant === 'orb' ? (
        <Tooltip content={t('AiPanel.launch')} delayMs={MOTION_DELAY_TOOLTIP_MS} placement="bottom">
          <button
            type="button"
            className="tm-day-pulse__search tm-day-pulse__orb"
            aria-label={t('AiPanel.launch')}
            aria-haspopup="dialog"
            aria-expanded={expanded}
            aria-busy={pending || undefined}
            onClick={press}
          >
            <span aria-hidden="true">AI</span>
          </button>
        </Tooltip>
      ) : (
        <Button
          tone="outline"
          size="default"
          aria-haspopup="dialog"
          aria-expanded={expanded}
          loading={pending}
          onClick={press}
        >
          {t('AiPanel.launch')}
        </Button>
      )}

      {popover.kind === 'chooser' && popover.from === 'button' ? chooser : null}
      {popover.kind === 'empty' ? (
        <AiEmptyState address={address} connectedAppsHref={connectedAppsHref} onNotNow={close} />
      ) : null}
      {popover.kind === 'window' ? (
        <AiWindowPopover
          site={popover.site}
          appHost={window.location.host}
          onNotNow={close}
          onOpen={() => {
            markWindowExplained(popover.site.key);
            close();
            openBeside(popover.site);
          }}
        />
      ) : null}

      {aiOpen && twoWays && panelView.data && (layout === 'tabs' || layout === 'own-only')
        ? createPortal(
            <AiPanel
              api={api}
              organizationSlug={organizationSlug}
              layout={layout}
              view={panelView.data}
              initialTab={defaultTab(panelView.data, fromApprovals)}
              address={address}
              onRetry={() => void panelView.refetch()}
              onClose={() => {
                setAiOpen(false);
                setFromApprovals(false);
                anchor.current?.querySelector('button')?.focus();
              }}
            />,
            document.body,
          )
        : null}

      {aiOpen && chatOnly && !fromApprovals
        ? createPortal(
            <AiChatPanel
              organizationSlug={organizationSlug}
              client={api}
              onClose={() => {
                setAiOpen(false);
                anchor.current?.querySelector('button')?.focus();
              }}
            />,
            document.body,
          )
        : null}

      {bridge && panelSite
        ? createPortal(
            <AiSidePanel
              bridge={bridge}
              site={panelSite}
              width={panel.width}
              state={
                view.data ? connectionState(panelChoice, view.data.aiAccessEnabled) : 'connected'
              }
              address={address}
              chooser={popover.kind === 'chooser' && popover.from === 'panel' ? chooser : null}
              onSwitch={() =>
                setPopover((current) =>
                  current.kind === 'chooser' ? NONE : { kind: 'chooser', from: 'panel' },
                )
              }
              onPopOut={() => {
                void bridge.popOut().then(() => hidePanel());
              }}
              onClose={() => {
                void bridge.close();
                hidePanel();
              }}
              onCheckAgain={() => void view.refetch()}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
