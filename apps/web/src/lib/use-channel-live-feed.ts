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

export type LiveFeedStatus = 'off' | 'connecting' | 'live' | 'retrying';

export interface ChannelLiveFeedOptions {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly conversationId: string;
  readonly enabled: boolean;
  /** Called on every frame and once on subscribe. Refetch; never apply frame content. */
  readonly onCatchUp: () => void;
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
