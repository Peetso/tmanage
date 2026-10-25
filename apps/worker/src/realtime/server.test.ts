import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { signRealtimeTicket } from '@tmanage/domain/realtime-ticket';
import { createRealtimeServer } from './server.js';
import type { RealtimeServer } from './server.js';
import type { RealtimeEventFrame } from './hub.js';
import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';

/**
 * The socket server's authority lifecycle — the two defects the handshake ticket cannot fix
 * on its own, pinned without a database (RT-001 R04/R05).
 *
 * The subscription check is real: these tests drive the actual `checkConversationSubscription`
 * through a fake {@link WorkerDatabase} whose one query returns the rows a test controls, so
 * the same store logic the db suite exercises decides allow/refuse here. What is faked is only
 * the transport to MySQL, which a unit test has no business starting.
 *
 * - **R04.** A subscription is checked against current rows once, at subscribe. When authority
 *   is later withdrawn, the bounded revalidation interval must re-run that check and drop the
 *   subscription — otherwise a revoked member keeps receiving frames for the socket's whole
 *   life and the connection outlives its ticket TTL indefinitely.
 * - **R05.** If the socket closes while its subscribe check is still in flight, the eventual
 *   success must register nothing: a listener capturing a dead socket that no close ever
 *   removes is a permanent leak.
 */

const SESSION_SECRET = 'local_dev_only_session_secret_for_the_realtime_unit_suite_00';
const ORG = 'org-unit-1';
const USER = 'user-unit-1';
const CONV = 'conv-unit-1';

// The shape `checkConversationSubscription` reads: an active `owner` membership (a role that
// holds `conversation.read`) that is a member of the channel and can reach its project (an
// owner does through org-wide scope), and the channel's next sequence.
const ALLOWED_ROWS = [{ role: 'owner', next_sequence_no: 1, is_member: 1, may_reach_project: 1 }];
const REFUSED_ROWS: readonly unknown[] = [];

const eventFrame: RealtimeEventFrame = {
  type: 'event',
  eventType: 'message.created.v1',
  conversationId: CONV,
  objectId: 'msg-1',
  sequence: 2,
  patch: { parentMessageId: null },
};

function farFutureTicket(): string {
  const expiresAt = Date.now() + 60_000;
  return signRealtimeTicket({ organizationId: ORG, userId: USER, expiresAt }, SESSION_SECRET);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fake worker database whose single query resolves to whatever `rows()` yields. */
function makeDatabase(rows: () => unknown): WorkerDatabase {
  const tx: WorkerTransaction = {
    query: async <T>() => (await rows()) as T,
  };
  return {
    read: (work) => work(tx),
    transaction: (work) => work(tx),
    end: async () => {},
  };
}

interface Client {
  readonly socket: WebSocket;
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
}

function connect(port: number, ticket: string): Client {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?ticket=${ticket}`);
  const frames: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  return {
    socket,
    next: (timeoutMs = 5_000) =>
      new Promise((resolve, reject) => {
        const queued = frames.shift();
        if (queued) return resolve(queued);
        waiters.push(resolve);
        const timer = setTimeout(() => reject(new Error('no frame within timeout')), timeoutMs);
        timer.unref();
      }),
  };
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.once('close', () => resolve());
  });
}

let server: RealtimeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('the realtime server authority lifecycle', () => {
  it('R04: revalidation drops a subscription whose authority was revoked, and stops its frames', async () => {
    let rows: unknown = ALLOWED_ROWS;
    server = await createRealtimeServer({
      database: makeDatabase(() => rows),
      sessionSecret: SESSION_SECRET,
      port: 0,
      revalidateIntervalMs: 20,
    });

    const client = connect(server.port, farFutureTicket());
    await opened(client.socket);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId: CONV }));
    expect(await client.next()).toEqual({ type: 'subscribed', conversationId: CONV, cursor: 0 });
    expect(server.hub.subscriberCount(ORG, CONV)).toBe(1);

    // Authority is withdrawn: the very next current-rows check now refuses.
    rows = REFUSED_ROWS;

    // The bounded interval must notice and end the subscription.
    expect(await client.next()).toEqual({ type: 'revoked', conversationId: CONV });
    expect(server.hub.subscriberCount(ORG, CONV)).toBe(0);
    // A publish after revocation reaches nobody.
    expect(server.hub.publish(ORG, CONV, eventFrame)).toBe(0);

    client.socket.close();
    await closed(client.socket);
  });

  it('R04: with the period set to the ticket TTL, revocation still arrives as a frame before the expiry close', async () => {
    // The shipped shape: `revalidateIntervalMs` left at the ticket's own TTL. Unbounded, the
    // first tick would land at expiry, close 4401 and return before re-checking anything —
    // the browser would re-mint on a still-valid session, be answered `refused`, and park on
    // "Reconnecting…" for ever.
    const ticketTtlMs = 400;
    let rows: unknown = ALLOWED_ROWS;
    server = await createRealtimeServer({
      database: makeDatabase(() => rows),
      sessionSecret: SESSION_SECRET,
      port: 0,
      revalidateIntervalMs: ticketTtlMs,
    });

    const ticket = signRealtimeTicket(
      { organizationId: ORG, userId: USER, expiresAt: Date.now() + ticketTtlMs },
      SESSION_SECRET,
    );
    const client = connect(server.port, ticket);
    await opened(client.socket);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId: CONV }));
    expect(await client.next()).toEqual({ type: 'subscribed', conversationId: CONV, cursor: 0 });

    rows = REFUSED_ROWS;

    expect(await client.next(2_000)).toEqual({ type: 'revoked', conversationId: CONV });
    expect(server.hub.subscriberCount(ORG, CONV)).toBe(0);
  });

  it('R05: a socket closing mid-authorization registers no listener', async () => {
    const started = deferred<void>();
    const gate = deferred<unknown>();
    server = await createRealtimeServer({
      database: makeDatabase(() => {
        started.resolve();
        return gate.promise;
      }),
      sessionSecret: SESSION_SECRET,
      port: 0,
      // Large, so only the close-before-authorize path is under test here.
      revalidateIntervalMs: 60_000,
    });

    const client = connect(server.port, farFutureTicket());
    await opened(client.socket);
    client.socket.send(JSON.stringify({ type: 'subscribe', conversationId: CONV }));

    // Wait until the subscribe check is genuinely in flight, then close before it resolves.
    await started.promise;
    client.socket.close();
    await closed(client.socket);
    // Give the server's own close handler its turn to set the disposed flag.
    await delay(50);

    // The check now succeeds — but the socket is gone, so nothing may be registered.
    gate.resolve(ALLOWED_ROWS);
    await delay(20);

    expect(server.hub.subscriberCount(ORG, CONV)).toBe(0);
    expect(server.hub.publish(ORG, CONV, eventFrame)).toBe(0);
  });
});

describe('the attached mode (H2: the single Hostinger process)', () => {
  it('binds no port, takes upgrades from a caller-owned HTTP server, and delivers frames', async () => {
    const { createServer } = await import('node:http');
    server = await createRealtimeServer({
      database: makeDatabase(() => ALLOWED_ROWS),
      sessionSecret: SESSION_SECRET,
      port: 'attached',
    });
    expect(server.port).toBe(0);

    const attached = server;
    const http = createServer((_req, res) => res.end());
    http.on('upgrade', (request, socket, head) => attached.handleUpgrade(request, socket, head));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      const client = connect(port, farFutureTicket());
      await opened(client.socket);
      client.socket.send(JSON.stringify({ type: 'subscribe', conversationId: CONV }));
      expect(await client.next()).toMatchObject({ type: 'subscribed', conversationId: CONV });

      attached.hub.publish(ORG, CONV, eventFrame);
      expect(await client.next()).toMatchObject({ type: 'event', objectId: 'msg-1' });

      // The ticket still guards the handshake in this mode.
      const stranger = connect(port, 'not-a-ticket');
      await closed(stranger.socket);
      client.socket.close();
      await closed(client.socket);
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
