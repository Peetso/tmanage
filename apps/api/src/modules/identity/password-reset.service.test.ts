import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { PasswordResetMailer } from '../../common/email/password-reset-email.js';
import { composePasswordResetEmail } from '../../common/email/password-reset-email.js';
import type { CredentialsRepository } from './credentials.repository.js';
import { hashInvitationToken } from './invitation-token.js';
import type { PasswordResetRepository, ResetTarget } from './password-reset.repository.js';
import {
  PASSWORD_RESET_REVOCATION_REASON,
  PASSWORD_RESET_TTL_MINUTES,
  PasswordResetService,
} from './password-reset.service.js';
import type { SessionsRepository } from './sessions.repository.js';

/**
 * ACC-02: a locked-out person can reset their own password. The SQL is plain; what matters is
 * what the service decides — the same answer for known and unknown addresses, one live link,
 * a link that works once, every session ended, and the credential-change notice written.
 */

const CORR = '01a14fe5-ada6-7287-922a-9079a2b2b0cc';
const SARA: ResetTarget = {
  userId: '01a14fe5-ada6-7287-922a-9079a2b2b002',
  email: 'sara@example.com',
  displayName: 'Sara Nabil',
  locale: 'en',
};
const STRONG = 'violet-harbour-lantern-41';

function harness(options: { account?: ResetTarget | null; live?: boolean; spend?: boolean } = {}) {
  const runner = {};
  const database = {
    identityTransaction: (_o: unknown, work: (tx: unknown) => Promise<unknown>) => work(runner),
    identityRead: (_o: unknown, work: (tx: unknown) => Promise<unknown>) => work(runner),
  } as unknown as TenantDatabase;
  const resets = {
    findAccount: vi.fn(() =>
      Promise.resolve(options.account === undefined ? SARA : options.account),
    ),
    retireOpen: vi.fn(() => Promise.resolve()),
    create: vi.fn(() => Promise.resolve()),
    findLive: vi.fn(() => Promise.resolve(options.live === false ? null : SARA)),
    spend: vi.fn(() => Promise.resolve(options.spend !== false)),
  };
  const deliver = vi.fn(() => Promise.resolve('sent' as const));
  const credentials = {
    setPassword: vi.fn(() => Promise.resolve()),
    recordCredentialChange: vi.fn(() => Promise.resolve()),
  };
  const sessions = { revokeAllForUser: vi.fn(() => Promise.resolve(2)) };
  const service = new PasswordResetService(
    database,
    { deliver } as unknown as PasswordResetMailer,
    resets as unknown as PasswordResetRepository,
    credentials as unknown as CredentialsRepository,
    sessions as unknown as SessionsRepository,
    // F19 (wave 9): the bearer cutoff has its own regression in `wave9-s1-identity.test.ts`.
    { revokeAllForUser: () => Promise.resolve({ personalAccessTokens: 0, grants: 0 }) },
  );
  return { service, resets, deliver, credentials, sessions };
}

describe('PasswordResetService.request', () => {
  it('retires older links, stores only a hash, and mails the newest link', async () => {
    const { service, resets, deliver } = harness();

    const { delivery } = await service.request(' Sara@Example.com ', { correlationId: CORR });
    await delivery;

    expect(resets.findAccount).toHaveBeenCalledWith({}, 'sara@example.com');
    expect(resets.retireOpen).toHaveBeenCalledWith({}, SARA.userId);
    const created = resets.create.mock.calls[0] as unknown as [
      unknown,
      { tokenHash: string; ttlMinutes: number },
    ];
    expect(created[1].ttlMinutes).toBe(PASSWORD_RESET_TTL_MINUTES);
    const sent = deliver.mock.calls[0] as unknown as [{ token: string; to: string }];
    expect(sent[0].to).toBe('sara@example.com');
    // The row holds the hash of exactly the token that was mailed, never the token.
    expect(created[1].tokenHash).toBe(hashInvitationToken(sent[0].token));
    expect(created[1].tokenHash).not.toBe(sent[0].token);
  });

  it('answers the same for an unknown address and sends nothing', async () => {
    const { service, resets, deliver } = harness({ account: null });

    await expect(service.request('nobody@example.com', { correlationId: CORR })).resolves.toEqual({
      delivery: expect.any(Promise),
    });
    expect(resets.create).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not even look up a malformed address', async () => {
    const { service, resets } = harness();
    await service.request('not-an-email', { correlationId: CORR });
    expect(resets.findAccount).not.toHaveBeenCalled();
  });
});

describe('PasswordResetService.complete', () => {
  const TOKEN = 'B'.repeat(43);

  it('spends the link, replaces the password, ends every session and records the change', async () => {
    const { service, resets, credentials, sessions } = harness();

    await service.complete(TOKEN, STRONG, { correlationId: CORR });

    expect(resets.spend).toHaveBeenCalledWith({}, hashInvitationToken(TOKEN));
    expect(credentials.setPassword).toHaveBeenCalledWith(
      {},
      SARA.userId,
      expect.stringMatching(/^\$argon2id\$/u),
    );
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
      {},
      SARA.userId,
      PASSWORD_RESET_REVOCATION_REASON,
    );
    expect(credentials.recordCredentialChange).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ userId: SARA.userId, action: 'password_set' }),
    );
  });

  it('refuses an unknown, used or expired link with one 404', async () => {
    const { service, credentials } = harness({ live: false });
    const error = await service.complete(TOKEN, STRONG, { correlationId: CORR }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(credentials.setPassword).not.toHaveBeenCalled();
  });

  it('refuses the loser of a race for one link (the compare-and-set failed)', async () => {
    const { service, credentials } = harness({ spend: false });
    const error = await service.complete(TOKEN, STRONG, { correlationId: CORR }).catch((e) => e);
    expect((error as ApiError).status).toBe(404);
    expect(credentials.setPassword).not.toHaveBeenCalled();
  });

  it('refuses a malformed token without reading anything', async () => {
    const { service, resets } = harness();
    const error = await service.complete('x', STRONG, { correlationId: CORR }).catch((e) => e);
    expect((error as ApiError).status).toBe(404);
    expect(resets.findLive).not.toHaveBeenCalled();
  });

  it('refuses a weak password with field errors and leaves the link live', async () => {
    const { service, resets } = harness();
    const error = await service.complete(TOKEN, 'short', { correlationId: CORR }).catch((e) => e);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).details?.[0]?.field).toBe('password');
    expect(resets.spend).not.toHaveBeenCalled();
  });
});

describe('composePasswordResetEmail', () => {
  it('says the link works once and expires, with one button whose href is the printed link', () => {
    const link = 'https://tmanage.example/recover/tok123';
    const message = composePasswordResetEmail({
      to: 'sara@example.com',
      displayName: 'Sara',
      link,
      ttlMinutes: 30,
    });
    expect(message.subject).toBe('Reset your TManage password');
    expect(message.text).toContain(`Choose a new password: ${link}`);
    expect(message.text).toContain('expires in 30 minutes');
    const hrefs = [...(message.html ?? '').matchAll(/href="([^"]*)"/gu)].map((m) => m[1]);
    expect(hrefs).toEqual([link, link]);
  });
});
