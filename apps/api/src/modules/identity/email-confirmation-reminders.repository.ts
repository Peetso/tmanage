import { and, eq, inArray } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { emailConfirmationReminders, platformSettings } from '../../common/database/schema.js';
import type { IdentityQueryRunner, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  DAY_MS,
  REMINDER_BATCH,
  REMINDER_DAYS,
  REMINDER_SWITCH_KEY,
  REMINDER_WINDOW_DAYS,
} from './email-confirmation-reminders.js';
import type { ReminderDay, ReminderStore } from './email-confirmation-reminders.js';
import { PasswordResetRepository } from './password-reset.repository.js';
import type { UnconfirmedAccount } from './password-reset.repository.js';
import type { EmailConfirmationRequest } from './password-reset.service.js';

/**
 * RESENDVERIFY (0416) — every statement of the "Confirm your e-mail" reminders, on the identity
 * path: the "Tips and reminders" switch, the unconfirmed password accounts inside the reminder
 * window, the reminders already claimed, the claim (`INSERT IGNORE` on the primary key) and the
 * result. The schedule itself is `dueReminderDay` (`email-confirmation-reminders.ts`).
 */

const REMINDER_TABLES = [
  'users',
  'user_passwords',
  'password_reset_tokens',
  'platform_settings',
  'email_confirmation_reminders',
] as const;

/** Every statement of the pass (identity path, the tables above). */
export class EmailConfirmationReminderRepository {
  constructor(private readonly resets: PasswordResetRepository = new PasswordResetRepository()) {}

  async switchOn(runner: IdentityQueryRunner): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ value: platformSettings.settingValue })
      .from(platformSettings)
      .where(eq(platformSettings.settingKey, REMINDER_SWITCH_KEY))
      .limit(1);
    return rows[0]?.value === 'on';
  }

  candidates(
    runner: IdentityQueryRunner,
    now: Date,
    limit: number,
  ): Promise<readonly UnconfirmedAccount[]> {
    const lastDay = REMINDER_DAYS[REMINDER_DAYS.length - 1] as number;
    return this.resets.listUnconfirmedCreatedBetween(runner, {
      createdAfter: new Date(now.getTime() - (lastDay + REMINDER_WINDOW_DAYS) * DAY_MS),
      createdBefore: new Date(now.getTime() - DAY_MS),
      limit,
    });
  }

  /** The reminders already claimed, per person: user id → (day → claimed at). */
  async sentTo(
    runner: IdentityQueryRunner,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlyMap<number, Date>>> {
    const out = new Map<string, Map<number, Date>>();
    if (userIds.length === 0) return out;
    const rows = await tenantDrizzle(runner)
      .select({
        userId: emailConfirmationReminders.userId,
        day: emailConfirmationReminders.reminderDay,
        claimedAt: emailConfirmationReminders.claimedAt,
      })
      .from(emailConfirmationReminders)
      .where(inArray(emailConfirmationReminders.userId, [...userIds]));
    for (const row of rows) {
      const days = out.get(row.userId) ?? new Map<number, Date>();
      days.set(row.day, row.claimedAt);
      out.set(row.userId, days);
    }
    return out;
  }

  /** Claim one reminder before the send; `false` when it was already claimed (by anyone). */
  async claim(
    runner: IdentityQueryRunner,
    userId: string,
    day: ReminderDay,
    at: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .insert(emailConfirmationReminders)
      .ignore()
      .values({ userId, reminderDay: day, claimedAt: at, result: null });
    return result[0].affectedRows === 1;
  }

  async settle(
    runner: IdentityQueryRunner,
    userId: string,
    day: ReminderDay,
    result: EmailConfirmationRequest,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(emailConfirmationReminders)
      .set({ result })
      .where(
        and(
          eq(emailConfirmationReminders.userId, userId),
          eq(emailConfirmationReminders.reminderDay, day),
        ),
      );
  }
}

export function reminderStore(
  database: TenantDatabase,
  repository: EmailConfirmationReminderRepository = new EmailConfirmationReminderRepository(),
): ReminderStore {
  const read = <T>(correlationId: string, work: (db: IdentityQueryRunner) => Promise<T>) =>
    database.identityRead({ correlationId, tables: [...REMINDER_TABLES] }, work);
  const write = <T>(correlationId: string, work: (db: IdentityQueryRunner) => Promise<T>) =>
    database.identityTransaction({ correlationId, tables: [...REMINDER_TABLES] }, work);
  return {
    switchOn: (correlationId) => read(correlationId, (db) => repository.switchOn(db)),
    candidates: (correlationId, now) =>
      read(correlationId, (db) => repository.candidates(db, now, REMINDER_BATCH)),
    sentTo: (correlationId, userIds) => read(correlationId, (db) => repository.sentTo(db, userIds)),
    claim: (correlationId, userId, day, at) =>
      write(correlationId, (db) => repository.claim(db, userId, day, at)),
    settle: (correlationId, userId, day, result) =>
      write(correlationId, (db) => repository.settle(db, userId, day, result)),
  };
}
