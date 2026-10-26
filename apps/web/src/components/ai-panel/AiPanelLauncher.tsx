'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
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
import './ai-panel.css';

/** Which popover is open, and where: under the top-bar button, or under the panel's Switch. */
type Popover =
  | { readonly kind: 'none' }
  | { readonly kind: 'chooser'; readonly from: 'button' | 'panel' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'window'; readonly site: AssistantSite };

const NONE: Popover = { kind: 'none' };
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
export function AiPanelLauncher({ organizationSlug }: { readonly organizationSlug: string }) {
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

  return (
    <div className="tm-ai-launcher" ref={anchor}>
      <Button
        tone="outline"
        size="default"
        className="tm-ai-button"
        aria-haspopup="dialog"
        aria-expanded={
          popover.kind !== 'none' && !(popover.kind === 'chooser' && popover.from === 'panel')
        }
        loading={pending}
        onClick={press}
      >
        {t('AiPanel.launch')}
      </Button>

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
