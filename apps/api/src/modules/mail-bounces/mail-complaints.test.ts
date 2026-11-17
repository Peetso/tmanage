import { describe, expect, it, vi } from 'vitest';
import {
  BounceGuardMailer,
  MailRecipientSuppressedError,
  bounceMessageId,
  deriveBounceKey,
  emailAddressHash,
} from '@tmanage/mail';
import type { BounceSuppressionLookup, MailMessage } from '@tmanage/mail';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { MailBouncesService } from './mail-bounces.service.js';

const noAudit = { record: vi.fn() } as unknown as ConstructorParameters<
  typeof MailBouncesService
>[2];
const KEY = deriveBounceKey('s'.repeat(48));
const ORG_A = '0192f3a4-5b6c-7d8e-9f01-23456789aaaa';
const ORG_B = '0192f3a4-5b6c-7d8e-9f01-23456789bbbb';
const NOW = new Date('2026-11-17T10:00:00.000Z');
const ANN = 'ann@client.example';

/** An RFC 5965 ARF spam complaint returning the original headers. */
function complaint(messageId: string, rcptTo = `<${ANN}>`) {
  return Buffer.from(
    [
      'Content-Type: multipart/report; report-type=feedback-report; boundary="fb"',
      '',
      '--fb',
      'Content-Type: message/feedback-report',
      '',
      'Feedback-Type: abuse',
      'Version: 1',
      `Original-Rcpt-To: ${rcptTo}`,
      '',
      '--fb',
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: ${messageId}`,
      '--fb--',
    ].join('\r\n'),
  );
}

/** A database that keeps every statement with the organization of the context it ran under. */
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

describe('56-26 ARF spam complaints', () => {
  const ours = bounceMessageId(KEY, { organizationId: ORG_A, to: ANN, domain: 'tm.io' }) as string;

  it('never suppresses from a forged complaint: another workspace, another address', async () => {
    const { database, statements } = fakeDatabase();
    const service = new MailBouncesService(database, KEY, noAudit, undefined, () => NOW);
    // The company in the signed id swapped for another workspace: the signature no longer holds.
    await expect(service.record(complaint(ours.replace(ORG_A, ORG_B)), 'c')).resolves.toBe(
      'unmatched',
    );
    // A genuine id but the report names someone else: the claim can only make the match fail.
    await expect(service.record(complaint(ours, '<boss@client.example>'), 'c')).resolves.toBe(
      'unmatched',
    );
    expect(statements).toHaveLength(0);
  });

  it('suppresses the signed address in its company, then stops non-essential mail only', async () => {
    const { database, statements } = fakeDatabase();
    const service = new MailBouncesService(database, KEY, noAudit, undefined, () => NOW);
    await expect(service.record(complaint(ours), 'c')).resolves.toBe('suppressed');
    expect(statements.every((s) => s.org === ORG_A && s.params.includes(ORG_A))).toBe(true);
    const insert = statements.find((s) => /^\s*insert/iu.test(s.sql));
    expect(insert?.params).toEqual(expect.arrayContaining([emailAddressHash(ANN), 'complaint']));

    // The guard reads what the complaint wrote.
    const lookup: BounceSuppressionLookup = {
      isBounceSuppressed: (org, hash) =>
        Promise.resolve(insert !== undefined && org === ORG_A && insert.params.includes(hash)),
    };
    const inner = { send: vi.fn(() => Promise.resolve('sent' as const)) };
    const guard = new BounceGuardMailer(inner, lookup);
    const invite: MailMessage = {
      to: ANN,
      subject: 's',
      text: 't',
      templateKey: 'invitation',
      organizationId: ORG_A,
    };
    await expect(guard.send(invite)).rejects.toBeInstanceOf(MailRecipientSuppressedError);
    await guard.send({ ...invite, organizationId: ORG_B });
    await guard.send({ ...invite, templateKey: 'password_reset' });
    expect(inner.send).toHaveBeenCalledTimes(2);
  });
});
