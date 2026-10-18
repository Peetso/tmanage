import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvitationRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import type { ClientMembershipsRepository } from '../clients/client-memberships.repository.js';
import { InviteeAccountExistsError } from './invitee-accounts.repository.js';
import type { InviteeAccountsRepository } from './invitee-accounts.repository.js';
import type { InvitationsRepository } from './invitations.repository.js';
import type { MembershipsRepository } from './memberships.repository.js';
import {
  ACCOUNT_EXISTS_MESSAGE,
  ALREADY_MEMBER_MESSAGE,
  InvitationsService,
} from './invitations.service.js';

/**
 * The acceptance and registration paths, without a database.
 *
 * `apps/api/test/ten-003-invitations.db.test.ts` proves the SQL against a real server. This
 * file proves what the service decides around it — the two live failures the 2026-10-18
 * walkthroughs found:
 *
 * - **ACC-04.** Accepting while signed in to an account that already holds the membership hit
 *   `uq_memberships_org_user` and answered a bare 500, which `ID-03` rendered as "This
 *   invitation cannot be accepted any more". It must be a 409 that says "already a member".
 * - **ACC-01.** A brand-new invitee had no way to create an account. `register` creates it,
 *   from the invitation's own address, and grants the membership in the same transaction.
 *
 * And that every real refusal still refuses: a malformed or unknown token is 404 on both paths,
 * a weak password is 422, an address that already has an account is 409 — never a takeover.
 */

const TOKEN = 'A'.repeat(43);
const ORG = '01a14fe5-ada6-7287-922a-9079a2b2b004';
const OWNER = '01a14fe5-ada6-7287-922a-9079a2b2b001';
const USER = '01a14fe5-ada6-7287-922a-9079a2b2b002';
const CORR = '01a14fe5-ada6-7287-922a-9079a2b2b0cc';

const INVITATION: InvitationRow = {
  id: 'inv-1',
  organizationId: ORG,
  clientOrganizationId: null,
  email: 'sara@example.com',
  role: 'member',
  tokenHash: 'h'.repeat(64),
  status: 'pending',
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  invitedByUserId: OWNER,
  acceptedByUserId: null,
  acceptedAt: null,
  revokedAt: null,
  createdAt: new Date('2026-10-18T00:00:00Z'),
  updatedAt: new Date('2026-10-18T00:00:00Z'),
} as unknown as InvitationRow;

function duplicate(key: string): Error {
  return Object.assign(new Error(`Duplicate entry 'x' for key '${key}'`), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
  });
}

interface Harness {
  readonly service: InvitationsService;
  readonly insertUser: ReturnType<typeof vi.fn>;
  readonly setPassword: ReturnType<typeof vi.fn>;
  readonly invite: ReturnType<typeof vi.fn>;
  readonly markAccepted: ReturnType<typeof vi.fn>;
}

function harness(
  options: {
    readonly pending?: InvitationRow | undefined;
    readonly invite?: () => Promise<unknown>;
    readonly insertUser?: () => Promise<void>;
  } = {},
): Harness {
  const pending = 'pending' in options ? options.pending : INVITATION;
  const runner = {};
  const database = {
    bootstrapRead: (_options: unknown, work: (runner: unknown) => Promise<unknown>) => work(runner),
    identityRead: (_options: unknown, work: (runner: unknown) => Promise<unknown>) => work(runner),
    transaction: (_context: unknown, work: (runner: unknown) => Promise<unknown>) => work(runner),
    invitationRegistrationTransaction: (
      _options: unknown,
      work: (scope: unknown) => Promise<unknown>,
    ) => work({ identity: runner, tenant: () => runner }),
  } as unknown as TenantDatabase;

  const markAccepted = vi.fn(() => Promise.resolve({ ...INVITATION, status: 'accepted' }));
  const invitations = {
    findPendingByTokenHash: vi.fn(() => Promise.resolve(pending)),
    markAccepted,
  } as unknown as InvitationsRepository;

  const invite = vi.fn(
    options.invite ?? (() => Promise.resolve({ id: 'm-1', version: 1, role: 'member' })),
  );
  const memberships = {
    invite,
    transitionStatus: vi.fn(() => Promise.resolve({ id: 'm-1', role: 'member' })),
  } as unknown as MembershipsRepository;

  const insertUser = vi.fn(options.insertUser ?? (() => Promise.resolve()));
  const setPassword = vi.fn(() => Promise.resolve());

  const service = new InvitationsService(
    database,
    invitations,
    memberships,
    {} as ClientMembershipsRepository,
    undefined,
    undefined,
    {},
    { insertUser } as unknown as InviteeAccountsRepository,
    { setPassword } as unknown as CredentialsRepository,
  );
  return { service, insertUser, setPassword, invite, markAccepted };
}

async function refusal(work: Promise<unknown>): Promise<ApiError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('InvitationsService.accept', () => {
  it('ACC-04: says "already a member" (409) instead of a 500 when the membership exists', async () => {
    const { service } = harness({
      invite: () => Promise.reject(duplicate('uq_memberships_org_user')),
    });

    const error = await refusal(service.accept(TOKEN, OWNER, CORR));

    expect(error.status).toBe(409);
    expect(error.code).toBe('conflict');
    expect(error.message).toBe(ALREADY_MEMBER_MESSAGE);
    expect(error.details).toEqual([{ field: 'token', message: 'already_member' }]);
  });

  it('says the same for a client membership that already exists', async () => {
    const { service } = harness({
      invite: () => Promise.reject(duplicate('uq_client_memberships_identity')),
    });

    const error = await refusal(service.accept(TOKEN, OWNER, CORR));
    expect(error.status).toBe(409);
  });

  it('lets any other failure through untouched', async () => {
    const boom = new Error('connection lost');
    const { service } = harness({ invite: () => Promise.reject(boom) });

    await expect(service.accept(TOKEN, USER, CORR)).rejects.toBe(boom);
  });

  it('still refuses an unknown, used, revoked or expired token with the one 404', async () => {
    const { service } = harness({ pending: undefined });

    const error = await refusal(service.accept(TOKEN, USER, CORR));
    expect(error.status).toBe(404);
  });

  it('still refuses a malformed token without reading anything', async () => {
    const { service } = harness();

    const error = await refusal(service.accept('short', USER, CORR));
    expect(error.status).toBe(404);
  });
});

describe('InvitationsService.register (ACC-01)', () => {
  const strong = 'violet-harbour-lantern-41';

  it('creates the account from the invitation address, sets its password and joins', async () => {
    const { service, insertUser, setPassword, markAccepted } = harness();

    const result = await service.register(
      TOKEN,
      // An `email` in the body is ignored: the account is the invitation's address.
      { displayName: '  Sara Nabil ', password: strong, email: 'attacker@evil.test' } as never,
      CORR,
    );

    expect(insertUser).toHaveBeenCalledTimes(1);
    const user = insertUser.mock.calls[0]?.[1] as {
      email: string;
      displayName: string;
      id: string;
    };
    expect(user.email).toBe('sara@example.com');
    expect(user.displayName).toBe('Sara Nabil');
    expect(setPassword).toHaveBeenCalledWith({}, user.id, expect.stringMatching(/^\$argon2id\$/u));
    expect(markAccepted).toHaveBeenCalledWith({}, expect.anything(), 'inv-1', user.id);
    expect(result).toMatchObject({ userId: user.id, organizationId: ORG, role: 'member' });
  });

  it('refuses an address that already has an account (409), never touching it', async () => {
    const { service, setPassword } = harness({
      insertUser: () => Promise.reject(new InviteeAccountExistsError()),
    });

    const error = await refusal(
      service.register(TOKEN, { displayName: 'Sara', password: strong }, CORR),
    );

    expect(error.status).toBe(409);
    expect(error.message).toBe(ACCOUNT_EXISTS_MESSAGE);
    expect(setPassword).not.toHaveBeenCalled();
  });

  it('refuses a weak password and a missing name with field errors (422)', async () => {
    const { service, insertUser } = harness();

    const error = await refusal(
      service.register(TOKEN, { displayName: ' ', password: 'short' }, CORR),
    );

    expect(error.status).toBe(422);
    const fields = (error.details ?? []).map((detail) => detail.field);
    expect(fields).toContain('displayName');
    expect(fields).toContain('password');
    expect(insertUser).not.toHaveBeenCalled();
  });

  it('refuses an unusable token with the same 404 as acceptance', async () => {
    const { service, insertUser } = harness({ pending: undefined });

    const error = await refusal(
      service.register(TOKEN, { displayName: 'Sara', password: strong }, CORR),
    );

    expect(error.status).toBe(404);
    expect(insertUser).not.toHaveBeenCalled();
  });
});
