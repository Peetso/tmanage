'use client';

import { useEffect, useRef } from 'react';
import { useParams, usePathname } from 'next/navigation';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { listConversationUnread } from '../../lib/api/conversation-read-state';
import { getConversationMute } from '../../lib/api/conversation-mute';
import { markConversationDelivered } from '../../lib/api/receipts';
import { chatSocketFor } from '../../lib/chat-socket';
import { useT } from '../../lib/i18n/use-t';
import {
  isNotificationSupported,
  readNotificationPermission,
  readOptInChoice,
} from './notifications';

/** The desktop shell's notification bridge (`apps/desktop/src/preload.ts` → `tmanageDesktop`). */
interface DesktopNotify {
  notify?: (request: { title: string; body?: string }) => Promise<unknown>;
}

/** The most conversations the bridge follows at once; the list refreshes every five minutes. */
const MAX_FOLLOWED = 50;
const REFRESH_MS = 5 * 60_000;

/**
 * Pure: whether a `message.created.v1` frame for `conversationId` should raise a notice — not
 * for the conversation open in a visible tab, and never for a muted one.
 */
export function shouldNotifyChat(input: {
  readonly conversationId: string;
  readonly openConversationId: string | null;
  readonly visible: boolean;
  readonly muted: boolean;
}): boolean {
  if (input.muted) return false;
  return !(input.visible && input.openConversationId === input.conversationId);
}

/**
 * R7 (F6) — chat notifications on the web (a local `Notification`, the opt-in from Preferences)
 * and in the desktop app (the shell's native notification). Rendered once by the chat shell as
 * `<ChatNotificationBridge />`. It follows the viewer's conversations on the shared chat socket;
 * frames are ids only, so the notice says "New message" and never quotes the text. A frame that
 * arrives while its conversation is not on screen is also recorded as delivered (receipts).
 */
export function ChatNotificationBridge({ client }: { readonly client?: ApiClient }) {
  const t = useT();
  const params = useParams<{ orgSlug?: string }>();
  const organizationSlug = typeof params?.orgSlug === 'string' ? params.orgSlug : '';
  const pathname = usePathname() ?? '';
  const open = useRef<string | null>(null);
  open.current = /\/chat\/([^/?#]+)/.exec(pathname)?.[1] ?? null;
  const title = useRef(t('ChatStatus.notificationTitle'));
  title.current = t('ChatStatus.notificationTitle');
  const body = useRef(t('ChatStatus.notificationBody'));
  body.current = t('ChatStatus.notificationBody');

  useEffect(() => {
    if (organizationSlug === '') return;
    const api = client ?? browserApiClient();
    const socket = chatSocketFor(api, organizationSlug);
    const muted = new Map<string, boolean>();
    const unwatch = new Map<string, () => void>();
    let cancelled = false;

    const refresh = async () => {
      try {
        const rows = (await listConversationUnread(api, organizationSlug)).slice(0, MAX_FOLLOWED);
        if (cancelled) return;
        const ids = new Set(rows.map((row) => row.conversationId));
        for (const [id, off] of unwatch) {
          if (!ids.has(id)) {
            off();
            unwatch.delete(id);
          }
        }
        for (const id of ids) {
          if (!unwatch.has(id)) unwatch.set(id, socket.watch(id));
          void getConversationMute(api, organizationSlug, id)
            .then((view) => muted.set(id, view.muted))
            .catch(() => undefined);
        }
      } catch {
        // Non-fatal: no list, no notices this cycle.
      }
    };

    const unlisten = socket.listen((frame) => {
      if (frame['type'] !== 'event' || frame['eventType'] !== 'message.created.v1') return;
      const conversationId = frame['conversationId'];
      const messageId = frame['objectId'];
      if (typeof conversationId !== 'string' || !unwatch.has(conversationId)) return;
      const visible = document.visibilityState === 'visible';
      const onScreen = visible && open.current === conversationId;
      if (!onScreen && typeof messageId === 'string') {
        void markConversationDelivered(api, organizationSlug, conversationId, messageId).catch(
          () => undefined,
        );
      }
      if (
        !shouldNotifyChat({
          conversationId,
          openConversationId: open.current,
          visible,
          muted: muted.get(conversationId) ?? false,
        })
      ) {
        return;
      }
      const desktop = (window as unknown as { tmanageDesktop?: DesktopNotify }).tmanageDesktop;
      if (desktop?.notify) {
        void desktop.notify({ title: title.current, body: body.current }).catch(() => undefined);
        return;
      }
      if (!isNotificationSupported() || readNotificationPermission() !== 'granted') return;
      if (!readOptInChoice()) return;
      try {
        new Notification(title.current, { body: body.current, tag: `chat:${conversationId}` });
      } catch {
        // Some browsers forbid the constructor outside a service worker; degrade silently.
      }
    });

    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unlisten();
      for (const off of unwatch.values()) off();
    };
  }, [organizationSlug, client]);

  return null;
}
