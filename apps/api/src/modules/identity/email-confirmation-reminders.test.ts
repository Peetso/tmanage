import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { PasswordResetMailer } from '../../common/email/password-reset-email.js';
import { TIPS_SWITCH_KEY } from '../platform-admin/settings/person-mail.repository.js';
import {
  EmailConfirmationReminderJob,
  EmailConfirmationReminderPass,
  REMINDER_SWITCH_KEY,
  dueReminderDay,
  emailConfirmationRemindersEnabled,
} from './email-confirmation-reminders.js';
import type { ReminderDay, ReminderSender, ReminderStore } from './email-confirmation-reminders.js';
import type { PasswordResetRepository } from './password-reset.repository.js';
import {
  createPasswordResetMailBudget,
  EmailConfirmationService,
} from './password-reset.service.js';

/**
 * RESENDVERIFY (2026-11-24): a password sign-up that never confirmed its address got no follow-up
 * at all (the person-mail sweep mails confirmed members only). The schedule, the no-repeat rule,
 * the switch, and the account checks the resend makes.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SIGNED_UP = new Date('2026-11-01T09:00:00Z');
const at = (ms: number) => new Date(SIGNED_UP.getTime() + ms);
const none = new Map<number, Date>();

describe('dueReminderDay: about 1, 3 and 7 days after sign-up, then stop', () => {
  it('sends nothing in the first 24 hours', () => {
    expect(dueReminderDay(SIGNED_UP, at(0), none)).toBeNull();
    expect(dueReminderDay(SIGNED_UP, at(23 * HOUR), none)).toBeNull();
    expect(dueReminderDay(SIGNED_UP, at(DAY - 1), none)).toBeNull();
  });

  it('opens each reminder on its day, for two days', () => {
    expect([
      dueReminderDay(SIGNED_UP, at(DAY), none),
      dueReminderDay(SIGNED_UP, at(3 * DAY - 1), none),
      dueReminderDay(SIGNED_UP, at(3 * DAY), none),
      dueReminderDay(SIGNED_UP, at(5 * DAY - 1), none),
      dueReminderDay(SIGNED_UP, at(5 * DAY), none),
      dueReminderDay(SIGNED_UP, at(7 * DAY - 1), none),
      dueReminderDay(SIGNED_UP, at(7 * DAY), none),
      dueReminderDay(SIGNED_UP, at(9 * DAY - 1), none),
    ]).toEqual([1, 1, 3, 3, null, null, 7, 7]);
  });

  it('stops after the 7-day reminder: an old account is never mailed by the reminders', () => {
    expect(dueReminderDay(SIGNED_UP, at(9 * DAY), none)).toBeNull();
    expect(dueReminderDay(SIGNED_UP, at(300 * DAY), none)).toBeNull();
  });

  it('never sends a reminder day twice', () => {
    const sentDay1 = new Map([[1, at(DAY + HOUR)]]);
    expect(dueReminderDay(SIGNED_UP, at(2 * DAY + 2 * HOUR), sentDay1)).toBeNull();
    expect(dueReminderDay(SIGNED_UP, at(3 * DAY + 2 * HOUR), sentDay1)).toBe(3);
    const sentAll = new Map([
      [1, at(DAY)],
      [3, at(3 * DAY)],
      [7, at(7 * DAY)],
    ]);
    expect(dueReminderDay(SIGNED_UP, at(8 * DAY), sentAll)).toBeNull();
  });

  it('keeps 24 hours between two reminders, even when the first went out late', () => {
    const lateDay1 = new Map([[1, at(3 * DAY - HOUR)]]);
    expect(dueReminderDay(SIGNED_UP, at(3 * DAY), lateDay1)).toBeNull();
    expect(dueReminderDay(SIGNED_UP, at(4 * DAY - HOUR), lateDay1)).toBe(3);
  });
});

function store(options: {
  switchOn?: boolean;
  accounts?: readonly { userId: string; email: string; createdAt: Date }[];
  sent?: ReadonlyMap<string, ReadonlyMap<number, Date>>;
  claimable?: (userId: string, day: ReminderDay) => boolean;
}) {
  const claims: [string, ReminderDay][] = [];
  const settled: [string, ReminderDay, string][] = [];
  const reads = vi.fn();
  const fake: ReminderStore = {
    switchOn: async () => options.switchOn ?? true,
    candidates: async () => {
      reads();
      return options.accounts ?? [];
    },
    sentTo: async () => options.sent ?? new Map(),
    claim: async (_c, userId, day) => {
      claims.push([userId, day]);
      return options.claimable?.(userId, day) ?? true;
    },
    settle: async (_c, userId, day, result) => {
      settled.push([userId, day, result]);
    },
  };
  return { fake, claims, settled, reads };
}

function sender(result: 'sent' | 'not_sent' | 'already_confirmed' = 'sent') {
  const calls: string[] = [];
  const fake: ReminderSender = {
    requestForAccount: async (userId) => {
      calls.push(userId);
      return result;
    },
  };
  return { fake, calls };
}

describe('EmailConfirmationReminderPass', () => {
  const NOW = at(DAY + HOUR);
  const accounts = [
    { userId: 'u-new', email: 'new@example.com', createdAt: SIGNED_UP },
    { userId: 'u-done', email: 'done@example.com', createdAt: SIGNED_UP },
  ];

  it('does nothing while "Tips and reminders" is off', async () => {
    const s = store({ switchOn: false, accounts });
    const m = sender();
    const report = await new EmailConfirmationReminderPass(s.fake, m.fake, () => NOW).run();
    expect([report, s.reads.mock.calls.length, m.calls]).toEqual([
      { looked: 0, sent: 0, notSent: 0 },
      0,
      [],
    ]);
  });

  it('claims before it sends, sends the due reminder once and records the result', async () => {
    const s = store({ accounts, sent: new Map([['u-done', new Map([[1, at(DAY)]])]]) });
    const m = sender();
    const report = await new EmailConfirmationReminderPass(s.fake, m.fake, () => NOW).run();
    expect(s.claims).toEqual([['u-new', 1]]);
    expect(m.calls).toEqual(['u-new']);
    expect(s.settled).toEqual([['u-new', 1, 'sent']]);
    expect(report).toEqual({ looked: 2, sent: 1, notSent: 0 });
  });

  it('sends nothing when another run already claimed the reminder', async () => {
    const s = store({ accounts: [accounts[0]!], claimable: () => false });
    const m = sender();
    const report = await new EmailConfirmationReminderPass(s.fake, m.fake, () => NOW).run();
    expect([m.calls, s.settled, report.sent]).toEqual([[], [], 0]);
  });

  it('records a reminder that could not go out, and does not retry it', async () => {
    const s = store({ accounts: [accounts[0]!] });
    const m = sender('not_sent');
    const report = await new EmailConfirmationReminderPass(s.fake, m.fake, () => NOW).run();
    expect([s.settled, report.notSent]).toEqual([[['u-new', 1, 'not_sent']], 1]);
  });

  it('reads the switch the tips read', () => {
    expect(REMINDER_SWITCH_KEY).toBe(TIPS_SWITCH_KEY);
  });
});

describe('EmailConfirmationReminderJob', () => {
  it('runs only where background work runs', () => {
    expect(emailConfirmationRemindersEnabled({})).toBe(false);
    expect(emailConfirmationRemindersEnabled({ WORKER_INPROCESS: '1' })).toBe(true);
    expect(emailConfirmationRemindersEnabled({ EMAIL_CONFIRMATION_REMINDERS_INPROCESS: '1' })).toBe(
      true,
    );
  });

  it('never overlaps two runs, and a failed run does not stop the next', async () => {
    let release: () => void = () => undefined;
    const run = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({}))))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ looked: 0, sent: 0, notSent: 0 });
    const job = new EmailConfirmationReminderJob({ run }, true, {
      bootDelayMs: 1,
      intervalMs: 1_000_000,
      log: () => undefined,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = job.tick();
    expect(job.tick()).toBeNull();
    release();
    await first;
    await job.tick();
    await job.tick();
    expect(run).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    await job.onModuleDestroy();
  });
});

describe('EmailConfirmationService.requestForAccount (someone else names the account)', () => {
  function service(account: {
    emailVerified?: boolean;
    disabled?: boolean;
    hasPassword?: boolean;
    email?: string;
  }) {
    const mails: string[] = [];
    const repository = {
      findConfirmationTarget: async () => ({
        userId: 'u-1',
        email: account.email ?? 'owner@example.com',
        displayName: 'Owner',
        locale: 'en',
        emailVerified: account.emailVerified ?? false,
        disabled: account.disabled ?? false,
        hasPassword: account.hasPassword ?? true,
      }),
      retireOpen: async () => undefined,
      create: async () => undefined,
    } as unknown as PasswordResetRepository;
    const database = {
      identityTransaction: async (_options: unknown, run: (tx: unknown) => unknown) => run({}),
    } as unknown as TenantDatabase;
    const mailer = {
      deliverConfirmation: async (facts: { to: string }) => {
        mails.push(facts.to);
        return 'sent' as const;
      },
    } as unknown as PasswordResetMailer;
    return {
      service: new EmailConfirmationService(
        database,
        mailer,
        repository,
        createPasswordResetMailBudget(),
      ),
      mails,
    };
  }
  const CONTEXT = { correlationId: 'c-1' };

  it('mails an active, unconfirmed password account', async () => {
    const h = service({});
    expect(await h.service.requestForAccount('u-1', CONTEXT)).toBe('sent');
    expect(h.mails).toEqual(['owner@example.com']);
  });

  it('mails no disabled account, no account without a password and no AI employee', async () => {
    const cases = [
      service({ disabled: true }),
      service({ hasPassword: false }),
      service({ email: 'ai-1@ai-employee.invalid' }),
    ];
    const answers = await Promise.all(
      cases.map((h) => h.service.requestForAccount('u-1', CONTEXT)),
    );
    expect(answers).toEqual(['not_sent', 'not_sent', 'not_sent']);
    expect(cases.flatMap((h) => h.mails)).toEqual([]);
  });

  it('answers already_confirmed for a confirmed address', async () => {
    const h = service({ emailVerified: true });
    expect(await h.service.requestForAccount('u-1', CONTEXT)).toBe('already_confirmed');
  });

  it('keeps the per-account hourly bound: the fourth link in an hour is not sent', async () => {
    const h = service({});
    const answers = [];
    for (let i = 0; i < 4; i += 1) answers.push(await h.service.requestForAccount('u-1', CONTEXT));
    expect(answers).toEqual(['sent', 'sent', 'sent', 'not_sent']);
  });
});
