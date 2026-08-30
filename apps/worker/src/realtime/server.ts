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
}

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

    const unsubscribers: (() => void)[] = [];

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
          if (!verdict.allowed) {
            socket.send(JSON.stringify({ type: 'refused', conversationId: frame.conversationId }));
            return;
          }
          unsubscribers.push(
            hub.subscribe(claims.organizationId, frame.conversationId, (event) => {
              socket.send(JSON.stringify(event));
            }),
          );
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
      for (const unsubscribe of unsubscribers) unsubscribe();
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
