/**
 * The in-process fan-out — RT-001's smallest honest bus.
 *
 * Subscriptions and broadcasts live in the memory of the one process that runs both the
 * relay and the socket server, which is the worker, which is the process `50-BOOTSTRAP` §3
 * says may or may not be persistent. When it is, sockets are live; when the host only
 * runs controlled batches, `REALTIME_PORT=0` keeps this off and clients fall back to the
 * reload behaviour every screen already has. There is no cross-process bus because there
 * is nothing to carry one — no Redis on the target — and pretending one exists would be a
 * second delivery system with none of the outbox's guarantees.
 *
 * A broadcast is best-effort by design: `24-EVENT-CATALOG` §2, "realtime messages are safe
 * projections of durable events, not the durable bus itself." A missed frame costs a
 * refetch, never a fact.
 */

export interface RealtimeEventFrame {
  readonly type: 'event';
  readonly eventType: string;
  readonly conversationId: string;
  readonly objectId: string;
  /** The channel's own order. `null` when the producing event predates the field. */
  readonly sequence: number | null;
  /** Ids only — a safe projection. The reader fetches content through authorized reads. */
  readonly patch: Readonly<Record<string, string | number | null>>;
}

type Listener = (frame: RealtimeEventFrame) => void;

/**
 * R7 typing (F4): an ephemeral frame, never persisted. `until` is when the indicator lapses
 * on its own if no further frame arrives (epoch milliseconds).
 */
export interface RealtimeTypingFrame {
  readonly type: 'typing';
  readonly conversationId: string;
  readonly userId: string;
  readonly until: number;
}

type TypingListener = (frame: RealtimeTypingFrame) => void;

/** How long one typing frame keeps the indicator up. */
export const TYPING_TTL_MS = 5_000;
/** One inbound typing frame per socket per this window; the rest are dropped silently. */
export const TYPING_MIN_INTERVAL_MS = 2_000;

/**
 * Pure gate for an inbound typing frame: only for a conversation this socket already holds a
 * verified subscription to (so membership was checked), and at most one per
 * {@link TYPING_MIN_INTERVAL_MS}. `lastAt` is the socket's own last accepted time, if any.
 */
export function acceptTyping(
  subscribed: { has(conversationId: string): boolean },
  conversationId: string,
  lastAt: number | undefined,
  at: number,
): boolean {
  if (!subscribed.has(conversationId)) return false;
  return lastAt === undefined || at - lastAt >= TYPING_MIN_INTERVAL_MS;
}

function keyOf(organizationId: string, conversationId: string): string {
  return `${organizationId}:${conversationId}`;
}

export class RealtimeHub {
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #typing = new Map<string, Map<TypingListener, string>>();

  subscribe(organizationId: string, conversationId: string, listener: Listener): () => void {
    const key = keyOf(organizationId, conversationId);
    const set = this.#listeners.get(key) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(key);
    };
  }

  publish(organizationId: string, conversationId: string, frame: RealtimeEventFrame): number {
    const set = this.#listeners.get(keyOf(organizationId, conversationId));
    if (!set) return 0;
    for (const listener of set) {
      try {
        listener(frame);
      } catch {
        // One listener's throw must not cost the others their frame; the socket layer
        // owns its own error handling and a dead socket is unsubscribed on close.
      }
    }
    return set.size;
  }

  /** R7: hear typing frames in a conversation, as `userId` (whose own frames are skipped). */
  subscribeTyping(
    organizationId: string,
    conversationId: string,
    userId: string,
    listener: TypingListener,
  ): () => void {
    const key = keyOf(organizationId, conversationId);
    const room = this.#typing.get(key) ?? new Map<TypingListener, string>();
    room.set(listener, userId);
    this.#typing.set(key, room);
    return () => {
      room.delete(listener);
      if (room.size === 0) this.#typing.delete(key);
    };
  }

  /** Fan a typing frame out to the room, except the sender's own sockets. Returns the count. */
  publishTyping(organizationId: string, frame: RealtimeTypingFrame): number {
    const room = this.#typing.get(keyOf(organizationId, frame.conversationId));
    if (!room) return 0;
    let told = 0;
    for (const [listener, userId] of room) {
      if (userId === frame.userId) continue;
      told += 1;
      try {
        listener(frame);
      } catch {
        // As for events: one dead socket costs nobody else their frame.
      }
    }
    return told;
  }

  /** For tests and the server's shutdown report. */
  subscriberCount(organizationId: string, conversationId: string): number {
    return this.#listeners.get(keyOf(organizationId, conversationId))?.size ?? 0;
  }
}
