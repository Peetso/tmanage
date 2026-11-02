import type { PlatformPreset } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { optionalReason } from '../platform-admin.access.js';
import type { PlatformRequestContext } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminsRepository } from '../platform-admins.repository.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type { AccessReviewStore } from './access-review.repository.js';

/**
 * 56-21b — the monthly "who had platform access" review (56-SECURITY-AND-TRUST-PLAN, 56-21).
 *
 * A month's rows are everyone who could open Platform admin in it — the server list
 * (`PLATFORM_ADMIN_EMAILS`), every team row created before the month ended and not disabled
 * before it began — plus anyone else the platform log shows acting in it (a removed admin still
 * answers for the month). Per person: preset, status, two-step (today's state), sign-ins
 * (`platform.step_up`), support sessions, organizations entered, last activity.
 *
 * `record` writes `platform.access_review_recorded` with the month and its totals, so the review
 * is evidenced in the platform log. Both need `platform.team.manage` (the guard; checked here
 * again so the service never answers without it).
 */

export const ACCESS_REVIEW_PERMISSION = 'platform.team.manage';
const MONTH_SHAPE = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export type AccessReviewSource = 'env' | 'db' | 'former';

export interface AccessReviewRow {
  readonly userId: string | null;
  readonly email: string;
  readonly displayName: string | null;
  readonly source: AccessReviewSource;
  readonly preset: PlatformPreset | null;
  readonly status: 'active' | 'disabled' | 'removed';
  readonly twoStep: boolean;
  readonly signIns: number;
  readonly supportSessions: number;
  readonly organizationsEntered: number;
  readonly lastActiveAt: string | null;
}

export interface AccessReviewView {
  readonly month: string;
  readonly from: string;
  readonly to: string;
  readonly admins: readonly AccessReviewRow[];
  readonly withoutTwoStep: number;
}

export type AccessReviewTeam = Pick<PlatformAdminsRepository, 'listTeam' | 'findUsersByEmails'>;

/** `YYYY-MM` → its UTC bounds `[from, to)`; empty = the last full month. A future month is a 400. */
export function parseMonth(raw: unknown, now: Date): { month: string; from: Date; to: Date } {
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth(); // 0-based: the previous month, 1-based
  if (month === 0) {
    year -= 1;
    month = 12;
  }
  if (raw !== undefined && raw !== null && raw !== '') {
    const match = typeof raw === 'string' ? MONTH_SHAPE.exec(raw) : null;
    if (match === null) throw invalidMonth();
    year = Number(match[1]);
    month = Number(match[2]);
  }
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  if (from.getTime() > now.getTime()) throw invalidMonth();
  return { month: `${String(year)}-${String(month).padStart(2, '0')}`, from, to };
}

function invalidMonth(): ApiError {
  return new ApiError(400, 'validation_failed', 'Choose a month that has started.', [
    { field: 'month', message: 'YYYY-MM, not in the future' },
  ]);
}

const latest = (...dates: readonly (Date | null | undefined)[]): string | null => {
  const times = dates.filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  return times.length === 0 ? null : new Date(Math.max(...times)).toISOString();
};

export class AccessReviewService {
  constructor(
    private readonly team: AccessReviewTeam,
    private readonly store: AccessReviewStore,
    private readonly allowlist: readonly string[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  async review(
    actor: PlatformAdminActor,
    query: { readonly month?: unknown },
    context: PlatformRequestContext,
  ): Promise<AccessReviewView> {
    requireManage(actor);
    const { month, from, to } = parseMonth(query.month, this.now());
    const id = context.correlationId;
    const [team, envUsers, activity, support] = await Promise.all([
      this.team.listTeam(id),
      this.team.findUsersByEmails(this.allowlist, id),
      this.store.monthActivity(from, to, id),
      this.store.monthSupport(from, to, id),
    ]);
    const acts = new Map(activity.map((row) => [row.userId, row]));
    const visits = new Map(support.map((row) => [row.userId, row]));

    type Base = Pick<
      AccessReviewRow,
      'userId' | 'email' | 'displayName' | 'source' | 'preset' | 'status' | 'lastActiveAt'
    >;
    const bases: Base[] = [];
    const seen = new Set<string>();
    for (const email of this.allowlist) {
      const user = envUsers.find((u) => u.email.toLowerCase() === email);
      if (user) seen.add(user.userId);
      bases.push({
        ...{ userId: user?.userId ?? null, email, displayName: user?.displayName ?? null },
        ...{ source: 'env', preset: 'super_admin', status: 'active', lastActiveAt: null },
      });
    }
    for (const row of team) {
      if (seen.has(row.userId)) continue;
      const created = row.createdAt.getTime() < to.getTime();
      const disabledBefore = row.disabledAt !== null && row.disabledAt.getTime() < from.getTime();
      if (!created || disabledBefore) continue;
      seen.add(row.userId);
      bases.push({
        ...{ userId: row.userId, email: row.email, displayName: row.displayName },
        ...{ source: 'db', preset: row.preset, status: row.status, lastActiveAt: null },
      });
    }
    for (const row of [...activity, ...support]) {
      if (seen.has(row.userId)) continue;
      seen.add(row.userId);
      const email = acts.get(row.userId)?.email ?? '';
      bases.push({
        ...{ userId: row.userId, email, displayName: null, source: 'former', preset: null },
        ...{ status: 'removed', lastActiveAt: null },
      });
    }

    const ids = bases.map((b) => b.userId).filter((u): u is string => u !== null);
    const people = new Map((await this.store.users(ids, id)).map((u) => [u.userId, u]));
    const admins = bases.map((base): AccessReviewRow => {
      const userId = base.userId;
      const act = userId === null ? undefined : acts.get(userId);
      const visit = userId === null ? undefined : visits.get(userId);
      const person = userId === null ? undefined : people.get(userId);
      return {
        ...base,
        email: base.email !== '' ? base.email : (person?.email ?? ''),
        displayName: base.displayName ?? person?.displayName ?? null,
        twoStep: person?.twoStep ?? false,
        signIns: act?.signIns ?? 0,
        supportSessions: visit?.sessions ?? 0,
        organizationsEntered: visit?.organizations ?? 0,
        lastActiveAt: latest(act?.lastActionAt, visit?.lastStartedAt),
      };
    });
    return {
      month,
      from: from.toISOString(),
      to: to.toISOString(),
      admins,
      withoutTwoStep: admins.filter((admin) => !admin.twoStep).length,
    };
  }

  /** Evidence the review: one `platform.access_review_recorded` row with the month's totals. */
  async record(
    actor: PlatformAdminActor,
    body: { readonly month?: unknown; readonly reason?: unknown },
    context: PlatformRequestContext,
  ): Promise<{ readonly month: string; readonly admins: number; readonly recordedAt: string }> {
    requireManage(actor);
    if (body.month === undefined || body.month === null || body.month === '') {
      throw invalidMonth();
    }
    const reason = optionalReason(body.reason);
    const view = await this.review(actor, { month: body.month }, context);
    const totals = {
      month: view.month,
      admins: view.admins.length,
      withoutTwoStep: view.withoutTwoStep,
      supportSessions: view.admins.reduce((sum, admin) => sum + admin.supportSessions, 0),
    };
    await this.store.recordReview(
      platformAuditFor(actor, context, {
        action: 'platform.access_review_recorded',
        targetType: 'platform',
        targetId: null,
        targetLabel: view.month,
        reason,
        afterJson: JSON.stringify(totals),
      }),
      context.correlationId,
    );
    return { month: view.month, admins: totals.admins, recordedAt: this.now().toISOString() };
  }
}

function requireManage(actor: PlatformAdminActor): void {
  if (!(actor.permissions ?? []).includes(ACCESS_REVIEW_PERMISSION)) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
  }
}
