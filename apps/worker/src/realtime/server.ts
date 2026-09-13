import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { verifyRealtimeTicket } from '@tmanage/domain/realtime-ticket';
import type { RealtimeTicketClaims } from '@tmanage/domain/realtime-ticket';
import type { WorkerDatabase } from '../common/database/worker-database.js';
import { checkConversationSubscription } from '../common/database/realtime-store.js';
import { RealtimeHub } from './hub.js';

/**
 * The socket server — RT-001's first half, `13-ENGINEERING` §6 made runnable.
 *
 * The handshake is the ticket: a signed claim the API minted over a session it proved,
 * verified here without a database and refused with close code 4401 and no further detail
 * — a handshake error is an oracle. Everything after the handshake is per-subscription:
 * a `subscribe` names one conversation, is checked against **current** rows (membership
 * active, ceiling holds, channel membership exists), and is answered with the channel's
 * current cursor so the client can tell a gap from a quiet room. A refusal is
 * `{type:'refused'}` with the id echoed and nothing about why, for the same reason the
 * handshake says nothing.
 *
 * Frames out are the hub's: ids and sequence, never content. Presence, typing, and every
 * resource family beyond conversations are the named second half.
 */

interface SubscribeFrame {
  readonly type: 'subscribe';
  readonly conversationId: string;
}

function parseFrame(raw: unknown): SubscribeFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record['type'] !== 'subscribe') return null;
  const conversationId = record['conversationId'];
  if (typeof conversationId !== 'string' || conversationId === '') return null;
  return { type: 'subscribe', conversationId };
}

export interface RealtimeServerOptions {
  readonly database: WorkerDatabase;
  /** The session secret the ticket key derives from — the API's own. */
  readonly sessionSecret: string;
  /** 0 asks the OS for an ephemeral port, which is how the suite runs one. */
  readonly port: number;
  /** Injected clock, so a suite can expire a ticket without waiting. */
  readonly now?: () => Date;
  /**
   * How often an open connection re-checks its subscriptions against current rows and its
   * ticket against the clock. The ticket authorizes only the handshake and a subscribe is
   * checked once — so without a recheck a revoked membership keeps delivering and a socket
   * outlives its ticket TTL indefinitely (R04). The natural period is the ticket TTL;
   * a suite injects a small value to observe a revocation without waiting.
   */
  readonly revalidateIntervalMs?: number;
}

/** The ticket's intended TTL is seconds, so a minute is a bounded, low-cost recheck period. */
const DEFAULT_REVALIDATE_INTERVAL_MS = 60_000;

export interface RealtimeServer {
  readonly hub: RealtimeHub;
  readonly port: number;
  close(): Promise<void>;
}

export async function createRealtimeServer(
  options: RealtimeServerOptions,
): Promise<RealtimeServer> {
  const hub = new RealtimeHub();
  const now = options.now ?? (() => new Date());
  const revalidateIntervalMs = options.revalidateIntervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS;
  const wss = new WebSocketServer({ port: options.port });

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  wss.on('connection', (socket: WebSocket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const claims: RealtimeTicketClaims | null = verifyRealtimeTicket(
      url.searchParams.get('ticket') ?? '',
      options.sessionSecret,
      now(),
    );
    if (claims === null) {
      socket.close(4401);
      return;
    }

    // Active subscriptions keyed by conversation, so a second subscribe to the same channel
    // is an idempotent ack rather than a second listener (R05's dedup half). The value is
    // the hub's own unsubscribe.
    const subscriptions = new Map<string, () => void>();
    // Set the instant the socket closes. Two async paths outlive a close — a subscription
    // check still resolving (R05) and a revalidation tick already in flight — and both
    // consult this before touching the hub, so a closed socket never gains or keeps a
    // listener.
    let disposed = false;

    const dropSubscription = (conversationId: string): void => {
      const unsubscribe = subscriptions.get(conversationId);
      if (unsubscribe === undefined) return;
      unsubscribe();
      subscriptions.delete(conversationId);
    };

    // The handshake ticket is verified once and a subscribe checks current rows once — so
    // without this, a membership suspended (or a role capability withdrawn, or a channel
    // membership removed) after the subscribe keeps delivering for the socket's whole life,
    // and the connection outlives its ticket TTL forever (R04 / F1). On a bounded interval
    // we re-run the same current-rows check for every open subscription and drop the ones
    // that no longer verify, and we close the whole socket once its ticket has expired —
    // the recheck the stateless handshake ticket cannot perform for itself.
    const revalidate = (): void => {
      if (disposed) return;
      if (now().getTime() >= claims.expiresAt) {
        socket.close(4401);
        return;
      }
      for (const conversationId of [...subscriptions.keys()]) {
        void options.database
          .read((tx) =>
            checkConversationSubscription(tx, {
              organizationId: claims.organizationId,
              userId: claims.userId,
              conversationId,
            }),
          )
          .then((verdict) => {
            if (disposed || !subscriptions.has(conversationId)) return;
            if (!verdict.allowed) {
              dropSubscription(conversationId);
              socket.send(JSON.stringify({ type: 'revoked', conversationId }));
            }
          })
          .catch(() => {
            // A database hiccup leaves the subscription in place and the next tick retries;
            // dropping a live subscriber on a transient read error would be its own defect.
          });
      }
    };

    const timer = setInterval(revalidate, revalidateIntervalMs);
    // The revalidation loop must never be the reason the process stays alive.
    timer.unref();

    socket.on('message', (raw) => {
      const frame = parseFrame(raw);
      if (frame === null) {
        socket.send(JSON.stringify({ type: 'error' }));
        return;
      }

      void options.database
        .read((tx) =>
          checkConversationSubscription(tx, {
            organizationId: claims.organizationId,
            userId: claims.userId,
            conversationId: frame.conversationId,
          }),
        )
        .then((verdict) => {
          // The socket may have closed while this check was in flight: registering now would
          // install a hub listener capturing a dead socket that nothing ever removes (R05).
          // Refuse late completions.
          if (disposed) return;
          if (!verdict.allowed) {
            socket.send(JSON.stringify({ type: 'refused', conversationId: frame.conversationId }));
            return;
          }
          if (!subscriptions.has(frame.conversationId)) {
            subscriptions.set(
              frame.conversationId,
              hub.subscribe(claims.organizationId, frame.conversationId, (event) => {
                socket.send(JSON.stringify(event));
              }),
            );
          }
          socket.send(
            JSON.stringify({
              type: 'subscribed',
              conversationId: frame.conversationId,
              cursor: verdict.cursor,
            }),
          );
        })
        .catch(() => {
          // A database hiccup answers as a refusal, not a crash: the client retries with
          // backoff (§6), and nothing about the failure is worth telling a socket.
          socket.send(JSON.stringify({ type: 'refused', conversationId: frame.conversationId }));
        });
    });

    socket.on('close', () => {
      disposed = true;
      clearInterval(timer);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    });
  });

  const address = wss.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    hub,
    port,
    async close(): Promise<void> {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
