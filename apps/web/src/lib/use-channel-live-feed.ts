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
 * once. It is a statement about *this channel only*: the session, its cookies and every other
 * channel are untouched, so the screen shows a channel-scoped "you no longer have access"
 * state and the person stays signed in.
 *
 * A `refused` answer to a re-subscribe is the same verdict wearing different clothes, and in a
 * default deployment it is the shape revocation actually arrives in: the worker closes 4401
 * when the ticket's TTL lapses, this hook re-mints (the session is still perfectly valid) and
 * re-subscribes, and the server's current-rows check answers `{type:'refused'}`. Retrying that
 * forever is a channel parked on "Reconnecting…" that will never reconnect, so a `refused` for
 * a channel this connection had already subscribed to is terminal in exactly the same way. A
 * `refused` on a subscribe that never succeeded is left alone: the worker also answers
 * `refused` when a database read merely hiccups, and the screen's ordinary authorized read
 * path already governs what such a person sees.
 *
 * A plain socket close is *not* revocation: it is the ordinary end of a ticket's life and
 * still reconnects with a fresh mint. A fully ended session is handled one layer down —
 * `mintRealtimeTicket` goes through `ApiClient`, whose refresh-refused path announces
 * `session-ended` and navigates this screen away, unmounting the hook.
 *
 * ## A capped socket (51-06)
 *
 * The worker caps sockets per process and per member and closes the one past either cap with
 * code 4429 and a reason of `retry-after=<seconds>`. That is load, not a verdict: the hook waits
 * the hinted seconds (falling back to its ordinary backoff when the reason carries no hint) and
 * then mints and connects again. It is never terminal — only `revoked` is.
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
  /** The browser's `CloseEvent` carries `code` and `reason`; a fake may pass nothing. */
  onclose: ((event?: LiveCloseEvent) => void) | null;
}

export interface LiveCloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

/** The worker's close code for a socket past its process or member cap (51-06). */
export const CLOSE_CAPPED = 4429;

/** The `retry-after=<seconds>` hint of a capped close, in milliseconds; `null` when absent. */
export function retryAfterMs(reason: string | undefined): number | null {
  const match = /(?:^|[;\s])retry-after=(\d{1,5})(?:$|[;\s])/.exec(reason ?? '');
  if (match === null) return null;
  return Number(match[1]) * 1_000;
}

export type LiveSocketFactory = (url: string) => LiveSocket | null;

export type LiveFeedStatus = 'off' | 'connecting' | 'live' | 'retrying' | 'revoked';

export interface ChannelLiveFeedOptions {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /**
   * The channel — or, since BK3-left, a **direct conversation** — to follow. The worker's
   * subscribe takes either id (both are uuidv7, so they never collide): it tries the channel
   * check first and falls back to the direct-message relation rule, and it publishes
   * `direct_message.created.v1` on the DM's id. `DirectMessageScreen` passes its DM id here.
   */
  readonly conversationId: string;
  readonly enabled: boolean;
  /** Called on every frame and once on subscribe. Refetch; never apply frame content. */
  readonly onCatchUp: () => void;
  /**
   * Called once when this channel's authority is gone — a `revoked` frame, or a `refused`
   * answer to a re-subscribe. The hook has already stopped reconnecting and moved to the
   * terminal `'revoked'` status, which is what the screen renders; this is the optional
   * side-effect seam for a screen that also wants to drop channel-scoped state. It is *not*
   * a session end: nothing here may sign the person out.
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

/** The same feed, named for a direct conversation: `directConversationId` is its id. */
export function useDirectConversationLiveFeed(
  options: Omit<ChannelLiveFeedOptions, 'conversationId'> & {
    readonly directConversationId: string;
  },
): LiveFeedStatus {
  const { directConversationId, ...rest } = options;
  return useChannelLiveFeed({ ...rest, conversationId: directConversationId });
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
    // Whether the server has ever verified this channel for this connection. It is what
    // separates a refusal that means "your access is gone" from one that may only mean the
    // worker's database read hiccupped on a channel we never held.
    let subscribedOnce = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The terminal end of this channel's feed. Stop retrying (a fresh subscribe would only be
    // refused again), cancel any pending retry, close the socket, and settle on the
    // channel-scoped `'revoked'` status the screen renders. `disposed` doubles as
    // `scheduleRetry`'s guard, so the close below cannot schedule a reconnect, and as the
    // `onmessage` guard, so `onRevoked` runs once however many frames follow.
    const revoke = (): void => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      socket?.close();
      socket = null;
      setStatus('revoked');
      onRevoked.current?.();
    };

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
        if (disposed) return;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (frame['type'] === 'subscribed' && frame['conversationId'] === conversationId) {
          attempts = 0;
          subscribedOnce = true;
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
          // Authority for this channel was withdrawn while it was subscribed.
          revoke();
          return;
        }
        if (
          frame['type'] === 'refused' &&
          frame['conversationId'] === conversationId &&
          subscribedOnce
        ) {
          // A channel this connection held, refused on a re-subscribe: the same verdict as
          // `revoked`, and the one that actually arrives when the ticket TTL closes the
          // socket 4401 first. Retrying it is a permanent "Reconnecting…".
          revoke();
          return;
        }
        // A first-subscribe `refused` and anything unknown: leave the socket be — the server
        // said its piece, and the screen's reload behaviour still stands underneath.
      };
      socket.onclose = (event) => {
        socket = null;
        // A capped socket says how long to wait; honour it rather than hammering a full server.
        const hinted = event?.code === CLOSE_CAPPED ? retryAfterMs(event.reason) : null;
        scheduleRetry(hinted);
      };
    };

    const scheduleRetry = (hintedMs: number | null = null): void => {
      if (disposed) return;
      attempts += 1;
      setStatus('retrying');
      // Exponential with full jitter — §6's "exponential backoff with jitter" — unless the
      // server named the wait itself (a 4429's `retry-after=`).
      const ceiling = Math.min(RECONNECT_CAP_MS, baseMs * 2 ** Math.min(attempts - 1, 10));
      const delay = hintedMs ?? Math.floor(Math.random() * ceiling);
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
