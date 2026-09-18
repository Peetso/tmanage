'use client';

import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from './api/client';
import { mintRealtimeTicket } from './api/realtime';

/**
 * The channel's live feed — RT-001's browser half, `13-ENGINEERING` §6's client duties.
 *
 * The hook owns the whole socket lifecycle so the screen owns none of it: mint a ticket,
 * open the socket the mint named, subscribe to the one conversation, and hand every frame
 * to the caller — whose correct response is a *refetch through the ordinary authorized
 * read path*, never trusting frame content, because frames are ids and the durable truth
 * is the API's (`24-EVENT-CATALOG` §2). A gap needs no special case under that rule: the
 * refetch that answers any frame also answers whatever was missed, and the `subscribed`
 * cursor triggers one refetch up front to cover the window between page load and
 * subscription.
 *
 * Reconnects back off exponentially with jitter (§6's own words), each attempt minting a
 * fresh ticket — the old one died of its sixty-second TTL long before most retries. A
 * deployment whose mint answers `socketUrl: null` runs no socket, and the hook settles at
 * `off` without retrying: dialing a port nothing answers is not resilience.
 *
 * ## Revocation (RT-001's server half, slice x18)
 *
 * When authority is withdrawn — a membership suspended, a role capability removed, a channel
 * membership dropped — the worker unsubscribes the connection and sends `{type:'revoked'}`
 * (`apps/worker/src/realtime/server.ts`). That is *not* a transient socket hiccup: reconnecting
 * would only re-subscribe to something the server will refuse again, a silent retry loop
 * against an access the person no longer has. So a `revoked` frame is terminal here — the hook
 * stops retrying, closes the socket, drops to the `'revoked'` status, and calls `onRevoked`
 * once so the screen can drop stale state and send the person to the signed-out path. A plain
 * socket close (including the 4401 the worker sends when a ticket's short TTL lapses) is *not*
 * revocation: it is the ordinary end of a ticket's life and still reconnects with a fresh mint.
 * A fully ended session is handled one layer down — `mintRealtimeTicket` goes through
 * `ApiClient`, whose refresh-refused path announces `session-ended` and navigates this screen
 * away, unmounting the hook.
 *
 * ## The seam
 *
 * `socketFactory` exists because jsdom has no WebSocket and a suite must drive this hook
 * with a fake — the same inversion `ApiClient` gives every screen. The default factory
 * uses the browser's own `WebSocket` and answers `null` where none exists (SSR), which
 * also settles the hook at `off`.
 */

export interface LiveSocket {
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export type LiveSocketFactory = (url: string) => LiveSocket | null;

export type LiveFeedStatus = 'off' | 'connecting' | 'live' | 'retrying' | 'revoked';

export interface ChannelLiveFeedOptions {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly conversationId: string;
  readonly enabled: boolean;
  /** Called on every frame and once on subscribe. Refetch; never apply frame content. */
  readonly onCatchUp: () => void;
  /**
   * Called once when the server revokes this channel (`{type:'revoked'}`). The hook has
   * already stopped reconnecting; the screen decides what a revoked person sees — the app
   * wires this to the authentication boundary's signed-out path.
   */
  readonly onRevoked?: () => void;
  readonly socketFactory?: LiveSocketFactory;
  /** Base for the reconnect backoff. Small in tests; the default is a second. */
  readonly reconnectBaseMs?: number;
}

const RECONNECT_CAP_MS = 30_000;

function defaultFactory(url: string): LiveSocket | null {
  if (typeof WebSocket === 'undefined') return null;
  return new WebSocket(url) as unknown as LiveSocket;
}

export function useChannelLiveFeed(options: ChannelLiveFeedOptions): LiveFeedStatus {
  const [status, setStatus] = useState<LiveFeedStatus>(options.enabled ? 'connecting' : 'off');
  // The latest callback without re-running the effect: the feed's lifetime is the
  // conversation's, not the render's.
  const onCatchUp = useRef(options.onCatchUp);
  onCatchUp.current = options.onCatchUp;
  const onRevoked = useRef(options.onRevoked);
  onRevoked.current = options.onRevoked;

  const { api, organizationSlug, conversationId, enabled } = options;
  const factory = options.socketFactory ?? defaultFactory;
  const baseMs = options.reconnectBaseMs ?? 1_000;

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      return;
    }

    let disposed = false;
    let socket: LiveSocket | null = null;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      if (disposed) return;
      setStatus(attempts === 0 ? 'connecting' : 'retrying');

      let minted;
      try {
        minted = await mintRealtimeTicket(api, organizationSlug);
      } catch {
        scheduleRetry();
        return;
      }
      if (disposed) return;
      if (minted.socketUrl === null) {
        // This deployment runs no socket. Not an error, and not worth retrying.
        setStatus('off');
        return;
      }

      const url = `${minted.socketUrl}${minted.socketUrl.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(minted.ticket)}`;
      socket = factory(url);
      if (socket === null) {
        setStatus('off');
        return;
      }

      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'subscribe', conversationId }));
      };
      socket.onmessage = (event) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (frame['type'] === 'subscribed' && frame['conversationId'] === conversationId) {
          attempts = 0;
          setStatus('live');
          // Cover the window between the page's load and this subscription.
          onCatchUp.current();
          return;
        }
        if (frame['type'] === 'event' && frame['conversationId'] === conversationId) {
          // Ids only in the frame; the transcript is refetched, never patched from it.
          onCatchUp.current();
          return;
        }
        if (frame['type'] === 'revoked' && frame['conversationId'] === conversationId) {
          // Authority for this channel was withdrawn. Terminal: stop reconnecting (a fresh
          // subscribe would only be refused), cancel any pending retry, close the socket, and
          // hand off to the screen's signed-out path. `disposed` doubles as the retry guard,
          // so the close below cannot schedule a reconnect.
          disposed = true;
          if (timer !== undefined) clearTimeout(timer);
          socket?.close();
          socket = null;
          setStatus('revoked');
          onRevoked.current?.();
          return;
        }
        // `refused` and anything unknown: leave the socket be — the server said its piece,
        // and the screen's reload behaviour still stands underneath.
      };
      socket.onclose = () => {
        socket = null;
        scheduleRetry();
      };
    };

    const scheduleRetry = (): void => {
      if (disposed) return;
      attempts += 1;
      setStatus('retrying');
      // Exponential with full jitter — §6's "exponential backoff with jitter".
      const ceiling = Math.min(RECONNECT_CAP_MS, baseMs * 2 ** Math.min(attempts - 1, 10));
      const delay = Math.floor(Math.random() * ceiling);
      timer = setTimeout(() => void connect(), delay);
    };

    void connect();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      socket?.close();
    };
  }, [api, organizationSlug, conversationId, enabled, factory, baseMs]);

  return status;
}
