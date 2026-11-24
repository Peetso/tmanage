import { describe, expect, it } from 'vitest';
import type { SessionIntelReader } from '../../identity/geo/session-intel.service.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository, PlatformAuditInput } from '../platform-admin.repository.js';
import { isPlatformAuditAction } from '../platform-audit-actions.js';
import type { PersonRow, PlatformPeopleRepository } from './people.repository.js';
import {
  PLATFORM_CONFIRMATION_BATCH,
  PlatformPeopleService,
  type ConfirmationSender,
} from './people.service.js';

/**
 * RESENDVERIFY (2026-11-24). Owner: "I want to send a verification email to the old unverified
 * people." The resend reuses the identity confirmation sender; every send is audited with who,
 * whom and the result; the bulk send is capped and says how many it did not reach.
 */

const PERSON = '0199aa00-0000-7000-8000-0000000000d1';
const ctx = { correlationId: 'c-1', ip: '41.33.10.8', userAgent: 'Firefox' };
const actor: PlatformAdminActor = {
  account: {
    userId: '0199aa00-0000-7000-8000-0000000000a1',
    email: 'peter@peetrix.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
};

function harness(options: {
  person?: boolean;
  status?: (userId: string) => 'sent' | 'already_confirmed' | 'not_sent';
  unconfirmed?: number;
}) {
  const audits: PlatformAuditInput[] = [];
  const sends: string[] = [];
  const limits: number[] = [];
  const platform = {
    recordAudit: async (audit: PlatformAuditInput) => {
      audits.push(audit);
    },
  } as unknown as PlatformAdminRepository;
  const people = {
    findPerson: async (id: string) =>
      options.person === false ? null : ({ userId: id, email: 'maya@example.com' } as PersonRow),
  } as unknown as PlatformPeopleRepository;
  const total = options.unconfirmed ?? 3;
  const sender: ConfirmationSender = {
    requestForAccount: async (userId) => {
      sends.push(userId);
      return options.status?.(userId) ?? 'sent';
    },
    unconfirmedAccounts: async (limit) => {
      limits.push(limit);
      return Array.from({ length: Math.min(limit, total) }, (_, i) => ({
        userId: `u-${i}`,
        email: `p${i}@example.com`,
      }));
    },
    countUnconfirmed: async () => total,
  };
  const service = new PlatformPeopleService(
    platform,
    people,
    { request: async () => undefined },
    { notify: async () => undefined },
    () => new Date('2026-11-24T10:00:00Z'),
    {} as SessionIntelReader,
    sender,
  );
  return { service, audits, sends, limits };
}

describe('POST /v1/platform/people/:userId/email-confirmation', () => {
  it('sends the link and audits who, whom and the result', async () => {
    const h = harness({});
    expect(await h.service.sendEmailConfirmation(actor, PERSON, {}, ctx)).toEqual({
      status: 'sent',
    });
    expect(h.sends).toEqual([PERSON]);
    expect(h.audits).toHaveLength(1);
    const [audit] = h.audits;
    expect([
      audit!.action,
      audit!.actorEmail,
      audit!.targetId,
      audit!.targetLabel,
      audit!.reason,
      audit!.afterJson,
    ]).toEqual([
      'platform.email_confirmation_sent',
      'peter@peetrix.com',
      PERSON,
      'maya@example.com',
      null,
      JSON.stringify({ result: 'sent' }),
    ]);
  });

  it('audits a send that did not go out with its result', async () => {
    const h = harness({ status: () => 'already_confirmed' });
    const answer = await h.service.sendEmailConfirmation(actor, PERSON, { reason: 'Asked' }, ctx);
    expect(answer.status).toBe('already_confirmed');
    expect([h.audits[0]!.reason, h.audits[0]!.afterJson]).toEqual([
      'Asked',
      JSON.stringify({ result: 'already_confirmed' }),
    ]);
  });

  it('answers 404 for a bad id or an unknown person, and sends nothing', async () => {
    const bad = harness({});
    await expect(bad.service.sendEmailConfirmation(actor, 'nope', {}, ctx)).rejects.toMatchObject({
      status: 404,
    });
    const unknown = harness({ person: false });
    await expect(
      unknown.service.sendEmailConfirmation(actor, PERSON, {}, ctx),
    ).rejects.toMatchObject({ status: 404 });
    expect([...bad.sends, ...unknown.sends, ...bad.audits, ...unknown.audits]).toEqual([]);
  });
});

describe('POST /v1/platform/people/email-confirmations (bulk)', () => {
  it('mails every unconfirmed account, counts each result and audits each send', async () => {
    const h = harness({
      unconfirmed: 3,
      status: (id) => (id === 'u-1' ? 'already_confirmed' : id === 'u-2' ? 'not_sent' : 'sent'),
    });
    const result = await h.service.sendEmailConfirmations(actor, {}, ctx);
    expect(result).toEqual({
      sent: 1,
      alreadyConfirmed: 1,
      notSent: 1,
      batchCap: PLATFORM_CONFIRMATION_BATCH,
      notReached: 0,
    });
    const perPerson = h.audits.filter((a) => a.action === 'platform.email_confirmation_sent');
    expect(perPerson.map((a) => [a.targetId, a.targetLabel, a.afterJson]).sort()).toEqual([
      ['u-0', 'p0@example.com', JSON.stringify({ result: 'sent', bulk: true })],
      ['u-1', 'p1@example.com', JSON.stringify({ result: 'already_confirmed', bulk: true })],
      ['u-2', 'p2@example.com', JSON.stringify({ result: 'not_sent', bulk: true })],
    ]);
    const summary = h.audits.filter((a) => a.action === 'platform.email_confirmations_sent');
    expect(summary.map((a) => [a.targetType, a.afterJson])).toEqual([
      ['platform', JSON.stringify(result)],
    ]);
  });

  it('stops at the cap and says how many it did not reach', async () => {
    const h = harness({ unconfirmed: PLATFORM_CONFIRMATION_BATCH + 40 });
    const result = await h.service.sendEmailConfirmations(actor, {}, ctx);
    expect(h.limits).toEqual([PLATFORM_CONFIRMATION_BATCH]);
    expect(h.sends).toHaveLength(PLATFORM_CONFIRMATION_BATCH);
    expect([result.sent, result.batchCap, result.notReached]).toEqual([
      PLATFORM_CONFIRMATION_BATCH,
      PLATFORM_CONFIRMATION_BATCH,
      40,
    ]);
  });

  it('reports the count the confirm dialog states', async () => {
    const h = harness({ unconfirmed: 17 });
    expect(await h.service.emailConfirmationBacklog(ctx)).toEqual({
      unverified: 17,
      batchCap: PLATFORM_CONFIRMATION_BATCH,
    });
    expect(h.sends).toEqual([]);
  });

  it('uses audit action names the action log can offer', () => {
    expect(isPlatformAuditAction('platform.email_confirmation_sent')).toBe(true);
    expect(isPlatformAuditAction('platform.email_confirmations_sent')).toBe(true);
  });
});
