import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { MailMessage } from '@tmanage/mail';
import {
  composeEmailConfirmationEmail,
  PasswordResetMailer,
} from '../../common/email/password-reset-email.js';
import { hashInvitationToken } from './invitation-token.js';
import type { PasswordResetRepository } from './password-reset.repository.js';
import {
  createPasswordResetMailBudget,
  EmailConfirmationService,
  PASSWORD_RESET_TTL_MINUTES,
} from './password-reset.service.js';

/**
 * VERIFYMAIL (2026-11-16): a password sign-up could never confirm its address except through a
 * password reset, so the owner on PLATFORM_ADMIN_EMAILS could not open Platform admin.
 */
const CONTEXT = { correlationId: 'c-1' };

function harness(account: { emailVerified: boolean } | null, spendResult = true) {
  const created: { userId: string; tokenHash: string; ttlMinutes: number }[] = [];
  const spent: string[] = [];
  const retired: string[] = [];
  const repository = {
    findConfirmationTarget: vi.fn(async () =>
      account === null
        ? null
        : {
            userId: 'u-1',
            email: 'owner@example.com',
            displayName: 'Owner',
            locale: 'en',
            emailVerified: account.emailVerified,
          },
    ),
    retireOpen: vi.fn(async (_tx: unknown, userId: string) => {
      retired.push(userId);
    }),
    create: vi.fn(async (_tx: unknown, input: (typeof created)[number]) => {
      created.push(input);
    }),
    spend: vi.fn(async (_tx: unknown, tokenHash: string) => {
      spent.push(tokenHash);
      return spendResult;
    }),
  } as unknown as PasswordResetRepository;
  const database = {
    identityTransaction: async (_options: unknown, run: (tx: unknown) => unknown) => run({}),
  } as unknown as TenantDatabase;
  const mails: { to: string; token: string; ttlMinutes: number }[] = [];
  const mailer = {
    deliverConfirmation: vi.fn(async (facts: (typeof mails)[number]) => {
      mails.push(facts);
      return 'sent' as const;
    }),
  } as unknown as PasswordResetMailer;
  const service = new EmailConfirmationService(
    database,
    mailer,
    repository,
    createPasswordResetMailBudget(),
  );
  return { service, created, spent, retired, mails };
}

describe('EmailConfirmationService.request (signed in, own address only)', () => {
  it('mails a single-use link stored only as its hash, to the account address', async () => {
    const h = harness({ emailVerified: false });
    expect(await h.service.request('u-1', CONTEXT)).toBe('sent');
    expect(h.retired).toEqual(['u-1']);
    expect(h.created).toHaveLength(1);
    expect(h.mails).toHaveLength(1);
    const [mail] = h.mails;
    const [row] = h.created;
    expect([mail!.to, mail!.ttlMinutes, row!.tokenHash, row!.ttlMinutes]).toEqual([
      'owner@example.com',
      PASSWORD_RESET_TTL_MINUTES,
      hashInvitationToken(mail!.token),
      PASSWORD_RESET_TTL_MINUTES,
    ]);
    expect(row!.tokenHash).not.toBe(mail!.token);
  });

  it('sends nothing for a confirmed address or an unknown account', async () => {
    const confirmed = harness({ emailVerified: true });
    const unknown = harness(null);
    expect([
      await confirmed.service.request('u-1', CONTEXT),
      await unknown.service.request('u-x', CONTEXT),
      confirmed.mails.length + unknown.mails.length,
    ]).toEqual(['already_confirmed', 'not_sent', 0]);
  });

  it('stops after three mails an hour to the same address', async () => {
    const h = harness({ emailVerified: false });
    const answers = [];
    for (let i = 0; i < 4; i += 1) answers.push(await h.service.request('u-1', CONTEXT));
    expect([answers, h.mails.length]).toEqual([['sent', 'sent', 'sent', 'not_sent'], 3]);
  });
});

describe('EmailConfirmationService.complete (public, confirms only)', () => {
  it('spends the link by its hash; an unknown, used or expired link is a 404', async () => {
    const token = 'A'.repeat(43);
    const ok = harness({ emailVerified: false }, true);
    await ok.service.complete(token, CONTEXT);
    expect(ok.spent).toEqual([hashInvitationToken(token)]);

    const used = harness({ emailVerified: false }, false);
    await expect(used.service.complete(token, CONTEXT)).rejects.toMatchObject({ status: 404 });
    await expect(used.service.complete('short', CONTEXT)).rejects.toMatchObject({ status: 404 });
    await expect(used.service.complete(undefined, CONTEXT)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the confirmation e-mail', () => {
  it('says what it does, carries the link, and promises no sign-in', () => {
    const mail = composeEmailConfirmationEmail({
      to: 'owner@example.com',
      displayName: 'Owner',
      link: 'https://tmanage.example/confirm-email/TOKEN',
      ttlMinutes: 30,
      locale: 'en',
    });
    expect([
      mail.subject,
      mail.text.includes('https://tmanage.example/confirm-email/TOKEN'),
      mail.text.includes('expires in 30 minutes'),
      mail.text.includes('does not change your password or sign you in'),
      mail.html.includes('https://tmanage.example/confirm-email/TOKEN'),
    ]).toEqual(['Confirm your e-mail for TManage', true, true, true, true]);
  });

  it('is written in Arabic for an Arabic account', () => {
    const mail = composeEmailConfirmationEmail({
      to: 'owner@example.com',
      displayName: 'Owner',
      link: 'https://tmanage.example/confirm-email/TOKEN',
      ttlMinutes: 30,
      locale: 'ar-EG',
    });
    expect(mail.subject).toBe('أكّد بريدك الإلكتروني في TManage');
  });

  it('links in the language of the mail, allow-listed, never the raw account locale (SMALLFIX 3)', async () => {
    const sent: MailMessage[] = [];
    const mailer = new PasswordResetMailer(
      {
        send: async (message: MailMessage) => {
          sent.push(message);
          return 'sent' as const;
        },
      },
      'https://tmanage.example/',
    );
    const facts = { to: 'owner@example.com', displayName: 'Owner', ttlMinutes: 30, token: 'TOKEN' };
    await mailer.deliverConfirmation({ ...facts, locale: 'ar-EG' });
    await mailer.deliverConfirmation({ ...facts, locale: 'ur-PK' });
    await mailer.deliverConfirmation({ ...facts, locale: 'x"><a href=//evil.example>' });
    expect(sent.map((mail) => mail.text.match(/https:\S+/u)?.[0])).toEqual([
      'https://tmanage.example/confirm-email/TOKEN?lang=ar',
      'https://tmanage.example/confirm-email/TOKEN?lang=ur',
      'https://tmanage.example/confirm-email/TOKEN?lang=en',
    ]);
  });
});
