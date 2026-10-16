'use client';

import { useEffect, useRef } from 'react';
import { browserApiClient } from '../../lib/api/browser-client';
import { listInbox, type InboxPage } from '../../lib/api/inbox';
import type { ApiClient } from '../../lib/api/client';
import {
  collectNoticeKeys,
  isNotificationSupported,
  readNotificationPermission,
  readOptInChoice,
  selectInboxNotices,
} from './notifications';

export interface InboxNotificationBridgeProps {
  organizationSlug: string;
  /** Injected in tests; the browser uses the shared client. */
  client?: ApiClient;
}

/** How often the bridge re-reads the inbox. Modest, and only while the user has opted in. */
const POLL_INTERVAL_MS = 60_000;

/**
 * Mirrors new inbox notices as local desktop notifications while the window is backgrounded
 * (slice 08, module 22). It renders nothing — mounted once in {@link AppShell}, it reuses the
 * existing inbox read and raises a local `Notification` for a notice the user has not yet seen.
 *
 * Deliberately a plain polling effect rather than a React Query hook: the bridge displays no
 * data and must not couple the presentational shell to a `QueryClient`. It polls only while the
 * person has opted in and the browser permits notifications, reuses the inbox endpoint rather
 * than adding one, and dedupes by notice key so a bundle re-notifies only when it actually
 * changes. The first eligible poll is seeded — the standing backlog is folded into the seen-set
 * without notifying — so turning the feature on never fires a burst for notices already there.
 */
export function InboxNotificationBridge({
  organizationSlug,
  client,
}: InboxNotificationBridgeProps) {
  const seen = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  useEffect(() => {
    const active =
      isNotificationSupported() && readNotificationPermission() === 'granted' && readOptInChoice();
    if (!active) {
      return;
    }

    let cancelled = false;
    const api = client ?? browserApiClient();

    const handle = (page: InboxPage) => {
      if (cancelled) {
        return;
      }
      const backgrounded = document.visibilityState === 'hidden';

      // A poll we will not notify for (first load, or the window is in front and the user already
      // sees the inbox) still marks everything current as seen, so the next backgrounded poll is
      // about change, not backlog.
      if (!seeded.current || !backgrounded) {
        for (const key of collectNoticeKeys(page)) {
          seen.current.add(key);
        }
        seeded.current = true;
        return;
      }

      for (const draft of selectInboxNotices(page, seen.current)) {
        seen.current.add(draft.key);
        try {
          // The OS owns the notification's lifetime once raised; we keep no handle to it.
          new Notification(draft.title, { body: draft.body, tag: draft.key });
        } catch {
          // Some browsers forbid the Notification constructor outside a SW; degrade silently.
        }
      }
    };

    const poll = () => {
      listInbox(api, organizationSlug, { mode: 'important' })
        .then(handle)
        .catch(() => {
          // Non-fatal: a failed background read simply means no notification this cycle.
        });
    };

    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [organizationSlug, client]);

  return null;
}
