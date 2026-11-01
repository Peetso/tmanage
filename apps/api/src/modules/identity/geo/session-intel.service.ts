import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import {
  INTEL_TABLES,
  SessionIntelRepository,
  type SessionLinkRow,
  type TrailEventRow,
  type TrailSessionRow,
} from './session-intel.repository.js';
import {
  eventIntel,
  intelOf,
  NO_INTEL_INPUTS,
  sessionIntel,
  type SessionIntelView,
  type SignInEventIntelView,
} from './session-intel.js';
import { trailToCsv, type TrailCsvRow } from './trail-csv.js';

/** A session as the list routes already hold it; the links are read when absent. */
export interface IntelSessionInput {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly link?: SessionLinkRow;
}

export type IntelEventInput = Omit<TrailEventRow, 'id'>;

/** The trail starts this long before the session did (the sign-in and its failed attempts). */
export const TRAIL_LEAD_MS = 60 * 60 * 1000;

/**
 * R12 (R1). Turns sessions and sign-in events into their `SessionIntelView`s, and a session or a
 * person into the UTC trail CSV. Reads only the global `sessions`, `authentication_events` and
 * `ip_lookups` on the identity path; WHO may see a session is decided by the caller (`mayRead`).
 * Without a database (unit wiring) the views carry the device only.
 */
export class SessionIntelReader {
  constructor(
    private readonly database: TenantDatabase | null,
    private readonly repository: SessionIntelRepository = new SessionIntelRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async forSessions(
    correlationId: string,
    rows: readonly IntelSessionInput[],
  ): Promise<ReadonlyMap<string, SessionIntelView>> {
    const { links, inputs } =
      this.database === null || rows.length === 0
        ? { links: new Map<string, SessionLinkRow>(), inputs: NO_INTEL_INPUTS }
        : await this.database.identityRead(
            { correlationId, tables: [...INTEL_TABLES] },
            async (runner) => {
              const missing = rows.filter((row) => !row.link).map((row) => row.id);
              const read = await this.repository.sessionLinks(runner, missing);
              const all = new Map(read);
              for (const row of rows) if (row.link) all.set(row.id, row.link);
              const values = [...all.values()];
              return {
                links: all,
                inputs: await this.repository.inputs(
                  runner,
                  values.flatMap((link) => [link.ipFirst, link.ipLast]),
                  values.map((link) => link.signInEventId),
                ),
              };
            },
          );
    return new Map(
      rows.map((row) => {
        const link = links.get(row.id) ?? { ipFirst: null, ipLast: null, signInEventId: null };
        const input = { ...link, userAgent: row.userAgent, firstSeenAt: row.createdAt };
        return [row.id, sessionIntel({ ...input, lastSeenAt: row.lastSeenAt }, inputs)];
      }),
    );
  }

  async forEvents(
    correlationId: string,
    events: readonly IntelEventInput[],
  ): Promise<readonly SignInEventIntelView[]> {
    const inputs =
      this.database === null || events.length === 0
        ? NO_INTEL_INPUTS
        : await this.database.identityRead({ correlationId, tables: [...INTEL_TABLES] }, (runner) =>
            this.repository.inputs(
              runner,
              events.map((event) => event.ip),
              [],
            ),
          );
    return events.map((event) => eventIntel(event, inputs.lookups));
  }

  /**
   * One session's trail: the session row, then every event of its owner from an hour before it
   * began to its end. `null` (the caller's 404) when the session is unknown or `mayRead` refuses
   * its owner — the two are indistinguishable.
   */
  async sessionTrail(
    correlationId: string,
    sessionId: string,
    mayRead: (ownerUserId: string) => boolean,
  ): Promise<string | null> {
    if (this.database === null) return null;
    return this.database.identityRead(
      { correlationId, tables: [...INTEL_TABLES] },
      async (runner) => {
        const session = await this.repository.trailSession(runner, sessionId);
        if (!session || !mayRead(session.userId)) return null;
        const from = new Date(session.createdAt.getTime() - TRAIL_LEAD_MS);
        const to = session.revokedAt ?? session.expiresAt;
        const events = await this.repository.trailEvents(runner, session.userId, from, to);
        const inputs = await this.repository.inputs(
          runner,
          [session.ipFirst, session.ipLast, ...events.map((event) => event.ip)],
          [session.signInEventId],
        );
        const head = sessionRow(session, this.now(), sessionIntel(sessionInputOf(session), inputs));
        return trailToCsv([head, ...events.map((event) => eventRow(event, inputs.lookups))]);
      },
    );
  }

  /** A person's sign-in trail in `[from, to]` (the platform export). */
  async userTrail(correlationId: string, userId: string, from: Date, to: Date): Promise<string> {
    if (this.database === null) return trailToCsv([]);
    return this.database.identityRead(
      { correlationId, tables: [...INTEL_TABLES] },
      async (runner) => {
        const events = await this.repository.trailEvents(runner, userId, from, to);
        const inputs = await this.repository.inputs(
          runner,
          events.map((event) => event.ip),
          [],
        );
        return trailToCsv(events.map((event) => eventRow(event, inputs.lookups)));
      },
    );
  }
}

function sessionInputOf(session: TrailSessionRow) {
  return {
    ...session,
    firstSeenAt: session.createdAt,
    lastSeenAt: session.rotatedAt ?? session.createdAt,
  };
}

function sessionRow(session: TrailSessionRow, now: Date, view: SessionIntelView): TrailCsvRow {
  const outcome =
    session.revokedAt !== null
      ? 'ended'
      : session.expiresAt.getTime() <= now.getTime()
        ? 'expired'
        : 'live';
  const { location, network, device, automation } = view;
  return {
    occurredAt: session.createdAt,
    action: 'session',
    outcome,
    ip: session.ipLast ?? session.ipFirst,
    intel: { location, network, device, automation },
  };
}

function eventRow(event: TrailEventRow, lookups: Parameters<typeof eventIntel>[1]): TrailCsvRow {
  const lookup = event.ip ? (lookups.get(event.ip) ?? null) : null;
  return { ...event, intel: intelOf(lookup, event.userAgent, event) };
}
