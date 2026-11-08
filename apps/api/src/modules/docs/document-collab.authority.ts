/**
 * Slice 53-10 — the central authority for live document co-editing (Figma 586:33239).
 *
 * Step-based collaboration, the prosemirror-collab model: the authority keeps one ordered log of
 * ProseMirror steps per document. A client may append steps only on top of the newest version it
 * has seen; anyone behind is refused and must first take the steps it missed, rebase its own
 * unconfirmed steps over them and try again. Steps are opaque JSON here — the API has no editor
 * schema — so the authority orders and stores them; the clients apply them.
 *
 * Persistence: a writer sends a snapshot (the document as HTML at a confirmed version) every few
 * seconds; the service saves it as a normal document version and the authority keeps it as the
 * session's base. A joiner gets the base plus the steps after it; the log keeps
 * {@link KEEP_BEFORE_SNAPSHOT} older steps so an editor a few polls behind still catches up.
 *
 * In-memory per process, keyed `organizationId:documentId` (the same shape as presence): enough
 * for the single Hostinger Node app. Idle sessions are dropped after {@link SESSION_IDLE_MS}; the
 * next joiner starts from the stored body.
 */

export const MAX_STEPS_PER_PUSH = 200;
export const MAX_PUSH_BYTES = 256 * 1024;
export const MAX_LOG_STEPS = 10_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const CURSOR_TTL_MS = 30_000;
/** Steps kept from before a snapshot, so an editor a few polls behind can still catch up. */
export const KEEP_BEFORE_SNAPSHOT = 500;
/** Member colours, by index: the client draws `--c0` … `--c5`. */
export const COLLAB_COLOURS = 6;

export interface CollabStep {
  readonly step: unknown;
  readonly clientId: string;
}

export interface CollabCursor {
  readonly userId: string;
  readonly clientId: string;
  readonly name: string;
  readonly colour: number;
  readonly anchor: number;
  readonly head: number;
}

export interface CollabJoin {
  readonly version: number;
  /** The newest snapshot this session holds; `html: null` = start from the stored body. */
  readonly baseVersion: number;
  readonly baseHtml: string | null;
  readonly steps: readonly CollabStep[];
  readonly colour: number;
}

export type CollabSince =
  | { readonly kind: 'steps'; readonly version: number; readonly steps: readonly CollabStep[] }
  | { readonly kind: 'resync'; readonly version: number };

export type CollabPush =
  | { readonly accepted: true; readonly version: number }
  | { readonly accepted: false; readonly version: number };

interface Session {
  /** The version before `steps[0]`. */
  logStart: number;
  baseVersion: number;
  baseHtml: string | null;
  steps: CollabStep[];
  colours: Map<string, number>;
  cursors: Map<string, CollabCursor & { readonly at: number }>;
  touchedAt: number;
}

export class CollabRefusal extends Error {
  constructor(readonly reason: 'too_many_steps' | 'too_large' | 'invalid_step' | 'log_full') {
    super(reason);
  }
}

export class DocumentCollabAuthority {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  join(key: string, userId: string): CollabJoin {
    const session = this.session(key);
    return {
      version: session.logStart + session.steps.length,
      baseVersion: session.baseVersion,
      baseHtml: session.baseHtml,
      steps: session.steps.slice(session.baseVersion - session.logStart),
      colour: this.colourOf(session, userId),
    };
  }

  /** The steps after `since`, or `resync` when `since` is older than the base or in the future. */
  since(key: string, since: number): CollabSince {
    const session = this.session(key);
    const version = session.logStart + session.steps.length;
    if (!Number.isSafeInteger(since) || since < session.logStart || since > version) {
      return { kind: 'resync', version };
    }
    return { kind: 'steps', version, steps: session.steps.slice(since - session.logStart) };
  }

  /** Append `steps` if `version` is the newest; refuse (with the newest number) otherwise. */
  push(key: string, version: number, clientId: string, steps: readonly unknown[]): CollabPush {
    if (steps.length === 0 || steps.length > MAX_STEPS_PER_PUSH) {
      throw new CollabRefusal('too_many_steps');
    }
    if (!steps.every(isStepJson)) throw new CollabRefusal('invalid_step');
    if (JSON.stringify(steps).length > MAX_PUSH_BYTES) throw new CollabRefusal('too_large');
    const session = this.session(key);
    const current = session.logStart + session.steps.length;
    if (version !== current) return { accepted: false, version: current };
    if (session.steps.length + steps.length > MAX_LOG_STEPS) throw new CollabRefusal('log_full');
    for (const step of steps) session.steps.push({ step, clientId });
    return { accepted: true, version: current + steps.length };
  }

  /** A snapshot at exactly the newest version becomes the base; an older one is refused. */
  snapshot(key: string, version: number, html: string): boolean {
    const session = this.session(key);
    if (version !== session.logStart + session.steps.length) return false;
    session.baseVersion = version;
    session.baseHtml = html;
    const drop = Math.max(0, session.steps.length - KEEP_BEFORE_SNAPSHOT);
    session.steps = session.steps.slice(drop);
    session.logStart += drop;
    return true;
  }

  setCursor(key: string, cursor: Omit<CollabCursor, 'colour'>): void {
    const session = this.session(key);
    const colour = this.colourOf(session, cursor.userId);
    session.cursors.set(cursor.clientId, { ...cursor, colour, at: this.now() });
  }

  cursors(key: string): readonly CollabCursor[] {
    const session = this.session(key);
    const cutoff = this.now() - CURSOR_TTL_MS;
    const live: CollabCursor[] = [];
    for (const [clientId, cursor] of session.cursors) {
      if (cursor.at < cutoff) session.cursors.delete(clientId);
      else live.push(withoutAt(cursor));
    }
    return live;
  }

  private session(key: string): Session {
    const at = this.now();
    for (const [other, session] of this.sessions) {
      if (at - session.touchedAt > SESSION_IDLE_MS) this.sessions.delete(other);
    }
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        logStart: 0,
        baseVersion: 0,
        baseHtml: null,
        steps: [],
        colours: new Map(),
        cursors: new Map(),
        touchedAt: at,
      };
      this.sessions.set(key, session);
    }
    session.touchedAt = at;
    return session;
  }

  private colourOf(session: Session, userId: string): number {
    let colour = session.colours.get(userId);
    if (colour === undefined) {
      colour = session.colours.size % COLLAB_COLOURS;
      session.colours.set(userId, colour);
    }
    return colour;
  }
}

function isStepJson(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { stepType?: unknown }).stepType === 'string'
  );
}

function withoutAt(cursor: CollabCursor & { readonly at: number }): CollabCursor {
  return {
    userId: cursor.userId,
    clientId: cursor.clientId,
    name: cursor.name,
    colour: cursor.colour,
    anchor: cursor.anchor,
    head: cursor.head,
  };
}
