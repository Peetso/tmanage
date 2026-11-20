import type { PublishedOutboxEvent, TailPosition } from '../common/database/realtime-tail-store.js';
import { readPublishedPage, readTailStart } from '../common/database/realtime-tail-store.js';
import type { WorkerDatabase } from '../common/database/worker-database.js';
import type { OutboxEffect, OutboxHandler } from '../outbox/dispatcher.js';
import { createDirectMessageFanOut, createMessageFanOut } from './fan-out.js';
import type { RealtimeHub } from './hub.js';
import { WORK_FRAME_EVENT_TYPES, createWorkFanOut } from './work-fan-out.js';

/**
 * DC-3 / RT-2 — the realtime tail: every copy of the app frames ITS OWN sockets.
 *
 * Hostinger often runs two copies of the one app (DC-3). The leader lease (RT-3) keeps the side
 * effects — claiming outbox rows, mail, notifications, sweeps — on one copy. A socket, though,
 * is held by whichever copy the proxy handed the upgrade to, and that copy's hub is the only one
 * that can write to it. So framing cannot be leader-only: each copy follows the outbox's
 * published rows itself and publishes them to its own hub.
 *
 * The pattern, and why:
 *
 * - **Polling publisher, read side** (Richardson, microservices.io, "Pattern: Polling
 *   publisher": publish by polling the outbox table). Each copy keeps a cursor of its own over
 *   `published_at`; reading a published row claims nothing, so N copies need no coordination
 *   and the leader's relay is unchanged. Chosen over a broker (none on shared hosting) and over
 *   GET_LOCK/notify tricks (MariaDB has no LISTEN/NOTIFY).
 * - **Late commits.** A timestamp cursor misses a row whose transaction commits after a later
 *   timestamp was already read; Confluent's JDBC source connector names the same hazard
 *   (`timestamp.delay.interval.ms`: a delay "to allow transactions with an earlier timestamp to
 *   complete"). Instead of delaying every frame, each poll makes two passes: a **forward** pass
 *   from its keyset head `(published_at, id)`, which always moves on (so a busy window cannot
 *   stall it), and a **lookback** pass over the window behind the head, which finds a late row
 *   while it is younger than the window. Ids are lowercase UUIDs (`CHAR(36)`), which sort the
 *   same in JS and in the column's collation, so the head comparison agrees with the SQL.
 * - **Idempotent consumer** (microservices.io, "Pattern: Idempotent Consumer": record the ids
 *   of processed messages and discard duplicates). The window is read again and again, so every
 *   event id framed is remembered until it falls out of the window; a remembered id is never
 *   framed twice, which is what keeps one socket from getting one event twice from this copy.
 *   The other copies frame only their own sockets, so no socket hears an event twice.
 *
 * Frames now go out only after the relay's batch COMMITTED (a published row is committed by
 * definition), where the relay used to publish them from inside its transaction — a rolled-back
 * batch can no longer show a frame for an event that is then redelivered.
 *
 * Bounded and best-effort, like the frames themselves (the durable truth is already committed,
 * and the client refetches on reconnect): a row that commits more than `lookbackMs` after its
 * `published_at` (or lies past `maxPages` pages of a very busy window) is not framed live; a
 * handler that throws is logged and that event is not retried. On start the tail begins at the
 * newest published row, so a new copy never replays history to its first sockets.
 */

/** How far behind its newest row the tail re-reads, for rows committed late. */
export const REALTIME_TAIL_LOOKBACK_MS = 15_000;
/** Rows per read; a window holding more is read in further pages, up to `maxPages`. */
export const REALTIME_TAIL_PAGE_SIZE = 200;
export const REALTIME_TAIL_MAX_PAGES = 5;

export interface RealtimeTailOptions {
  readonly database: Pick<WorkerDatabase, 'read'>;
  /** The framing handler for each event type the tail follows (see {@link createRealtimeFanOutHandlers}). */
  readonly handlers: Readonly<Record<string, OutboxHandler>>;
  readonly lookbackMs?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly onHandlerError?: (event: PublishedOutboxEvent, error: unknown) => void;
}

export interface RealtimeTailReport {
  readonly framed: number;
  /** Rows of the window this copy had already framed (the idempotent-consumer skip). */
  readonly duplicates: number;
  readonly failed: number;
  /** The poll stopped at `maxPages` with more rows left; the next poll goes on from there. */
  readonly truncated: boolean;
}

export interface RealtimeTail {
  /** Reads where the outbox ends now; nothing before that point is ever framed. */
  start(): Promise<void>;
  /** One poll. Concurrent calls do not overlap: a call while one runs returns an empty report. */
  tick(): Promise<RealtimeTailReport>;
  /** How many framed ids are remembered (bounded by the window). */
  remembered(): number;
}

const EMPTY: RealtimeTailReport = { framed: 0, duplicates: 0, failed: 0, truncated: false };

export function createRealtimeTail(options: RealtimeTailOptions): RealtimeTail {
  const lookbackMs = options.lookbackMs ?? REALTIME_TAIL_LOOKBACK_MS;
  const pageSize = options.pageSize ?? REALTIME_TAIL_PAGE_SIZE;
  const maxPages = options.maxPages ?? REALTIME_TAIL_MAX_PAGES;
  const types = Object.keys(options.handlers);
  /** Framed event id, and its publish time in ms (for pruning). */
  const seen = new Map<string, number>();
  let started = false;
  /** Nothing at or before this publish time is framed: it was history when this copy started. */
  let floorMs = 0;
  /**
   * The newest row read so far, as a keyset position. The forward pass always continues from
   * here, so a busy window (many rows already framed) can never stall the tail.
   */
  let head: TailPosition = { publishedAt: new Date(0), id: null };
  let running = false;

  const frame = async (event: PublishedOutboxEvent): Promise<boolean> => {
    const handler = options.handlers[event.type];
    if (handler === undefined) return true;
    const staged: OutboxEffect[] = [];
    try {
      await options.database.read((tx) =>
        handler(event, tx, { afterCommit: (effect) => staged.push(effect) }),
      );
      // A read has no commit: whatever a handler staged runs once its read returned.
      for (const effect of staged) await effect();
      return true;
    } catch (error) {
      options.onHandlerError?.(event, error);
      return false;
    }
  };

  const start = async (): Promise<void> => {
    const at = await options.database.read((tx) => readTailStart(tx));
    floorMs = at === null ? 0 : at.getTime();
    head = { publishedAt: new Date(floorMs), id: null };
    started = true;
  };

  const beyondHead = (event: PublishedOutboxEvent): boolean => {
    const ms = event.publishedAt.getTime();
    const headMs = head.publishedAt.getTime();
    return ms > headMs || (ms === headMs && (head.id === null || event.id > head.id));
  };

  return {
    start,
    remembered: () => seen.size,
    async tick() {
      if (running) return EMPTY;
      running = true;
      let framed = 0;
      let duplicates = 0;
      let failed = 0;
      const take = async (event: PublishedOutboxEvent): Promise<void> => {
        if (seen.has(event.id)) {
          duplicates += 1;
          return;
        }
        // Remembered before framing: a handler that fails is not retried by the next poll.
        seen.set(event.id, event.publishedAt.getTime());
        if (await frame(event)) framed += 1;
        else failed += 1;
      };
      /** Pages from `after` until `stop` says a row belongs to the other pass, or no rows remain. */
      const pass = async (
        from: TailPosition,
        stop: (event: PublishedOutboxEvent) => boolean,
        onRow: (event: PublishedOutboxEvent) => void,
      ): Promise<boolean> => {
        let after = from;
        for (let page = 0; page < maxPages; page += 1) {
          const rows = await options.database.read((tx) =>
            readPublishedPage(tx, after, types, pageSize),
          );
          for (const event of rows) {
            if (stop(event)) return false;
            onRow(event);
            await take(event);
          }
          const last = rows[rows.length - 1];
          if (rows.length < pageSize || last === undefined) return false;
          after = { publishedAt: last.publishedAt, id: last.id };
        }
        return true;
      };
      try {
        if (!started) await start();
        // 1. Lookback: rows at or before the head that committed late (the lookback window).
        const lowMs = Math.max(floorMs, head.publishedAt.getTime() - lookbackMs);
        await pass({ publishedAt: new Date(lowMs), id: null }, beyondHead, () => undefined);
        // 2. Forward: everything past the head, which moves with every row read.
        const truncated = await pass(
          head,
          () => false,
          (event) => {
            head = { publishedAt: event.publishedAt, id: event.id };
          },
        );
        // An id older than the next window can never be read again: forget it.
        const nextLowMs = Math.max(floorMs, head.publishedAt.getTime() - lookbackMs);
        for (const [id, publishedMs] of seen) {
          if (publishedMs <= nextLowMs) seen.delete(id);
        }
        return { framed, duplicates, failed, truncated };
      } finally {
        running = false;
      }
    },
  };
}

/**
 * The framing handlers the tail runs, one per event type: channel messages, direct messages and
 * the work events. Only frames — the side-effect consumers of the same types stay on the
 * leader's relay.
 */
export function createRealtimeFanOutHandlers(hub: RealtimeHub): Record<string, OutboxHandler> {
  const work = createWorkFanOut(hub);
  const handlers: Record<string, OutboxHandler> = {
    'message.created.v1': createMessageFanOut(hub),
    'direct_message.created.v1': createDirectMessageFanOut(hub),
  };
  for (const type of WORK_FRAME_EVENT_TYPES) handlers[type] = work;
  return handlers;
}
