import { describe, expect, it } from 'vitest';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import { QUIET_HOURS_MAIL_RESUME_TYPE } from '../common/database/notifications-store.js';
import type { OutboxEffect, OutboxEffects } from '../outbox/dispatcher.js';
import type { UsageThresholdEmailFacts } from '../notifications/usage-threshold-mailer.js';
import type { UsageThresholdMailer } from '../notifications/usage-threshold-mailer.js';
import {
  createUsageThresholdMail,
  createUsageThresholdMailResume,
} from './usage-threshold-mail.js';

/**
 * The unit half of USAGE-001 slice 4c, driven through fakes: a transaction that answers the
 * membership read, the per-recipient facts read and records any resume enqueue; an effects
 * collector; and a mailer that records (or refuses) sends. Proves the fan-out, the mail-channel
 * toggle (§2), the band-100 bypass vs 70/85/95 defer (§3) and per-recipient failure isolation
 * (§4) without a server — the consumer reads two tables and writes one, all fakeable.
 */

interface Membership {
  readonly user_id: string;
  readonly role: string;
  readonly has_org_wide_scope: number;
}
interface RecipientRow {
  readonly email: string;
  readonly display_name: string;
  readonly email_enabled: number | null;
  readonly quiet_hours_start: string | null;
  readonly quiet_hours_end: string | null;
  readonly quiet_hours_timezone: string | null;
}

/** A window straddling `now` in UTC, so the recipient is reliably inside quiet hours at run time. */
function quietWindowAround(
  now = new Date(),
): Pick<RecipientRow, 'quiet_hours_start' | 'quiet_hours_end' | 'quiet_hours_timezone'> {
  const secs = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const hms = (s: number): string => {
    const w = ((s % 86400) + 86400) % 86400;
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${p(Math.floor(w / 3600))}:${p(Math.floor(w / 60) % 60)}:${p(w % 60)}`;
  };
  return {
    quiet_hours_start: hms(secs - 7200),
    quiet_hours_end: hms(secs + 7200),
    quiet_hours_timezone: 'UTC',
  };
}

const NO_QUIET = { quiet_hours_start: null, quiet_hours_end: null, quiet_hours_timezone: null };

function recipient(email: string, extra: Partial<RecipientRow> = {}): RecipientRow {
  return { email, display_name: email, email_enabled: 1, ...NO_QUIET, ...extra };
}

function fakeTx(
  memberships: readonly Membership[],
  recipients: Record<string, RecipientRow>,
): {
  readonly tx: WorkerTransaction;
  readonly resumes: { readonly recipientUserId: unknown; readonly resumeAt: unknown }[];
} {
  const resumes: { recipientUserId: unknown; resumeAt: unknown }[] = [];
  const tx = {
    async query(sql: string, params: readonly unknown[] = []): Promise<unknown> {
      if (/FROM memberships/.test(sql)) {
        // The single-recipient read (F58 resume re-check) names one user; the fan-out does not.
        if (/m\.user_id = \?/.test(sql)) {
          return memberships.filter((m) => m.user_id === params[1]);
        }
        return memberships;
      }
      if (/FROM users u/.test(sql)) {
        const row = recipients[params[1] as string];
        return row === undefined ? [] : [row];
      }
      if (/INSERT INTO outbox_events/.test(sql)) {
        const payload = JSON.parse(params[6] as string) as { recipientUserId?: unknown };
        resumes.push({ recipientUserId: payload.recipientUserId, resumeAt: params[8] });
        return { affectedRows: 1 };
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  } as unknown as WorkerTransaction;
  return { tx, resumes };
}

function fakeEffects(): { readonly effects: OutboxEffects; readonly staged: OutboxEffect[] } {
  const staged: OutboxEffect[] = [];
  return { effects: { afterCommit: (effect) => staged.push(effect) }, staged };
}

function fakeMailer(throwFor?: string): {
  readonly mailer: UsageThresholdMailer;
  readonly sent: UsageThresholdEmailFacts[];
} {
  const sent: UsageThresholdEmailFacts[] = [];
  const mailer = {
    enabled: true,
    async deliver(facts: UsageThresholdEmailFacts): Promise<'sent'> {
      if (throwFor === facts.recipientEmail) throw new Error('smtp down');
      sent.push(facts);
      return 'sent';
    },
  } as unknown as UsageThresholdMailer;
  return { mailer, sent };
}

/** Run staged effects the way the dispatcher does — each isolated in its own try/catch. */
async function runEffects(staged: readonly OutboxEffect[]): Promise<number> {
  let failures = 0;
  for (const effect of staged) {
    try {
      await effect();
    } catch {
      failures += 1;
    }
  }
  return failures;
}

function event(band: number, overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  return {
    id: 'evt-1',
    organizationId: 'org-1',
    type: 'usage.threshold_reached.v1',
    schemaVersion: 1,
    aggregateType: 'usage_counter',
    aggregateId: 'counter-1',
    payload: {
      organizationId: 'org-1',
      band,
      used: 8_000_000_000,
      reserved: 500_000_000,
      quota: 10_000_000_000,
      idempotencyKey: `counter-1:${band}:7`,
    },
    correlationId: null,
    occurredAt: new Date(),
    attempts: 1,
    ...overrides,
  };
}

const MEMBERS: readonly Membership[] = [
  { user_id: 'owner-1', role: 'owner', has_org_wide_scope: 1 },
  { user_id: 'admin-1', role: 'org_admin', has_org_wide_scope: 1 },
  { user_id: 'member-1', role: 'member', has_org_wide_scope: 1 },
];

describe('createUsageThresholdMail', () => {
  it('fans out to org-wide owner/admin and skips a recipient who turned mail off (§1, §2)', async () => {
    const { tx } = fakeTx(MEMBERS, {
      'owner-1': recipient('owner@x'),
      'admin-1': recipient('admin@x', { email_enabled: 0 }),
    });
    const { effects, staged } = fakeEffects();
    const { mailer, sent } = fakeMailer();
    await createUsageThresholdMail(mailer)(event(85), tx, effects);
    await runEffects(staged);
    expect(sent.map((s) => s.recipientEmail)).toEqual(['owner@x']); // admin off; member not a recipient
  });

  it('bands 70/85/95 defer an in-quiet-hours recipient as their own resume row (§3)', async () => {
    const { tx, resumes } = fakeTx(MEMBERS, {
      'owner-1': recipient('owner@x', quietWindowAround()),
    });
    const { effects, staged } = fakeEffects();
    const { mailer, sent } = fakeMailer();
    await createUsageThresholdMail(mailer)(event(85), tx, effects);
    await runEffects(staged);
    expect(sent).toHaveLength(0);
    expect(resumes.map((r) => r.recipientUserId)).toEqual(['owner-1']);
  });

  it('band 100 bypasses quiet hours and sends immediately (§3, critical)', async () => {
    const { tx, resumes } = fakeTx(MEMBERS, {
      'owner-1': recipient('owner@x', quietWindowAround()),
    });
    const { effects, staged } = fakeEffects();
    const { mailer, sent } = fakeMailer();
    await createUsageThresholdMail(mailer)(event(100), tx, effects);
    await runEffects(staged);
    expect(resumes).toHaveLength(0);
    expect(sent.map((s) => s.recipientEmail)).toEqual(['owner@x']);
  });

  it('isolates one recipient mail failure from the others (§4)', async () => {
    const { tx } = fakeTx(MEMBERS, {
      'owner-1': recipient('owner@x'),
      'admin-1': recipient('admin@x'),
    });
    const { effects, staged } = fakeEffects();
    const { mailer, sent } = fakeMailer('owner@x');
    await createUsageThresholdMail(mailer)(event(85), tx, effects);
    const failures = await runEffects(staged);
    expect(failures).toBe(1);
    expect(sent.map((s) => s.recipientEmail)).toEqual(['admin@x']); // the other still sent
  });
});

function resumeEventFor(recipientUserId: string): ClaimedOutboxEvent {
  return event(85, {
    type: QUIET_HOURS_MAIL_RESUME_TYPE,
    payload: {
      originalType: 'usage.threshold_reached.v1',
      originalPayload: {
        band: 85,
        used: 8_000_000_000,
        reserved: 500_000_000,
        quota: 10_000_000_000,
      },
      recipientUserId,
    },
  });
}

describe('createUsageThresholdMailResume', () => {
  it('sends to the one named recipient after the window, re-reading the mail toggle', async () => {
    const { tx } = fakeTx(MEMBERS, { 'owner-1': recipient('owner@x', quietWindowAround()) });
    const { effects, staged } = fakeEffects();
    const { mailer, sent } = fakeMailer();
    await createUsageThresholdMailResume(mailer)(resumeEventFor('owner-1'), tx, effects);
    await runEffects(staged);
    expect(sent.map((s) => s.recipientEmail)).toEqual(['owner@x']); // window already waited out
  });

  // F58 regression: deferred, then removed / demoted / scope lost before resume -> no send.
  it.each([
    ['was removed (no active membership)', [] as readonly Membership[]],
    ['was demoted to member', [{ user_id: 'admin-1', role: 'member', has_org_wide_scope: 1 }]],
    ['lost org-wide scope', [{ user_id: 'admin-1', role: 'org_admin', has_org_wide_scope: 0 }]],
    ['left while another user stays admin', [MEMBERS[0] as Membership]],
  ])('does not mail a recipient who %s during the deferral (F58)', async (_label, members) => {
    const { tx } = fakeTx(members, { 'admin-1': recipient('admin@x') });
    const { effects, staged } = fakeEffects();
    const { mailer, sent } = fakeMailer();
    await createUsageThresholdMailResume(mailer)(resumeEventFor('admin-1'), tx, effects);
    await runEffects(staged);
    expect(staged).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('still mails a recipient who is still an org-wide admin at resume (F58 control)', async () => {
    const { tx } = fakeTx(MEMBERS, { 'admin-1': recipient('admin@x') });
    const { effects, staged } = fakeEffects();
    const { mailer, sent } = fakeMailer();
    await createUsageThresholdMailResume(mailer)(resumeEventFor('admin-1'), tx, effects);
    await runEffects(staged);
    expect(sent.map((s) => s.recipientEmail)).toEqual(['admin@x']);
  });
});
