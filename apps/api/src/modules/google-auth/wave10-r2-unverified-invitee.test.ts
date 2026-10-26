import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { IdentityQueryRunner } from '../../common/database/tenant-context.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import type { SignupAccountsRepository } from '../signup/signup-accounts.repository.js';
import { InviteeAccountsRepository } from '../tenancy/invitee-accounts.repository.js';
import { GoogleAuthService, type InvitationsPort } from './google-auth.service.js';
import { newFlow, type GoogleClaims } from './google-oidc.js';
import type { UserIdentitiesRepository } from './user-identities.repository.js';

/**
 * Wave 10 lane R2, audit F03 / NV04 — the end of the exploit chain.
 *
 * An inviter (who receives the raw invitation token) registers `victim@x.example` through
 * `POST /v1/invitations/registrations` and so pre-owns the account. When the real mailbox owner
 * later signs in with Google, `findOrLink` must not merge their Google identity into that
 * account. Before the fix the registration stamped `email_verified_at`, so the link went
 * through; now the account is unverified and Google answers `unverified_account`, linking
 * nothing. The `users` row here is the one `InviteeAccountsRepository.insertUser` really writes.
 */

const NOW = 1_800_000_000;
const CORR = '0199aa00-0000-7000-8000-0000000000d1';
const VICTIM = 'victim@x.example';
const PRE_OWNED = '0199aa00-0000-7000-8000-0000000000a1';

/** Runs the real insert against a capturing runner and reads back email_verified_at. */
async function registeredRow(): Promise<{ userId: string; emailVerifiedAt: Date | null }> {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const runner = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      return { affectedRows: 1, insertId: 0 };
    }),
  } as unknown as IdentityQueryRunner;
  await new InviteeAccountsRepository().insertUser(runner, {
    id: PRE_OWNED,
    email: VICTIM,
    displayName: 'Victim',
    locale: 'en',
    timezone: 'UTC',
  });
  const insert = statements.find((statement) => /insert into `users`/iu.test(statement.sql));
  if (!insert) throw new Error('no users insert');
  const match = /insert into `users` \((.+?)\) values \((.+)\)/iu.exec(insert.sql);
  if (!match) throw new Error('unexpected insert shape');
  const columns = match[1]!.split(',').map((column) => column.trim().replaceAll('`', ''));
  const values = match[2]!.split(/,(?![^(]*\))/u).map((value) => value.trim());
  const params = [...insert.params];
  let verified: unknown = null;
  columns.forEach((column, index) => {
    const value = values[index] ?? '';
    const resolved =
      value === '?' ? params.shift() : /^(?:null|default)$/iu.test(value) ? null : value;
    if (column === 'email_verified_at') verified = resolved;
  });
  // Anything but NULL (a timestamp expression or a value) is a verified address.
  return { userId: PRE_OWNED, emailVerifiedAt: verified === null ? null : new Date() };
}

function serviceFor(account: { userId: string; emailVerifiedAt: Date | null }) {
  const runner = {};
  const database = {
    identityTransaction: vi.fn(async (_o: unknown, work: (r: unknown) => unknown) => work(runner)),
    identityRead: vi.fn(async (_o: unknown, work: (r: unknown) => unknown) => work(runner)),
  } as unknown as TenantDatabase;
  const link = vi.fn(async () => undefined);
  const identities = {
    findUserBySubject: vi.fn(async () => null),
    findUserByEmail: vi.fn(async (_r: unknown, email: string) =>
      email === VICTIM ? account : null,
    ),
    link,
    touch: vi.fn(async () => undefined),
  } as unknown as UserIdentitiesRepository;
  const events: { outcome: string; reason: string | null }[] = [];
  const credentials = {
    listActiveFactors: vi.fn(async () => []),
    recordAuthenticationEvent: vi.fn(
      async (_r: unknown, event: { outcome: string; reason: string | null }) => {
        events.push(event);
      },
    ),
  } as unknown as CredentialsRepository;
  const accept = vi.fn(async () => ({}));
  const invitations: InvitationsPort = {
    preview: vi.fn(async () => ({ inviteeEmail: VICTIM })),
    accept,
  };
  const insertUser = vi.fn(async () => undefined);
  const service = new GoogleAuthService({
    database,
    credentials,
    invitations,
    signup: null,
    sessionSecret: 'session-secret-for-google-tests-0123456789',
    identities,
    accounts: { insertUser } as unknown as SignupAccountsRepository,
    now: () => NOW * 1000,
  });
  return { service, link, accept, insertUser, events };
}

const CLAIMS: GoogleClaims = { subject: 'victim-google-sub', email: VICTIM, name: 'Victim' };

describe('F03 / NV04: Google never links into an invitation-registered account', () => {
  it('the registered row is unverified', async () => {
    expect((await registeredRow()).emailVerifiedAt).toBeNull();
  });

  it('sign-in with victim@x claims -> unverified_account, nothing linked', async () => {
    const h = serviceFor(await registeredRow());
    await expect(
      h.service.complete(newFlow('sign-in', {}, NOW), CLAIMS, { correlationId: CORR }),
    ).resolves.toEqual({ kind: 'refused', reason: 'unverified_account' });
    expect(h.link).not.toHaveBeenCalled();
    expect(h.events).toContainEqual(
      expect.objectContaining({ outcome: 'failed', reason: 'google_unverified_account' }),
    );
  });

  it('the invitation flow refuses the same way, accepting and creating nothing', async () => {
    const h = serviceFor(await registeredRow());
    await expect(
      h.service.complete(newFlow('invitation', { invitationToken: 'i'.repeat(43) }, NOW), CLAIMS, {
        correlationId: CORR,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'unverified_account' });
    expect(h.link).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.insertUser).not.toHaveBeenCalled();
  });
});
