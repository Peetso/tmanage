import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { verifyRealtimeTicket } from '@tmanage/domain/realtime-ticket';
import type { RealtimeTicketClaims } from '@tmanage/domain/realtime-ticket';
import type { WorkerDatabase } from '../common/database/worker-database.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import { checkConversationSubscription } from '../common/database/realtime-store.js';
import type { SubscriptionVerdict } from '../common/database/realtime-store.js';
import { checkDirectConversationSubscription } from '../common/database/direct-message-store.js';
import { acceptTyping, RealtimeHub, TYPING_TTL_MS } from './hub.js';

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
 * Frames out are the hub's: ids and sequence, never content. R7 adds one inbound frame,
 * `{type:'typing', conversationId}`, fanned out (never stored) to the conversation's other
 * subscribers as `{type:'typing', conversationId, userId, until}`. Presence is a database
 * heartbeat in the API, not socket state.
 */

/**
 * BK3-left: a subscribe names a channel or a direct conversation (ids never collide — both are
 * uuidv7). The channel check runs first; only when it refuses is the id tried as a direct
 * conversation, under the same relation rule the API applies (`direct-message-store.ts`).
 */
async function checkSubscription(
  tx: WorkerTransaction,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly conversationId: string;
  },
): Promise<SubscriptionVerdict> {
  const channel = await checkConversationSubscription(tx, input);
  if (channel.allowed) return channel;
  return checkDirectConversationSubscription(tx, input);
}

interface SubscribeFrame {
  readonly type: 'subscribe';
  readonly conversationId: string;
}

/** R7 (F4): "I am typing here". Accepted only on a subscribed conversation, rate-limited. */
interface TypingFrame {
  readonly type: 'typing';
  readonly conversationId: string;
}

function parseFrame(raw: unknown): SubscribeFrame | TypingFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const type = record['type'];
  if (type !== 'subscribe' && type !== 'typing') return null;
  const conversationId = record['conversationId'];
  if (typeof conversationId !== 'string' || conversationId === '') return null;
  return { type, conversationId };
}

export interface RealtimeServerOptions {
  readonly database: WorkerDatabase;
  /** The session secret the ticket key derives from — the API's own. */
  readonly sessionSecret: string;
  /**
   * 0 asks the OS for an ephemeral port, which is how the suite runs one. `'attached'` binds no
   * port at all: the caller hands upgrades in through {@link RealtimeServer.handleUpgrade} — the
   * single Hostinger process, whose one public port already belongs to its HTTP server (H2).
   */
  readonly port: number | 'attached';
  /** Injected clock, so a suite can expire a ticket without waiting. */
  readonly now?: () => Date;
  /**
   * How often an open connection re-checks its subscriptions against current rows and its
   * ticket against the clock. The ticket authorizes only the handshake and a subscribe is
   * checked once — so without a recheck a revoked membership keeps delivering and a socket
   * outlives its ticket TTL indefinitely (R04). This is an upper bound: the effective period
   * is also capped at half of the ticket's remaining life, so the re-check always runs before
   * the expiry close. A suite injects a small value to observe a revocation without waiting.
   */
  readonly revalidateIntervalMs?: number;
  /**
   * 51-06. Sockets this process holds at once; the next is closed 4429 with
   * `retry-after=30`. Defaults to `REALTIME_MAX_SOCKETS` (500, the shared-hosting figure).
   */
  readonly maxSockets?: number;
  /**
   * 51-06. Sockets one member (`organizationId:userId`) holds at once; the next is closed 4429
   * with `retry-after=5`. Defaults to `REALTIME_MAX_SOCKETS_PER_MEMBER` (5).
   */
  readonly maxSocketsPerMember?: number;
  /**
   * 51-06. The server's ping period; a socket that misses two pongs is terminated. Defaults to
   * `REALTIME_PING_INTERVAL_MS` (25 s) — under LiteSpeed's idle timeout, which is what keeps a
   * quiet channel's socket alive through the Hostinger proxy.
   */
  readonly pingIntervalMs?: number;
}

/** 51-06's knobs, as the environment names them. */
export interface RealtimeLimits {
  readonly maxSockets: number;
  readonly maxSocketsPerMember: number;
  readonly pingIntervalMs: number;
}

export const DEFAULT_REALTIME_LIMITS: RealtimeLimits = {
  maxSockets: 500,
  maxSocketsPerMember: 5,
  pingIntervalMs: 25_000,
};

/** Close code for a capped socket — the 4xxx mirror of HTTP 429. */
export const CLOSE_CAPPED = 4429;
/** The hint a capped client waits before retrying, in seconds: process cap, member cap. */
export const RETRY_AFTER_PROCESS_CAP_SECONDS = 30;
export const RETRY_AFTER_MEMBER_CAP_SECONDS = 5;

function positiveIntFrom(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Read the caps and the ping period from an environment. A missing or malformed value takes the
 * default rather than failing boot: these are tuning knobs, and the defaults are safe.
 */
export function realtimeLimitsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): RealtimeLimits {
  return {
    maxSockets: positiveIntFrom(env['REALTIME_MAX_SOCKETS'], DEFAULT_REALTIME_LIMITS.maxSockets),
    maxSocketsPerMember: positiveIntFrom(
      env['REALTIME_MAX_SOCKETS_PER_MEMBER'],
      DEFAULT_REALTIME_LIMITS.maxSocketsPerMember,
    ),
    pingIntervalMs: positiveIntFrom(
      env['REALTIME_PING_INTERVAL_MS'],
      DEFAULT_REALTIME_LIMITS.pingIntervalMs,
    ),
  };
}

/** What a keepalive needs of a socket: ws's own `ping` and `terminate`. */
export interface KeepaliveSocket {
  ping(): void;
  terminate(): void;
}

export interface Keepalive {
  track(socket: KeepaliveSocket): void;
  /** A pong arrived: the socket is alive, its missed count resets. */
  pong(socket: KeepaliveSocket): void;
  untrack(socket: KeepaliveSocket): void;
  stop(): void;
}

/** Pongs a socket may miss before it is terminated. */
const MAX_MISSED_PONGS = 2;

/**
 * One server-wide ping loop (51-06). Every tick pings each tracked socket and counts the ping as
 * outstanding until its pong; a socket with two outstanding pings at a tick is terminated — a dead
 * peer behind a proxy that never sent a FIN. `onTick` rides the same timer (the used-ticket sweep).
 */
export function createKeepalive(intervalMs: number, onTick?: () => void): Keepalive {
  const missed = new Map<KeepaliveSocket, number>();
  const timer = setInterval(() => {
    for (const [socket, count] of [...missed]) {
      if (count >= MAX_MISSED_PONGS) {
        missed.delete(socket);
        socket.terminate();
        continue;
      }
      missed.set(socket, count + 1);
      try {
        socket.ping();
      } catch {
        // A socket mid-close throws on ping; its close handler untracks it.
      }
    }
    onTick?.();
  }, intervalMs);
  // The keepalive must never be the reason the process stays alive.
  timer.unref?.();
  return {
    track: (socket) => void missed.set(socket, 0),
    pong: (socket) => {
      if (missed.has(socket)) missed.set(socket, 0);
    },
    untrack: (socket) => void missed.delete(socket),
    stop: () => clearInterval(timer),
  };
}

/** Live socket counts — for tests only; no HTTP route serves this. */
export interface RealtimeServerStats {
  readonly sockets: number;
  readonly perMember: Readonly<Record<string, number>>;
}

/** The ticket's intended TTL is seconds, so a minute is a bounded, low-cost recheck period. */
const DEFAULT_REVALIDATE_INTERVAL_MS = 60_000;

export interface RealtimeServer {
  readonly hub: RealtimeHub;
  /** The bound port; 0 when the server is `'attached'` and binds none of its own. */
  readonly port: number;
  /** Complete one HTTP upgrade on a caller-owned server (the `'attached'` mode). */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** 51-06. Open-socket counts, for tests only. */
  stats(): RealtimeServerStats;
  close(): Promise<void>;
}

export async function createRealtimeServer(
  options: RealtimeServerOptions,
): Promise<RealtimeServer> {
  const hub = new RealtimeHub();
  const now = options.now ?? (() => new Date());
  const revalidateIntervalMs = options.revalidateIntervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS;
  const attached = options.port === 'attached';
  const envLimits = realtimeLimitsFromEnv(process.env);
  const maxSockets = options.maxSockets ?? envLimits.maxSockets;
  const maxSocketsPerMember = options.maxSocketsPerMember ?? envLimits.maxSocketsPerMember;
  const pingIntervalMs = options.pingIntervalMs ?? envLimits.pingIntervalMs;

  // 51-06. Admitted sockets, process-wide and per member (`organizationId:userId`).
  let socketCount = 0;
  const perMember = new Map<string, number>();
  // Single-use tickets: the signature of every ticket that has opened a socket, until the ticket
  // would have expired anyway. Expired entries are swept on each keepalive tick, so the map is
  // bounded by the tickets minted in one TTL.
  const usedTickets = new Map<string, number>();
  const keepalive = createKeepalive(pingIntervalMs, () => {
    const at = now().getTime();
    for (const [signature, expiresAt] of usedTickets) {
      if (expiresAt <= at) usedTickets.delete(signature);
    }
  });
  const wss = attached
    ? new WebSocketServer({ noServer: true })
    : new WebSocketServer({ port: options.port as number });

  if (!attached) {
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
  }

  wss.on('connection', (socket: WebSocket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const ticket = url.searchParams.get('ticket') ?? '';
    const claims: RealtimeTicketClaims | null = verifyRealtimeTicket(
      ticket,
      options.sessionSecret,
      now(),
    );
    if (claims === null) {
      socket.close(4401);
      return;
    }
    // A ticket opens one socket, once. A replay — a ticket lifted from a log or a referrer and
    // presented again inside its TTL — gets the same silent 4401 a forgery does.
    const signature = ticket.slice(ticket.indexOf('.') + 1);
    if (usedTickets.has(signature)) {
      socket.close(4401);
      return;
    }
    usedTickets.set(signature, claims.expiresAt);

    // The caps (51-06). The socket was accepted at the upgrade so this close code reaches the
    // client; the reason carries how long to wait, which the browser hook honours.
    if (socketCount >= maxSockets) {
      socket.close(CLOSE_CAPPED, `retry-after=${RETRY_AFTER_PROCESS_CAP_SECONDS}`);
      return;
    }
    const memberKey = `${claims.organizationId}:${claims.userId}`;
    const memberCount = perMember.get(memberKey) ?? 0;
    if (memberCount >= maxSocketsPerMember) {
      socket.close(CLOSE_CAPPED, `retry-after=${RETRY_AFTER_MEMBER_CAP_SECONDS}`);
      return;
    }
    socketCount += 1;
    perMember.set(memberKey, memberCount + 1);
    keepalive.track(socket);
    socket.on('pong', () => keepalive.pong(socket));

    // Active subscriptions keyed by conversation, so a second subscribe to the same channel
    // is an idempotent ack rather than a second listener (R05's dedup half). The value is
    // the hub's own unsubscribe.
    const subscriptions = new Map<string, () => void>();
    // R7 typing: the last accepted inbound typing frame on this socket (rate limit).
    let lastTypingAt: number | undefined;
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
            checkSubscription(tx, {
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

    // A tick does two things and the expiry check returns first, so a period as long as the
    // ticket's remaining life spends its first tick closing 4401 and never re-checks a single
    // subscription. The shipped defaults are exactly that shape — a 60 s ticket TTL
    // (`REALTIME_TICKET_TTL_SECONDS`) and a 60 s period — so in a default deployment a
    // withdrawn authority surfaced as a close, the browser re-minted on its still-valid
    // session, was answered `refused`, and the channel never came back: the `revoked` frame
    // this loop exists to send was unreachable. So the period is also bounded by half of
    // what is left of the ticket: whatever TTL a deployment configures, at least one
    // subscription re-check lands while the connection is still authorized.
    const remainingTicketMs = claims.expiresAt - now().getTime();
    const period = Math.max(1, Math.min(revalidateIntervalMs, Math.floor(remainingTicketMs / 2)));
    const timer = setInterval(revalidate, period);
    // The revalidation loop must never be the reason the process stays alive.
    timer.unref();

    socket.on('message', (raw) => {
      const frame = parseFrame(raw);
      if (frame === null) {
        socket.send(JSON.stringify({ type: 'error' }));
        return;
      }
      if (frame.type === 'typing') {
        // Never persisted, never answered: a refused or throttled frame is simply dropped.
        const at = now().getTime();
        if (!acceptTyping(subscriptions, frame.conversationId, lastTypingAt, at)) return;
        lastTypingAt = at;
        hub.publishTyping(claims.organizationId, {
          type: 'typing',
          conversationId: frame.conversationId,
          userId: claims.userId,
          until: at + TYPING_TTL_MS,
        });
        return;
      }

      void options.database
        .read((tx) =>
          checkSubscription(tx, {
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
            const offEvents = hub.subscribe(
              claims.organizationId,
              frame.conversationId,
              (event) => {
                socket.send(JSON.stringify(event));
              },
            );
            const offTyping = hub.subscribeTyping(
              claims.organizationId,
              frame.conversationId,
              claims.userId,
              (typing) => {
                socket.send(JSON.stringify(typing));
              },
            );
            subscriptions.set(frame.conversationId, () => {
              offEvents();
              offTyping();
            });
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
      keepalive.untrack(socket);
      socketCount -= 1;
      const remaining = (perMember.get(memberKey) ?? 1) - 1;
      if (remaining > 0) perMember.set(memberKey, remaining);
      else perMember.delete(memberKey);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    });
  });

  const address = attached ? null : wss.address();
  const port =
    typeof address === 'object' && address !== null
      ? address.port
      : attached
        ? 0
        : (options.port as number);

  return {
    hub,
    port,
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit('connection', client, request);
      });
    },
    stats(): RealtimeServerStats {
      return { sockets: socketCount, perMember: Object.fromEntries(perMember) };
    },
    async close(): Promise<void> {
      keepalive.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
