/**
 * 53-16 Offline mode — the queue of safe writes made while the connection was down.
 *
 * Only four writes are ever queued, because only these four are safe to send late: a comment, a
 * status change, a checklist tick and a time entry. Each entry records the workspace slug and the
 * work item it belongs to, the item `version` it was made against (status change), and an
 * `Idempotency-Key` minted when it was first attempted, so a replay whose response is lost on the
 * way back is never written twice.
 *
 * Entries keep their order (`seq`) and are replayed oldest first. An entry the server refuses
 * becomes a `conflict` and waits for the person: keep mine, take theirs, or copy my text.
 *
 * Storage is behind {@link OfflineStore} so the queue itself is plain logic: the browser uses
 * IndexedDB (`idb-store.ts`), tests and browsers without IndexedDB use {@link MemoryOfflineStore}.
 * The whole queue is dropped at the authentication boundary (`offline-runtime.ts`): another
 * person on this browser never sees, nor sends, what the previous one queued.
 */

export type OfflineWriteKind = 'comment' | 'transition' | 'checklist' | 'time-log';

export interface CommentPayload {
  readonly body: string;
}
export interface TransitionPayload {
  readonly to: string;
  readonly version: number;
  readonly facts: Readonly<Record<string, string>>;
}
export interface ChecklistPayload {
  readonly itemId: string;
  readonly done: boolean;
  readonly label: string;
}
export interface TimeLogPayload {
  readonly minutes: number;
  readonly spentOn: string;
  readonly note: string | null;
  /** 2026-11-23 time trust: why the time is typed in (absent in writes queued before it). */
  readonly reason?: string;
}

interface PayloadOf {
  comment: CommentPayload;
  transition: TransitionPayload;
  checklist: ChecklistPayload;
  'time-log': TimeLogPayload;
}

/** Why the server refused a replay, kept for the conflict card. Never contains a token. */
export interface OfflineConflict {
  readonly status: number;
  readonly code: string;
  /** What the item says now, when it could be read back (a status change's current state). */
  readonly theirs?: string;
}

interface WriteBase<K extends OfflineWriteKind> {
  readonly id: string;
  readonly seq: number;
  readonly kind: K;
  readonly workspaceSlug: string;
  readonly workItemId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly status: 'pending' | 'conflict';
  readonly conflict?: OfflineConflict;
  readonly payload: PayloadOf[K];
}

export type OfflineWrite = {
  [K in OfflineWriteKind]: WriteBase<K>;
}[OfflineWriteKind];

export type NewOfflineWrite = {
  [K in OfflineWriteKind]: {
    readonly kind: K;
    readonly workspaceSlug: string;
    readonly workItemId: string;
    readonly payload: PayloadOf[K];
    readonly idempotencyKey?: string;
  };
}[OfflineWriteKind];

export interface OfflineStore {
  all(): Promise<readonly OfflineWrite[]>;
  put(write: OfflineWrite): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryOfflineStore implements OfflineStore {
  private readonly rows = new Map<string, OfflineWrite>();
  async all(): Promise<readonly OfflineWrite[]> {
    return [...this.rows.values()];
  }
  async put(write: OfflineWrite): Promise<void> {
    this.rows.set(write.id, write);
  }
  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
}

/** 16–128 of `[A-Za-z0-9_-]`: the API's `Idempotency-Key` rule. */
export function newIdempotencyKey(random: () => string = randomHex): string {
  return `offline-${random()}`;
}

function randomHex(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type QueueListener = (writes: readonly OfflineWrite[]) => void;

export class OfflineQueue {
  private snapshot: readonly OfflineWrite[] = [];
  private readonly listeners = new Set<QueueListener>();
  private loaded: Promise<void> | undefined;

  constructor(
    private readonly store: OfflineStore,
    private readonly now: () => Date = () => new Date(),
    private readonly key: () => string = () => newIdempotencyKey(),
  ) {}

  /** Read the stored queue once; later calls reuse the first read. */
  load(): Promise<void> {
    this.loaded ??= this.store.all().then((rows) => {
      this.publish([...rows].sort((a, b) => a.seq - b.seq));
    });
    return this.loaded;
  }

  list(): readonly OfflineWrite[] {
    return this.snapshot;
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async enqueue(input: NewOfflineWrite): Promise<OfflineWrite> {
    await this.load();
    const last = this.snapshot[this.snapshot.length - 1];
    const write = {
      ...input,
      id: `${this.now().getTime()}-${this.snapshot.length}-${Math.random().toString(36).slice(2, 8)}`,
      seq: (last?.seq ?? 0) + 1,
      idempotencyKey: input.idempotencyKey ?? this.key(),
      createdAt: this.now().toISOString(),
      status: 'pending',
    } as OfflineWrite;
    await this.store.put(write);
    this.publish([...this.snapshot, write]);
    return write;
  }

  async update(write: OfflineWrite): Promise<void> {
    await this.store.put(write);
    this.publish(this.snapshot.map((row) => (row.id === write.id ? write : row)));
  }

  async remove(id: string): Promise<void> {
    await this.store.remove(id);
    this.publish(this.snapshot.filter((row) => row.id !== id));
  }

  /** The auth boundary: nothing queued by one person survives into the next session. */
  async clear(): Promise<void> {
    await this.store.clear();
    this.publish([]);
  }

  private publish(next: readonly OfflineWrite[]): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener(next);
  }
}

/** The text a person typed into a write, for "Copy my text" on a conflict card. */
export function textOf(write: OfflineWrite): string {
  switch (write.kind) {
    case 'comment':
      return write.payload.body;
    case 'time-log':
      return [`${write.payload.minutes} min`, write.payload.spentOn, write.payload.note ?? '']
        .filter((part) => part !== '')
        .join(' · ');
    case 'checklist':
      return write.payload.label;
    case 'transition':
      return write.payload.to;
  }
}
