import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { mintPersonalAccessToken } from './personal-access-token.js';
import {
  PersonalAccessTokenNotAuthenticatedError,
  PersonalAccessTokensService,
} from './personal-access-tokens.service.js';
import type { PersonalAccessTokensRepository } from './personal-access-tokens.repository.js';
import type { PersonalAccessTokenAuthRow } from './personal-access-tokens.repository.js';

/**
 * Security tests for the Bearer authentication path (manager-directed): a token resolves to its
 * own member and tenant with no elevation, and a revoked, expired, unknown or malformed token is
 * refused. The lookup is mocked, so no server is needed.
 */

const ORG = '0198f4a2-1c00-7000-8000-00000000000a';
const MEMBERSHIP = '0198f4a2-1c00-7000-8000-00000000000b';
const USER = '0198f4a2-1c00-7000-8000-00000000000c';
const CORRELATION = '0198f4a2-1c00-7000-8000-00000000000d';

function serviceWith(authRow: PersonalAccessTokenAuthRow | undefined): PersonalAccessTokensService {
  const database = {
    // bootstrapRead runs the work against a runner the fake repo ignores.
    bootstrapRead: vi.fn(async (_opts: unknown, work: (runner: unknown) => Promise<unknown>) =>
      work({ query: vi.fn() }),
    ),
    // touch() best-effort; a no-op transaction keeps it from throwing.
    transaction: vi.fn(async () => undefined),
  } as unknown as TenantDatabase;

  const repo = {
    findUsableByHash: vi.fn(async () => authRow),
    recordUsage: vi.fn(async () => undefined),
  } as unknown as PersonalAccessTokensRepository;

  return new PersonalAccessTokensService(database, repo);
}

function row(overrides: Partial<PersonalAccessTokenAuthRow> = {}): PersonalAccessTokenAuthRow {
  return {
    id: 'tok1',
    organizationId: ORG,
    membershipId: MEMBERSHIP,
    userId: USER,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe('PersonalAccessTokensService.authenticate', () => {
  const token = mintPersonalAccessToken().token;

  it('resolves a live token to its own member and tenant, with no elevation', async () => {
    const result = await serviceWith(row()).authenticate(token, CORRELATION);
    expect(result).toEqual({
      tokenId: 'tok1',
      organizationId: ORG,
      membershipId: MEMBERSHIP,
      userId: USER,
      // R13 s3: a pre-0282 row (no scopes column read) keeps read + write, never more.
      scopes: ['tmanage:read', 'tmanage:write'],
      ipAllowlist: [],
    });
  });

  it('refuses a malformed token without a lookup', async () => {
    const service = serviceWith(undefined);
    await expect(service.authenticate('not-a-token', CORRELATION)).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it('refuses an unknown, revoked, or expired token', async () => {
    await expect(serviceWith(undefined).authenticate(token, CORRELATION)).rejects.toMatchObject({
      code: 'unknown',
    });
    await expect(
      serviceWith(row({ revokedAt: new Date() })).authenticate(token, CORRELATION),
    ).rejects.toMatchObject({ code: 'revoked' });
    await expect(
      serviceWith(row({ expiresAt: new Date(Date.now() - 1000) })).authenticate(token, CORRELATION),
    ).rejects.toMatchObject({ code: 'expired' });
  });

  it('throws the dedicated error type so the guard maps it to a 401', async () => {
    await expect(serviceWith(undefined).authenticate(token, CORRELATION)).rejects.toBeInstanceOf(
      PersonalAccessTokenNotAuthenticatedError,
    );
  });
});
