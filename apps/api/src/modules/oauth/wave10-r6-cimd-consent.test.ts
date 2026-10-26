import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { McpOAuthAuthenticator, McpOAuthNotAuthenticatedError } from '../mcp/mcp-auth.js';
import {
  CIMD_MAX_PER_MINUTE,
  CIMD_MAX_PER_MINUTE_PER_SOURCE,
  CimdFetcher,
  cimdBusyError,
} from './cimd-fetcher.js';
import type { CimdFetcher as CimdFetcherType } from './cimd-fetcher.js';
import type { GrantsRepository } from './grants.repository.js';
import type { OauthTokensRepository } from './oauth-tokens.repository.js';
import type { SessionsRepository } from '../identity/sessions.repository.js';
import { codeChallengeS256 } from './pkce.js';
import { OAuthError, OAuthService } from './oauth.service.js';

/**
 * Wave 10 lane R6 — audit run 2 N06 (CIMD fetch caps), N04 grant half (a grant minted during a
 * recovery cutoff) and the NV07 follow-up (raw vs normalised CIMD client_id lookup).
 */

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];
const REDIRECT = 'https://client.example.test/callback';
const ISSUER = 'https://tmanage.example';
const RESOURCE = `${ISSUER}/mcp`;
const CHALLENGE = codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');

function documentFor(url: string): string {
  return JSON.stringify({ client_id: url, client_name: 'Client', redirect_uris: [REDIRECT] });
}

function frozenFetcher() {
  const get = vi.fn(async (url: URL) => documentFor(url.toString()));
  const fetcher = new CimdFetcher({
    resolve: async () => PUBLIC_ADDRESS,
    get,
    now: () => 1_000_000,
  });
  return { fetcher, get };
}

describe('N06 — one source cannot fill the CIMD fetch budget', () => {
  it('one source spraying 30 fresh hostnames gets 429 after 5; others still resolve', async () => {
    const { fetcher, get } = frozenFetcher();
    const attacker = '198.51.100.7';
    let refused = 0;
    for (let i = 0; i < 30; i += 1) {
      try {
        await fetcher.fetchMetadata(`https://spray${i}.example.test/m`, attacker);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(429);
        refused += 1;
      }
    }
    expect(refused).toBe(30 - CIMD_MAX_PER_MINUTE_PER_SOURCE);
    expect(get).toHaveBeenCalledTimes(CIMD_MAX_PER_MINUTE_PER_SOURCE);

    // A second source is unaffected, and so is a known first-party client.
    await expect(
      fetcher.fetchMetadata('https://real-client.example.test/m', '203.0.113.9'),
    ).resolves.toMatchObject({ clientId: 'https://real-client.example.test/m' });
    await expect(
      fetcher.fetchMetadata('https://claude.ai/oauth/client.json', '203.0.113.10'),
    ).resolves.toMatchObject({ verified: true });
  });

  it('IPv6 addresses in one /64 share a single source budget', async () => {
    const { fetcher } = frozenFetcher();
    for (let i = 0; i < CIMD_MAX_PER_MINUTE_PER_SOURCE; i += 1) {
      await fetcher.fetchMetadata(`https://v6-${i}.example.test/m`, `2001:db8:1:2::${i + 1}`);
    }
    await expect(
      fetcher.fetchMetadata('https://v6-over.example.test/m', '2001:db8:1:2:ffff::9'),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      fetcher.fetchMetadata('https://v6-other.example.test/m', '2001:db8:1:3::1'),
    ).resolves.toBeTruthy();
  });

  it('a filled global per-minute cap still lets a known-client URL resolve', async () => {
    const { fetcher } = frozenFetcher();
    const sources = Math.ceil(CIMD_MAX_PER_MINUTE / CIMD_MAX_PER_MINUTE_PER_SOURCE);
    let n = 0;
    for (let s = 0; s < sources; s += 1) {
      for (let i = 0; i < CIMD_MAX_PER_MINUTE_PER_SOURCE && n < CIMD_MAX_PER_MINUTE; i += 1) {
        await fetcher.fetchMetadata(`https://fill${n}.example.test/m`, `198.51.100.${s + 1}`);
        n += 1;
      }
    }
    await expect(
      fetcher.fetchMetadata('https://unknown-late.example.test/m', '192.0.2.50'),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      fetcher.fetchMetadata('https://claude.ai/oauth/client.json', '192.0.2.50'),
    ).resolves.toMatchObject({ clientId: 'https://claude.ai/oauth/client.json' });
  });
});

// ── OAuthService fakes ──────────────────────────────────────────────────────

interface ClientRow {
  id: string;
  clientId: string;
  kind: 'dcr' | 'cimd';
  name: string;
  redirectUrisJson: string[];
  verified: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
}

function duplicateKey(): Error {
  return Object.assign(new Error("Duplicate entry for key 'uq_oauth_clients_client_id'"), {
    errno: 1062,
    code: 'ER_DUP_ENTRY',
  });
}

function makeService(options: {
  clients?: ClientRow[];
  fetcher?: Pick<CimdFetcherType, 'fetchMetadata'>;
  sessions?: Pick<SessionsRepository, 'findById'>;
}) {
  const clients = new Map<string, ClientRow>();
  for (const row of options.clients ?? []) clients.set(row.clientId, row);
  const calls = {
    revokeGrant: vi.fn(async () => 1),
    revokeTokensByGrant: vi.fn(async () => undefined),
    spendCode: vi.fn(async () => true),
    insertGrant: vi.fn(async () => undefined),
    insertCode: vi.fn(async () => undefined),
  };
  const repository = {
    findClientByClientId: async (_r: unknown, id: string) => clients.get(id) ?? null,
    insertClient: async (_r: unknown, input: { id: string; clientId: string; name: string }) => {
      // The real table has a unique index on client_id.
      if (clients.has(input.clientId)) throw duplicateKey();
      clients.set(input.clientId, {
        id: input.id,
        clientId: input.clientId,
        kind: 'cimd',
        name: input.name,
        redirectUrisJson: [REDIRECT],
        verified: false,
        lastUsedAt: new Date(),
        createdAt: new Date(),
      });
    },
    refreshCimdClient: async (_r: unknown, input: { id: string }) => {
      for (const row of clients.values()) if (row.id === input.id) row.lastUsedAt = new Date();
    },
    insertGrant: calls.insertGrant,
    insertCode: calls.insertCode,
    revokeTokensByGrant: calls.revokeTokensByGrant,
    spendCode: calls.spendCode,
  } as unknown as OauthTokensRepository;
  const database = {
    identityRead: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
    bootstrapRead: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
    identityTransaction: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
    transaction: <T>(_c: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
  } as unknown as TenantDatabase;
  const service = new OAuthService({
    database,
    repository,
    issuer: ISSUER,
    canonicalResource: RESOURCE,
    ...(options.fetcher ? { cimdFetcher: options.fetcher as CimdFetcherType } : {}),
    ...(options.sessions ? { sessions: options.sessions } : {}),
    grants: { revokeGrant: calls.revokeGrant } as unknown as Pick<GrantsRepository, 'revokeGrant'>,
  });
  return { service, clients, calls };
}

const STALE = new Date(Date.now() - 48 * 60 * 60 * 1000);

function cimdRow(clientId: string, at: Date): ClientRow {
  return {
    id: 'client-pk-1',
    clientId,
    kind: 'cimd',
    name: 'Stale client',
    redirectUrisJson: [REDIRECT],
    verified: false,
    lastUsedAt: at,
    createdAt: at,
  };
}

function authorizeParams(clientId: string) {
  return {
    responseType: 'code',
    clientId,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    resource: RESOURCE,
    scope: 'tmanage:read',
    state: 's',
  };
}

describe('N06 — a busy fetcher serves the stale row instead of a 429 page', () => {
  it('an existing (stale) client still authorizes while the fetcher is capped', async () => {
    const id = 'https://client.example.test/m';
    const fetchMetadata = vi.fn(async () => {
      throw cimdBusyError();
    });
    const { service } = makeService({ clients: [cimdRow(id, STALE)], fetcher: { fetchMetadata } });
    await expect(
      service.validateAuthorize(authorizeParams(id), 'c', '1.2.3.4'),
    ).resolves.toMatchObject({ clientPk: 'client-pk-1', clientId: id });
    expect(fetchMetadata).toHaveBeenCalledWith(id, '1.2.3.4');
  });

  it('a first-time client still gets the 429 while the fetcher is capped', async () => {
    const fetchMetadata = vi.fn(async () => {
      throw cimdBusyError();
    });
    const { service } = makeService({ fetcher: { fetchMetadata } });
    await expect(
      service.validateAuthorize(authorizeParams('https://new.example.test/m'), 'c'),
    ).rejects.toMatchObject({ status: 429 });
  });
});

describe('NV07 follow-up — the CIMD row is looked up under the normalised client_id', () => {
  it('a raw id that normalises to a stored row refreshes it instead of a duplicate-key 400', async () => {
    const stored = 'https://client.example.test/';
    const fetcher = new CimdFetcher({
      resolve: async () => PUBLIC_ADDRESS,
      get: async (url: URL) => documentFor(url.toString()),
    });
    const { service, clients } = makeService({ clients: [cimdRow(stored, STALE)], fetcher });
    // No trailing slash and an explicit :443 — the URL parser normalises both to `stored`.
    const v = await service.validateAuthorize(
      authorizeParams('https://client.example.test:443'),
      'c',
    );
    expect(v.clientPk).toBe('client-pk-1');
    expect(v.clientId).toBe(stored);
    expect(clients.size).toBe(1);
  });

  it('losing the first-insert race reads the winner row back instead of failing', async () => {
    const id = 'https://race.example.test/m';
    const store: { clients?: Map<string, ClientRow> } = {};
    const fetchMetadata = vi.fn(async () => {
      // The racer inserts between our read and our insert.
      store.clients?.set(id, { ...cimdRow(id, new Date()), id: 'winner-pk' });
      return { clientId: id, name: 'Race', redirectUris: [REDIRECT], verified: false };
    });
    const { service, clients } = makeService({ fetcher: { fetchMetadata } });
    store.clients = clients;
    await expect(service.validateAuthorize(authorizeParams(id), 'c')).resolves.toMatchObject({
      clientPk: 'winner-pk',
    });
  });
});

// ── N04: consent minted during a recovery cutoff ────────────────────────────

const CTX = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'mem-1',
  correlationId: 'corr',
} as unknown as TenantContext;

function sessionState(overrides: { revokedAt?: Date | null; expired?: boolean; userId?: string }) {
  return {
    session: {
      id: 'sess-1',
      userId: overrides.userId ?? 'user-1',
      revokedAt: overrides.revokedAt ?? null,
    },
    expired: overrides.expired ?? false,
  } as unknown as Awaited<ReturnType<SessionsRepository['findById']>>;
}

function consentInput() {
  return {
    clientPk: 'client-pk-1',
    membershipId: 'mem-1',
    userId: 'user-1',
    redirectUri: REDIRECT,
    challenge: CHALLENGE,
    resource: RESOURCE,
    scopes: ['tmanage:read'],
    state: 's',
    sessionId: 'sess-1',
  };
}

describe('N04 — a grant minted for a session that ended meanwhile is revoked', () => {
  it.each([
    ['revoked during consent', { revokedAt: new Date() }],
    ['expired during consent', { expired: true }],
    ['someone else', { userId: 'user-2' }],
  ])('session %s → grant, tokens and code revoked, 401', async (_label, state) => {
    const findById = vi.fn(async () => sessionState(state));
    const { service, calls } = makeService({ sessions: { findById } });
    const refused = service.grantConsent(CTX, consentInput(), { grantId: 'grant-1' });
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({ status: 401 });
    expect(findById).toHaveBeenCalledWith(expect.anything(), 'sess-1');
    expect(calls.insertGrant).toHaveBeenCalled();
    expect(calls.revokeGrant).toHaveBeenCalledWith(expect.anything(), CTX, 'grant-1', null);
    expect(calls.revokeTokensByGrant).toHaveBeenCalledWith(expect.anything(), 'grant-1');
    expect(calls.spendCode).toHaveBeenCalledTimes(1);
  });

  it('a session that no longer exists → 401 and the grant revoked', async () => {
    const { service, calls } = makeService({ sessions: { findById: async () => null } });
    await expect(
      service.grantConsent(CTX, consentInput(), { grantId: 'grant-2' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls.revokeGrant).toHaveBeenCalledWith(expect.anything(), CTX, 'grant-2', null);
  });

  it('a live session → redirect with the code, nothing revoked', async () => {
    const { service, calls } = makeService({
      sessions: { findById: async () => sessionState({}) },
    });
    const { redirectUrl, code } = await service.grantConsent(CTX, consentInput(), {
      grantId: 'grant-3',
    });
    const url = new URL(redirectUrl);
    expect(url.searchParams.get('code')).toBe(code);
    expect(url.searchParams.get('iss')).toBe(ISSUER);
    expect(calls.revokeGrant).not.toHaveBeenCalled();
    expect(calls.spendCode).not.toHaveBeenCalled();
  });

  it('access-token authentication refuses a token whose grant was revoked', async () => {
    const database = {
      identityRead: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
      bootstrapRead: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
    } as unknown as TenantDatabase;
    const repo = {
      findLiveAccessTokenByHash: async () => ({ grantId: 'grant-1', audience: RESOURCE }),
      findGrantById: async () => ({ id: 'grant-1', revokedAt: new Date(), scopes: 'tmanage:read' }),
    } as unknown as OauthTokensRepository;
    const auth = new McpOAuthAuthenticator(database, RESOURCE, repo);
    await expect(auth.authenticate('token', 'c')).rejects.toBeInstanceOf(
      McpOAuthNotAuthenticatedError,
    );
  });

  it('the code of a revoked grant cannot be exchanged for tokens', async () => {
    const database = {
      identityRead: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
      bootstrapRead: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
      identityTransaction: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
    } as unknown as TenantDatabase;
    const revokeTokensByGrant = vi.fn(async () => undefined);
    const repository = {
      // The N04 revocation spent the code, so it reads as used.
      findCodeByHash: async () => ({
        grantId: 'grant-1',
        usedAt: new Date(),
        redirectUri: REDIRECT,
        resource: RESOURCE,
        challenge: CHALLENGE,
      }),
      findGrantById: async () => ({
        id: 'grant-1',
        clientPk: 'client-pk-1',
        revokedAt: new Date(),
      }),
      revokeTokensByGrant,
    } as unknown as OauthTokensRepository;
    const service = new OAuthService({
      database,
      repository,
      issuer: ISSUER,
      canonicalResource: RESOURCE,
    });
    const refused = service.exchangeCode(
      {
        code: 'the-code',
        codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        redirectUri: REDIRECT,
        clientId: 'https://client.example.test/m',
        resource: RESOURCE,
      },
      'c',
    );
    await expect(refused).rejects.toBeInstanceOf(OAuthError);
    await expect(refused).rejects.toMatchObject({ code: 'invalid_grant' });
  });
});
