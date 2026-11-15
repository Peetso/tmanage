import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetingAttendance, meetingCallLinks } from '../../common/database/schema.js';
import type { MeetingAttendanceRow, MeetingCallLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 53-12 (0353) — a meeting's pasted call link / quick room and its attendance. Every statement
 * carries the context's `organization_id` and the meeting id (spec 25 §6); the service resolves the
 * meeting tenant-scoped and checks the caller before any of these run.
 */
export class MeetingJoinRepository {
  async findCallLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<MeetingCallLinkRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(meetingCallLinks)
      .where(
        and(
          eq(meetingCallLinks.organizationId, context.organizationId),
          eq(meetingCallLinks.meetingId, meetingId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Set or replace the meeting's call link (one row per meeting). */
  async setCallLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly meetingId: string;
      readonly kind: 'link' | 'quick_room';
      readonly url: string;
      readonly setByUserId: string;
    },
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    const existing = await this.findCallLink(runner, context, input.meetingId);
    if (existing) {
      await db
        .update(meetingCallLinks)
        .set({
          kind: input.kind,
          url: input.url,
          setByUserId: input.setByUserId,
          updatedAt: sql`current_timestamp(3)`,
        })
        .where(
          and(
            eq(meetingCallLinks.organizationId, context.organizationId),
            eq(meetingCallLinks.id, existing.id),
          ),
        );
      return;
    }
    await db.insert(meetingCallLinks).values({
      id: uuidv7(),
      organizationId: context.organizationId,
      meetingId: input.meetingId,
      kind: input.kind,
      url: input.url,
      setByUserId: input.setByUserId,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });
  }

  async clearCallLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(meetingCallLinks)
      .where(
        and(
          eq(meetingCallLinks.organizationId, context.organizationId),
          eq(meetingCallLinks.meetingId, meetingId),
        ),
      );
  }

  async findAttendance(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    userId: string,
  ): Promise<MeetingAttendanceRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(meetingAttendance)
      .where(
        and(
          eq(meetingAttendance.organizationId, context.organizationId),
          eq(meetingAttendance.meetingId, meetingId),
          eq(meetingAttendance.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listAttendance(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<readonly MeetingAttendanceRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(meetingAttendance)
      .where(
        and(
          eq(meetingAttendance.organizationId, context.organizationId),
          eq(meetingAttendance.meetingId, meetingId),
        ),
      )
      .orderBy(asc(meetingAttendance.id))
      .limit(500);
  }

  /** The first Join click of a person: present, joined at `joinedAt`. */
  async insertJoin(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly meetingId: string;
      readonly userId: string;
      readonly attendeeKind: 'member' | 'client';
      readonly joinedAt: Date;
    },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(meetingAttendance)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        meetingId: input.meetingId,
        userId: input.userId,
        attendeeKind: input.attendeeKind,
        status: 'present',
        source: 'join_click',
        firstJoinedAt: input.joinedAt,
        lastJoinedAt: input.joinedAt,
        joinCount: 1,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });
  }

  /** A later Join click: the first join time stays, the last one moves, the count grows. */
  async touchJoin(
    runner: TenantQueryRunner,
    context: TenantContext,
    rowId: string,
    firstJoinedAt: Date,
    lastJoinedAt: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(meetingAttendance)
      .set({
        status: 'present',
        firstJoinedAt,
        lastJoinedAt,
        joinCount: sql`${meetingAttendance.joinCount} + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(meetingAttendance.organizationId, context.organizationId),
          eq(meetingAttendance.id, rowId),
        ),
      );
  }

  /** The organizer's correction ("Mark present" / "Mark absent"). */
  async mark(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly meetingId: string;
      readonly userId: string;
      readonly attendeeKind: 'member' | 'client';
      readonly status: 'present' | 'absent';
      readonly markedByUserId: string;
    },
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    const existing = await this.findAttendance(runner, context, input.meetingId, input.userId);
    if (existing) {
      await db
        .update(meetingAttendance)
        .set({
          status: input.status,
          source: 'manual',
          markedByUserId: input.markedByUserId,
          updatedAt: sql`current_timestamp(3)`,
        })
        .where(
          and(
            eq(meetingAttendance.organizationId, context.organizationId),
            eq(meetingAttendance.id, existing.id),
          ),
        );
      return;
    }
    await db.insert(meetingAttendance).values({
      id: uuidv7(),
      organizationId: context.organizationId,
      meetingId: input.meetingId,
      userId: input.userId,
      attendeeKind: input.attendeeKind,
      status: input.status,
      source: 'manual',
      joinCount: 0,
      markedByUserId: input.markedByUserId,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });
  }
}
