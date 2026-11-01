import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { tenantDrizzle } from '../../../common/database/drizzle.js';
import {
  authenticationEvents,
  ipLookups,
  sessions,
  type IpLookupRow,
} from '../../../common/database/schema.js';
import type { IdentityQueryRunner } from '../../../common/database/tenant-context.js';
import type { AutomationFacts, IntelInputs } from './session-intel.js';

/** The global tables every intel read declares (all three are NON_TENANT_TABLES). */
export const INTEL_TABLES = ['sessions', 'authentication_events', 'ip_lookups'] as const;

/** The most events one trail export carries. */
export const TRAIL_MAX_EVENTS = 5000;

export interface SessionLinkRow {
  readonly ipFirst: string | null;
  readonly ipLast: string | null;
  readonly signInEventId: string | null;
}

export interface TrailSessionRow extends SessionLinkRow {
  readonly id: string;
  readonly userId: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** An event for the trail. No `reason`: it is never returned, so it is never selected. */
export interface TrailEventRow extends AutomationFacts {
  readonly id: string;
  readonly action: string;
  readonly outcome: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: Date;
}

/** R12 (R1). The reads behind `SessionIntelView` and the trail exports (identity runner). */
export class SessionIntelRepository {
  async inputs(
    runner: IdentityQueryRunner,
    ips: readonly (string | null)[],
    eventIds: readonly (string | null)[],
  ): Promise<IntelInputs> {
    const wantedIps = unique(ips);
    const wantedEvents = unique(eventIds);
    const db = tenantDrizzle(runner);
    const lookups: IpLookupRow[] =
      wantedIps.length === 0
        ? []
        : await db.select().from(ipLookups).where(inArray(ipLookups.ip, wantedIps));
    const events =
      wantedEvents.length === 0
        ? []
        : await db
            .select({
              id: authenticationEvents.id,
              score: authenticationEvents.automationScore,
              reasons: authenticationEvents.automationReasonsJson,
            })
            .from(authenticationEvents)
            .where(inArray(authenticationEvents.id, wantedEvents));
    return {
      lookups: new Map(lookups.map((row) => [row.ip, row])),
      automation: new Map(
        events.map((row) => [row.id, { score: row.score, reasons: reasonsOf(row.reasons) }]),
      ),
    };
  }

  /** `ip_first`, `ip_last` and the sign-in event of each session id. */
  async sessionLinks(
    runner: IdentityQueryRunner,
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, SessionLinkRow>> {
    if (sessionIds.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({
        id: sessions.id,
        ipFirst: sessions.ipFirst,
        ipLast: sessions.ipLast,
        signInEventId: sessions.signInEventId,
      })
      .from(sessions)
      .where(inArray(sessions.id, [...sessionIds]));
    return new Map(rows.map(({ id, ...link }) => [id, link]));
  }

  /** One session in any state — no credential material. */
  async trailSession(
    runner: IdentityQueryRunner,
    sessionId: string,
  ): Promise<TrailSessionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: sessions.id,
        userId: sessions.userId,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        rotatedAt: sessions.rotatedAt,
        expiresAt: sessions.expiresAt,
        revokedAt: sessions.revokedAt,
        ipFirst: sessions.ipFirst,
        ipLast: sessions.ipLast,
        signInEventId: sessions.signInEventId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The user's authentication events in `[from, to]`, oldest first, capped. */
  async trailEvents(
    runner: IdentityQueryRunner,
    userId: string,
    from: Date,
    to: Date,
  ): Promise<readonly TrailEventRow[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: authenticationEvents.id,
        action: authenticationEvents.action,
        outcome: authenticationEvents.outcome,
        ip: authenticationEvents.ip,
        userAgent: authenticationEvents.userAgent,
        occurredAt: authenticationEvents.occurredAt,
        score: authenticationEvents.automationScore,
        reasons: authenticationEvents.automationReasonsJson,
      })
      .from(authenticationEvents)
      .where(
        and(
          eq(authenticationEvents.userId, userId),
          gte(authenticationEvents.occurredAt, from),
          lte(authenticationEvents.occurredAt, to),
        ),
      )
      .orderBy(asc(authenticationEvents.occurredAt), asc(authenticationEvents.id))
      .limit(TRAIL_MAX_EVENTS);
    return rows.map((row) => ({ ...row, reasons: reasonsOf(row.reasons) }));
  }
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

/** The JSON column arrives parsed or as text, depending on the driver path. */
export function reasonsOf(raw: unknown): readonly string[] | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : null;
}
