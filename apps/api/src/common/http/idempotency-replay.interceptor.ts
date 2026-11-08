import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { from, lastValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import { ApiError } from './errors.js';
import { requireTenantContext } from './request-state.js';

/**
 * 53-16 (offline mode). A minimal `Idempotency-Key` for the append-only writes the web app may
 * replay after a dropped connection: a work item comment and a time entry.
 *
 * Those two are the only queued writes the API cannot tell apart from a second, deliberate one.
 * A status change carries the item `version` (a replay of one that already landed is a 409) and
 * a checklist tick sets `done` to a value (repeating it changes nothing). A comment or a time
 * entry whose response was lost on the way back would be written twice on replay.
 *
 * ## What it does
 *
 * - No header: the request runs exactly as before. The key is optional, so nothing that already
 *   calls these routes changes.
 * - A header that is not 16 to 128 letters, digits, `_` or `-` (the upload-session rule): 400.
 * - A key seen before from the **same membership in the same organization** on the **same route**
 *   with the **same body**: the first successful response is answered again, and the handler does
 *   not run. A request still in flight under that key is awaited rather than run twice.
 * - The same key with a different body: 422, never a silent replay of something else.
 * - A failed first attempt is forgotten, so the caller may retry it with the same key.
 *
 * The scope is the tenant context the guards already built (organization + membership), so one
 * person's key can never answer another person's request, nor reach into another workspace.
 *
 * ## Why in memory
 *
 * The deployment is one Node process (web + api + worker in one Hostinger app). A process
 * restart forgets the keys, and a replay after that writes once more — the same outcome as
 * before this existed, never a worse one. Entries live 24 hours and the map is capped, oldest
 * first. No table, so no migration.
 */

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

interface Entry {
  readonly fingerprint: string;
  readonly storedAt: number;
  result: Promise<unknown> | undefined;
  value: unknown;
  done: boolean;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get size(): number {
    return this.entries.size;
  }

  /** Runs `perform` once per scope key; a repeat with the same fingerprint gets the same value. */
  async run<T>(scope: string, fingerprint: string, perform: () => Promise<T>): Promise<T> {
    this.sweep();
    const existing = this.entries.get(scope);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ApiError(
          422,
          'validation_failed',
          'This Idempotency-Key was already used for a different request',
          [{ field: 'Idempotency-Key', message: 'was used with a different body' }],
        );
      }
      if (existing.done) return existing.value as T;
      return (await existing.result) as T;
    }
    const entry: Entry = {
      fingerprint,
      storedAt: this.now(),
      result: undefined,
      value: undefined,
      done: false,
    };
    this.entries.set(scope, entry);
    entry.result = perform().then(
      (value) => {
        entry.value = value;
        entry.done = true;
        entry.result = undefined;
        return value;
      },
      (error: unknown) => {
        // A failure is not remembered: the caller may try again under the same key.
        this.entries.delete(scope);
        throw error;
      },
    );
    return (await entry.result) as T;
  }

  private sweep(): void {
    const floor = this.now() - TTL_MS;
    // Map iteration is insertion order (oldest first), so the first entry that is fresh while the
    // map is under its cap ends the sweep. A request still in flight is never dropped.
    for (const [key, entry] of this.entries) {
      const stale = entry.storedAt < floor;
      if (!stale && this.entries.size < MAX_ENTRIES) break;
      if (entry.done) this.entries.delete(key);
    }
  }
}

/** Optional DI token; never registered in production, so the shared store is used. */
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

/** One store for the process: the interceptor may be instantiated per route. */
const sharedStore = new IdempotencyStore();

interface RequestLike {
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly method?: string;
  readonly url?: string;
  readonly body?: unknown;
}

export function readIdempotencyKey(request: RequestLike): string | undefined {
  const raw = request.headers?.[IDEMPOTENCY_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  if (!KEY_PATTERN.test(value)) {
    throw new ApiError(400, 'validation_failed', 'The request is invalid', [
      { field: 'Idempotency-Key', message: 'must be 16 to 128 letters, digits, _ or -' },
    ]);
  }
  return value;
}

@Injectable()
export class IdempotencyReplayInterceptor implements NestInterceptor {
  private readonly store: IdempotencyStore;

  /** Nest builds it with no store (the process-wide one); a test hands in its own. */
  constructor(@Optional() @Inject(IDEMPOTENCY_STORE) store?: IdempotencyStore) {
    this.store = store ?? sharedStore;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const key = readIdempotencyKey(request);
    if (key === undefined) return next.handle();
    // The guards have run: the tenant context is the authenticated scope, never a header.
    const tenant = requireTenantContext(request as object);
    const path = (request.url ?? '').split('?')[0];
    const scope = [
      tenant.organizationId,
      tenant.membershipId,
      request.method ?? '',
      path,
      key,
    ].join('\u0000');
    const fingerprint = JSON.stringify(request.body ?? null);
    return from(this.store.run(scope, fingerprint, () => lastValueFrom(next.handle())));
  }
}
