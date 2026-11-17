import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { bounceMessageId, deriveBounceKey, emailAddressHash } from '@tmanage/mail';
import { ApiError } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { MailRecipientBounceRow } from '../../common/database/schema.js';
import { BounceIntakeController } from './bounce-intake.controller.js';
import { MailBounceLookup, MailBouncesService, nextBounceState } from './mail-bounces.service.js';

const AUDIT = { record: vi.fn(() => Promise.resolve({})) };
const noAudit = AUDIT as unknown as ConstructorParameters<typeof MailBouncesService>[2];

const SECRET = 'w'.repeat(40);
const KEY = deriveBounceKey('s'.repeat(48));
const ORG_A = '0192f3a4-5b6c-7d8e-9f01-23456789aaaa';
const NOW = new Date('2026-11-17T10:00:00.000Z');

function report(messageId: string, status = '5.1.1', recipient = 'someone@victim.example') {
  return Buffer.from(
    [
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
      '',
      '--b',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example',
      '',
      `Final-Recipient: rfc822; ${recipient}`,
      'Action: failed',
      `Status: ${status}`,
      '',
      '--b',
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: ${messageId}`,
      '--b--',
    ].join('\r\n'),
  );
}

/** A database that records every statement with the organization of the context it ran under. */
function fakeDatabase() {
  const statements: { org: string; sql: string; params: readonly unknown[] }[] = [];
  const runnerFor = (context: TenantContext) =>
    ({
      query: (sql: string, params: readonly unknown[] = []) => {
        statements.push({ org: context.organizationId, sql, params });
        return Promise.resolve(/^\s*select/iu.test(sql) ? [] : { affectedRows: 1, insertId: 0 });
      },
    }) as unknown as TenantQueryRunner;
  const database = {
    transaction: (context: TenantContext, work: (tx: TenantQueryRunner) => Promise<unknown>) =>
      work(runnerFor(context)),
    read: (context: TenantContext, work: (tx: TenantQueryRunner) => Promise<unknown>) =>
      work(runnerFor(context)),
  } as unknown as TenantDatabase;
  return { database, statements };
}

function signedRequest(body: Buffer, secret = SECRET) {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return {
    headers: { 'x-inbound-timestamp': timestamp, 'x-inbound-signature': `v1=${signature}` },
    rawBody: body,
  };
}

describe('56-26 bounce intake authentication', () => {
  const record = vi.fn(() => Promise.resolve('recorded' as const));
  const controller = new BounceIntakeController({ record } as unknown as MailBouncesService, {
    secret: SECRET,
    now: () => NOW,
  });

  it('(a) refuses an unsigned, wrongly signed or stale bounce before reading it', async () => {
    const body = report('<x@y>');
    const forged = signedRequest(body, 'f'.repeat(40));
    const stale = signedRequest(body);
    const old = {
      ...stale.headers,
      'x-inbound-timestamp': String(Number(stale.headers['x-inbound-timestamp']) - 600),
    };
    for (const request of [{ headers: {}, rawBody: body }, forged, { ...stale, headers: old }]) {
      await expect(controller.receive(request)).rejects.toMatchObject({ status: 401 });
    }
    expect(record).not.toHaveBeenCalled();
    await expect(controller.receive(signedRequest(body))).resolves.toEqual({ status: 'accepted' });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('is off (404) without a configured secret', async () => {
    const off = new BounceIntakeController({ record } as unknown as MailBouncesService, {
      secret: null,
    });
    await expect(off.receive(signedRequest(report('<x@y>')))).rejects.toBeInstanceOf(ApiError);
  });
});

describe('56-26 bounce matching and company scope', () => {
  const ours = bounceMessageId(KEY, {
    organizationId: ORG_A,
    to: 'ann@client.example',
    domain: 'tm.io',
  }) as string;

  it('(b) ignores a quoted id that is not signed by our key, whatever the report names', async () => {
    const { database, statements } = fakeDatabase();
    const service = new MailBouncesService(database, KEY, noAudit, undefined, () => NOW);
    const forged = ours.replace(/\.[A-Za-z0-9_-]{22}@/u, `.${'A'.repeat(22)}@`);
    await expect(service.record(report(forged), 'c')).resolves.toBe('unmatched');
    const foreignKey = new MailBouncesService(database, deriveBounceKey('o'.repeat(48)), noAudit);
    await expect(foreignKey.record(report(ours), 'c')).resolves.toBe('unmatched');
    expect(statements).toHaveLength(0);
  });

  it('(c) records under the signed company and address, never the Final-Recipient', async () => {
    const { database, statements } = fakeDatabase();
    const service = new MailBouncesService(database, KEY, noAudit, undefined, () => NOW);
    await expect(service.record(report(ours), 'c')).resolves.toBe('suppressed');
    const hash = emailAddressHash('ann@client.example');
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.org).toBe(ORG_A);
      expect(statement.sql).toMatch(/organization_id/u);
      expect(statement.params).toContain(ORG_A);
      expect(statement.params).not.toContain(emailAddressHash('someone@victim.example'));
    }
    expect(statements.some((s) => s.params.includes(hash))).toBe(true);

    statements.length = 0;
    await new MailBounceLookup(database).isBounceSuppressed(ORG_A, hash);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ org: ORG_A });
    expect(statements[0]?.params).toContain(ORG_A);
  });
});

describe('56-26 nextBounceState', () => {
  const row = (over: Partial<MailRecipientBounceRow>): MailRecipientBounceRow => ({
    organizationId: ORG_A,
    addressHash: 'h',
    hardCount: 0,
    softCount: 0,
    lastKind: 'soft',
    lastStatus: '4.4.7',
    lastMessageRef: 'r1',
    lastBouncedAt: NOW,
    suppressedAt: null,
    clearedAt: null,
    clearedByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  const soft = { kind: 'soft' as const, status: '4.4.7' };

  it('suppresses at the third soft bounce, counts a message once, escalates soft to hard', () => {
    expect(nextBounceState(row({ softCount: 1 }), soft, 'r1', NOW)).toBeNull();
    expect(nextBounceState(row({ softCount: 1 }), soft, 'r2', NOW)?.suppressedAt).toBeNull();
    expect(nextBounceState(row({ softCount: 2 }), soft, 'r3', NOW)?.suppressedAt).toEqual(NOW);
    const hard = nextBounceState(
      row({ softCount: 1 }),
      { kind: 'hard', status: '5.1.1' },
      'r1',
      NOW,
    );
    expect(hard).toMatchObject({ hardCount: 1, softCount: 0, suppressedAt: NOW });
    const later = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(nextBounceState(row({ softCount: 2 }), soft, 'r4', later)).toMatchObject({
      softCount: 1,
      suppressedAt: null,
    });
  });
});

describe('56-26 clearing a suppression', () => {
  it('is audited as mail_bounce.cleared in the admin company, with no address in it', async () => {
    const { database, statements } = fakeDatabase();
    const record = vi.fn(() => Promise.resolve({}));
    const service = new MailBouncesService(
      database,
      KEY,
      { record } as unknown as ConstructorParameters<typeof MailBouncesService>[2],
      undefined,
      () => NOW,
    );
    const context = { organizationId: ORG_A, userId: ORG_A } as TenantContext;
    const principal = {
      userId: ORG_A,
      organizationId: ORG_A,
      kind: 'internal',
      role: 'owner',
      membershipId: 'm-1',
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: true,
    } as unknown as Parameters<MailBouncesService['clear']>[1];
    await expect(
      service.clear(context, principal, { address: 'ann@client.example' }),
    ).resolves.toMatchObject({ status: 'clear' });
    expect(record).toHaveBeenCalledWith(expect.anything(), context, {
      action: 'mail_bounce.cleared',
      result: 'allowed',
      objectId: null,
      metadata: { was_suppressed: false },
    });
    expect(statements.every((s) => s.org === ORG_A)).toBe(true);
  });
});
