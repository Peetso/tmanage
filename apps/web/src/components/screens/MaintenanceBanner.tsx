'use client';

import { useEffect, useState } from 'react';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPublicMaintenance } from '../../lib/api/maintenance';
import type { MaintenanceWindowView } from '../../lib/api/maintenance';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

export interface MaintenanceBannerProps {
  /** Test seam: an explicit client instead of the process-wide browser client. */
  client?: ApiClient;
  /**
   * Test seam: seed the window directly and skip the fetch. `undefined` (the default) fetches on
   * mount; an explicit value (including `null`) renders from it without a network call.
   */
  initialWindow?: MaintenanceWindowView | null;
}

/** The message key for each severity — every state that uses colour also carries a word (token law 3). */
const SEVERITY_LABEL: Record<MaintenanceWindowView['severity'], MessageKey> = {
  info: 'MaintenanceBanner.severityInfo',
  degraded: 'MaintenanceBanner.severityDegraded',
  down: 'MaintenanceBanner.severityDown',
};

/** The per-session dismissal key, scoped to the window id so a new window shows again. */
function dismissedKey(id: string): string {
  return `tmanage.maintenance-dismissed.${id}`;
}

function isDismissed(id: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(dismissedKey(id)) === '1';
  } catch {
    return false;
  }
}

function rememberDismissed(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(dismissedKey(id), '1');
  } catch {
    // A private window or blocked storage is not an error the banner should surface.
  }
}

/**
 * Platform states (x185) — the platform maintenance / degraded-mode banner.
 *
 * `38-MODULE-MAP` §Platform states (maintenance). Mounted once in {@link AppShell}, it reads the
 * public `GET /public/site/maintenance` endpoint (no session, no tenant) and shows a banner only when
 * a published window is currently **active**. It is dismissible for the session (client-only, in
 * `sessionStorage`, keyed by the window id so a later window shows again), and it renders nothing
 * whenever there is no active window, the fetch fails, or the reader has dismissed it — so a screen
 * that mounts the shell pays nothing for it by default.
 *
 * It uses a plain effect and `useState` rather than React Query, deliberately: the shell must not
 * force every screen test to provide a `QueryClient` it did not set up.
 */
export function MaintenanceBanner({ client, initialWindow }: MaintenanceBannerProps) {
  const t = useT();
  const [window_, setWindow] = useState<MaintenanceWindowView | null>(initialWindow ?? null);
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    // A seeded window (the test seam) skips the fetch entirely.
    if (initialWindow !== undefined) return;
    let live = true;
    const api = client ?? browserApiClient();
    fetchPublicMaintenance(api)
      .then((view) => {
        if (live) setWindow(view.window);
      })
      .catch(() => {
        // The banner is best-effort: a failed read simply shows nothing.
      });
    return () => {
      live = false;
    };
  }, [client, initialWindow]);

  useEffect(() => {
    if (window_ !== null) setDismissed(isDismissed(window_.id));
  }, [window_]);

  if (window_ === null || !window_.active || dismissed) return null;

  const label = t(SEVERITY_LABEL[window_.severity]);

  return (
    <div
      className={`tm-maintenance-banner tm-maintenance-banner--${window_.severity}`}
      role="region"
      aria-label={t('MaintenanceBanner.platformStatus')}
    >
      <p className="tm-maintenance-banner__body" aria-live="polite">
        <span className="tm-maintenance-banner__label">{label}:</span>{' '}
        <span className="tm-maintenance-banner__message">{window_.message}</span>
      </p>
      <button
        type="button"
        className="tm-maintenance-banner__dismiss"
        onClick={() => {
          rememberDismissed(window_.id);
          setDismissed(true);
        }}
      >
        {t('MaintenanceBanner.dismiss')}
      </button>
    </div>
  );
}
