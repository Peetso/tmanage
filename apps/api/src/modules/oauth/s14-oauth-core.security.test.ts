import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { codeChallengeS256 } from './pkce.js';
import type { GrantView, NewGrant, NewOauthClient } from './oauth-tokens.repository.js';
import type { OauthTokensRepository } from './oauth-tokens.repository.js';
import {
  CODE_TTL_SECONDS,
  OAuthError,
  OAuthService,
  REFRESH_IDLE_TTL_SECONDS,
  type TokenResponse,
} from './oauth.service.js';

/**
 * S14A — the OAuth 2.1 core for `/mcp`, exercised end to end through the real `OAuthService`
 * against an in-memory fake of the repository and database (no MariaDB). The fake keeps the
 * repository's contract: every expiry is compared on one clock, `spendCode` / `spendRefreshToken`
 * are compare-and-set, and a transaction that throws is rolled back — as the real
 * `identityTransaction` does (`connection.rollback()`).
 */

const ISSUER = 'https://tmanage.example';
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT_ID = 'dcr-client-a';
const OTHER_CLIENT_ID = 'dcr-client-b';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = codeChallengeS256(VERIFIER);
const CTX = { organizationId: 'org-1' } as unknown as TenantContext;

const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

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
interface CodeRow {
  codeHash: string;
  grantId: string;
  challenge: string;
  redirectUri: string;
  resource: string;
  expiresAt: number;
  usedAt: Date | null;
}
interface AccessRow {
  tokenHash: string;
  grantId: string;
  familyId: string;
  audience: string;
  revokedAt: Date | null;
  expiresAt: number;
}
interface RefreshRow {
  tokenHash: string;
  familyId: string;
  grantId: string;
  parentHash: string | null;
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: number;
  absoluteExpiresAt: Date;
}
interface State {
  clients: Map<string, ClientRow>;
  grants: Map<string, GrantView>;
  codes: Map<string, CodeRow>;
  access: Map<string, AccessRow>;
  refresh: Map<string, RefreshRow>;
}

/** An in-memory store with the repository's semantics and a controllable clock. */
class FakeStore {
  now = Date.UTC(2026, 9, 22, 12, 0, 0);
  state: State = {
    clients: new Map(),
    grants: new Map(),
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
  };

  private snapshot(): State {
    const clone = <K, V>(map: Map<K, V>) => new Map([...map].map(([k, v]) => [k, { ...v }]));
    return {
      clients: clone(this.state.clients),
      grants: clone(this.state.grants),
      codes: clone(this.state.codes),
      access: clone(this.state.access),
      refresh: clone(this.state.refresh),
    };
  }

  private async tx<T>(fn: (runner: unknown) => Promise<T>): Promise<T> {
    const before = this.snapshot();
    try {
      return await fn({});
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  readonly database = {
    identityRead: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
    bootstrapRead: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => fn({}),
    identityTransaction: <T>(_o: unknown, fn: (r: unknown) => Promise<T>) => this.tx(fn),
    transaction: <T>(_c: unknown, fn: (r: unknown) => Promise<T>) => this.tx(fn),
  } as unknown as TenantDatabase;

  readonly repository = {
    findClientByClientId: async (_r: unknown, clientId: string) =>
      this.state.clients.get(clientId) ?? null,
    insertClient: async (_r: unknown, input: NewOauthClient) => {
      this.state.clients.set(input.clientId, {
        id: input.id,
        clientId: input.clientId,
        kind: input.kind,
        name: input.name,
        redirectUrisJson: [...input.redirectUris],
        verified: input.verified,
        lastUsedAt: null,
        createdAt: new Date(this.now),
      });
    },
    insertGrant: async (_r: unknown, input: NewGrant) => {
      this.state.grants.set(input.id, { ...input, revokedAt: null });
    },
    findGrantById: async (_r: unknown, id: string) => this.state.grants.get(id) ?? null,
    insertCode: async (
      _r: unknown,
      input: Omit<CodeRow, 'expiresAt' | 'usedAt'> & { ttlSeconds: number },
    ) => {
      const { ttlSeconds, ...rest } = input;
      this.state.codes.set(input.codeHash, {
        ...rest,
        expiresAt: this.now + ttlSeconds * 1000,
        usedAt: null,
      });
    },
    findCodeByHash: async (_r: unknown, hash: string) => this.state.codes.get(hash) ?? null,
    spendCode: async (_r: unknown, hash: string) => {
      const row = this.state.codes.get(hash);
      if (!row || row.usedAt !== null || row.expiresAt <= this.now) return false;
      row.usedAt = new Date(this.now);
      return true;
    },
    insertAccessToken: async (
      _r: unknown,
      input: { tokenHash: string; grantId: string; familyId: string; audience: string } & {
        ttlSeconds: number;
      },
    ) => {
      this.state.access.set(input.tokenHash, {
        tokenHash: input.tokenHash,
        grantId: input.grantId,
        familyId: input.familyId,
        audience: input.audience,
        revokedAt: null,
        expiresAt: this.now + input.ttlSeconds * 1000,
      });
    },
    findAnyAccessTokenByHash: async (_r: unknown, hash: string) =>
      this.state.access.get(hash) ?? null,
    insertRefreshToken: async (
      _r: unknown,
      input: {
        tokenHash: string;
        familyId: string;
        grantId: string;
        parentHash: string | null;
        idleTtlSeconds: number;
        absoluteExpiresAt: Date | null;
        absoluteTtlSeconds: number;
      },
    ) => {
      this.state.refresh.set(input.tokenHash, {
        tokenHash: input.tokenHash,
        familyId: input.familyId,
        grantId: input.grantId,
        parentHash: input.parentHash,
        usedAt: null,
        revokedAt: null,
        expiresAt: this.now + input.idleTtlSeconds * 1000,
        absoluteExpiresAt:
          input.absoluteExpiresAt ?? new Date(this.now + input.absoluteTtlSeconds * 1000),
      });
    },
    findRefreshTokenByHash: async (_r: unknown, hash: string) =>
      this.state.refresh.get(hash) ?? null,
    spendRefreshToken: async (_r: unknown, hash: string) => {
      const row = this.state.refresh.get(hash);
      if (
        !row ||
        row.usedAt !== null ||
        row.revokedAt !== null ||
        row.expiresAt <= this.now ||
        row.absoluteExpiresAt.getTime() <= this.now
      ) {
        return false;
      }
      row.usedAt = new Date(this.now);
      return true;
    },
    revokeFamily: async (_r: unknown, familyId: string) => {
      for (const row of [...this.state.access.values(), ...this.state.refresh.values()]) {
        if (row.familyId === familyId && row.revokedAt === null) row.revokedAt = new Date(this.now);
      }
    },
    revokeTokensByGrant: async (_r: unknown, grantId: string) => {
      for (const row of [...this.state.access.values(), ...this.state.refresh.values()]) {
        if (row.grantId === grantId && row.revokedAt === null) row.revokedAt = new Date(this.now);
      }
    },
  } as unknown as OauthTokensRepository;
}

let store: FakeStore;
let service: OAuthService;

function seedClient(clientId: string, pk: string, redirects: string[] = [REDIRECT]): void {
  store.state.clients.set(clientId, {
    id: pk,
    clientId,
    kind: 'dcr',
    name: clientId,
    redirectUrisJson: redirects,
    verified: false,
    lastUsedAt: null,
    createdAt: new Date(store.now),
  });
}

beforeEach(() => {
  store = new FakeStore();
  service = new OAuthService({
    database: store.database,
    repository: store.repository,
    issuer: ISSUER,
    canonicalResource: RESOURCE,
  });
  seedClient(CLIENT_ID, 'pk-a', [REDIRECT, 'http://127.0.0.1:8787/cb']);
  seedClient(OTHER_CLIENT_ID, 'pk-b');
});

function authorizeParams(overrides: Record<string, unknown> = {}) {
  return {
    responseType: 'code',
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    resource: RESOURCE,
    scope: 'tmanage:read tmanage:write',
    state: 'st-1',
    ...overrides,
  };
}

let grantSeq = 0;
/** Run authorize + consent and return the one-time code. */
async function issueCode(): Promise<string> {
  const v = await service.validateAuthorize(authorizeParams(), 'c');
  grantSeq += 1;
  const { code } = await service.grantConsent(
    CTX,
    {
      clientPk: v.clientPk,
      membershipId: 'mem-1',
      userId: 'user-1',
      redirectUri: v.redirectUri,
      challenge: v.challenge,
      resource: v.resource,
      scopes: v.scopes,
      state: v.state,
    },
    { grantId: `grant-${grantSeq}` },
  );
  return code;
}

function exchange(code: string, overrides: Record<string, unknown> = {}) {
  return service.exchangeCode(
    {
      code,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
      clientId: CLIENT_ID,
      resource: RESOURCE,
      ...overrides,
    },
    'c',
  );
}

async function rejection(promise: Promise<unknown>): Promise<OAuthError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OAuthError);
  return error as OAuthError;
}

const accessRow = (t: TokenResponse) => store.state.access.get(sha(t.access_token));
const refreshRow = (t: TokenResponse) => store.state.refresh.get(sha(t.refresh_token));

describe('S14A PKCE S256 enforcement (T-OA-02)', () => {
  it('refuses code_challenge_method=plain at authorize, without a redirect', async () => {
    const error = await rejection(
      service.validateAuthorize(
        authorizeParams({ codeChallengeMethod: 'plain', codeChallenge: VERIFIER }),
        'c',
      ),
    );
    expect(error.code).toBe('invalid_request');
    expect(error.redirectable).toBe(false);
  });

  it('refuses a missing method (no silent default to plain) and a missing challenge', async () => {
    const noMethod = await rejection(
      service.validateAuthorize(authorizeParams({ codeChallengeMethod: undefined }), 'c'),
    );
    expect(noMethod.redirectable).toBe(false);
    const noChallenge = await rejection(
      service.validateAuthorize(authorizeParams({ codeChallenge: undefined }), 'c'),
    );
    expect(noChallenge.code).toBe('invalid_request');
    expect(noChallenge.redirectable).toBe(false);
  });

  it('refuses a token request with a missing verifier, and does not spend the code', async () => {
    const code = await issueCode();
    const error = await rejection(exchange(code, { codeVerifier: undefined }));
    expect(error.code).toBe('invalid_request');
    expect(store.state.codes.get(sha(code))?.usedAt).toBeNull();
    expect(store.state.access.size).toBe(0);
  });

  it('refuses a wrong verifier and a plain-style verifier equal to the challenge', async () => {
    const code = await issueCode();
    expect(
      (await rejection(exchange(code, { codeVerifier: `${VERIFIER.slice(0, -1)}A` }))).code,
    ).toBe('invalid_grant');
    expect((await rejection(exchange(code, { codeVerifier: CHALLENGE }))).code).toBe(
      'invalid_grant',
    );
    expect(store.state.access.size).toBe(0);
  });
});

describe('S14A redirect URI exact match (T-OA-03, T-OA-04)', () => {
  it('refuses prefix, extra path, query, fragment, other host and http variants, never redirectable', async () => {
    for (const redirectUri of [
      'https://claude.ai/api/mcp',
      'https://claude.ai/api/mcp/auth_callback/evil',
      'https://claude.ai/api/mcp/auth_callback?next=https://evil.example',
      'https://claude.ai/api/mcp/auth_callback#x',
      'https://claude.ai.evil.example/api/mcp/auth_callback',
      'https://evil.example/?https://claude.ai/api/mcp/auth_callback',
      'http://claude.ai/api/mcp/auth_callback',
      'HTTPS://CLAUDE.AI/api/mcp/auth_callback/../../x',
      'http://127.0.0.1:9999/other',
    ]) {
      const error = await rejection(
        service.validateAuthorize(authorizeParams({ redirectUri }), 'c'),
      );
      expect(error.redirectable, redirectUri).toBe(false);
    }
  });

  it('accepts the exact registered URI and a loopback on another port', async () => {
    await expect(service.validateAuthorize(authorizeParams(), 'c')).resolves.toMatchObject({
      redirectUri: REDIRECT,
    });
    await expect(
      service.validateAuthorize(authorizeParams({ redirectUri: 'http://127.0.0.1:50123/cb' }), 'c'),
    ).resolves.toMatchObject({ redirectUri: 'http://127.0.0.1:50123/cb' });
  });

  it('refuses another client’s redirect URI and an unknown client, without a redirect', async () => {
    seedClient('dcr-client-c', 'pk-c', ['https://evil.example/cb']);
    const foreign = await rejection(
      service.validateAuthorize(authorizeParams({ redirectUri: 'https://evil.example/cb' }), 'c'),
    );
    expect(foreign.redirectable).toBe(false);
    const unknown = await rejection(
      service.validateAuthorize(authorizeParams({ clientId: 'nope' }), 'c'),
    );
    expect(unknown.code).toBe('invalid_client');
    expect(unknown.redirectable).toBe(false);
  });

  it('refuses a token request whose redirect_uri differs from the code’s', async () => {
    const code = await issueCode();
    const error = await rejection(exchange(code, { redirectUri: 'http://127.0.0.1:8787/cb' }));
    expect(error.code).toBe('invalid_grant');
    expect(store.state.access.size).toBe(0);
  });
});

describe('S14A authorization code single use, binding and expiry (T-OA-05)', () => {
  it('a code works once; a replay is refused and revokes the tokens it issued', async () => {
    const code = await issueCode();
    const first = await exchange(code);
    expect(accessRow(first)?.revokedAt).toBeNull();
    const replay = await rejection(exchange(code));
    expect(replay.code).toBe('invalid_grant');
    expect(accessRow(first)?.revokedAt).not.toBeNull();
    expect(refreshRow(first)?.revokedAt).not.toBeNull();
    await expect(
      service.refresh(
        { refreshToken: first.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
        'c',
      ),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('an expired code is refused and mints nothing', async () => {
    const code = await issueCode();
    store.now += (CODE_TTL_SECONDS + 1) * 1000;
    expect((await rejection(exchange(code))).code).toBe('invalid_grant');
    expect(store.state.access.size).toBe(0);
    expect(store.state.refresh.size).toBe(0);
  });

  it('a code is bound to its client: another registered client cannot redeem it', async () => {
    const code = await issueCode();
    expect((await rejection(exchange(code, { clientId: OTHER_CLIENT_ID }))).code).toBe(
      'invalid_grant',
    );
    expect(store.state.access.size).toBe(0);
  });

  it('a code is bound to the canonical resource', async () => {
    const code = await issueCode();
    expect((await rejection(exchange(code, { resource: 'https://evil.example/mcp' }))).code).toBe(
      'invalid_target',
    );
    expect(
      (
        await rejection(
          service.validateAuthorize(authorizeParams({ resource: `${RESOURCE}/x` }), 'c'),
        )
      ).code,
    ).toBe('invalid_target');
  });

  it('issued access tokens are opaque, audience-bound to /mcp and stored only as a hash', async () => {
    const tokens = await exchange(await issueCode());
    expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(accessRow(tokens)?.audience).toBe(RESOURCE);
    expect(store.state.access.has(tokens.access_token)).toBe(false);
  });
});

describe('S14A refresh token rotation and reuse detection (T-OA-06)', () => {
  it('rotates: a new pair in the same family, the old token spent, absolute expiry carried', async () => {
    const first = await exchange(await issueCode());
    const second = await service.refresh(
      { refreshToken: first.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
      'c',
    );
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    expect(refreshRow(first)?.usedAt).not.toBeNull();
    expect(refreshRow(second)?.familyId).toBe(refreshRow(first)?.familyId);
    expect(refreshRow(second)?.parentHash).toBe(sha(first.refresh_token));
    expect(refreshRow(second)?.absoluteExpiresAt.getTime()).toBe(
      refreshRow(first)?.absoluteExpiresAt.getTime(),
    );
  });

  it('reusing a rotated refresh token revokes the whole family', async () => {
    const first = await exchange(await issueCode());
    const second = await service.refresh(
      { refreshToken: first.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
      'c',
    );
    const reuse = await rejection(
      service.refresh(
        { refreshToken: first.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
        'c',
      ),
    );
    expect(reuse.code).toBe('invalid_grant');
    expect(refreshRow(second)?.revokedAt).not.toBeNull();
    expect(accessRow(second)?.revokedAt).not.toBeNull();
    expect(accessRow(first)?.revokedAt).not.toBeNull();
    await expect(
      service.refresh(
        { refreshToken: second.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
        'c',
      ),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  // S14 finding (fixed by FX1): the race branch of `OAuthService.refresh` ("Lost the race") once
  // called `revokeFamily` INSIDE the `mintTokens` identity transaction and then threw, so the
  // rollback undid the revocation. When two requests present one refresh token concurrently (both
  // pass the unused pre-check, one spends it first), the loser must get `invalid_grant` AND the
  // family — including the winner's fresh pair — must die (T-OA-06). Simulated here by spending
  // the token between the service's pre-read and its spend, exactly what a racing winner does.
  it('a refresh token spent by a racing request still revokes the family', async () => {
    const first = await exchange(await issueCode());
    const repo = store.repository as unknown as {
      findRefreshTokenByHash: (r: unknown, h: string) => Promise<RefreshRow | null>;
    };
    const original = repo.findRefreshTokenByHash;
    repo.findRefreshTokenByHash = async (r, h) => {
      const row = await original(r, h);
      const stale = row ? { ...row } : null;
      // The racing winner spends the token right after this request read it as unused.
      if (row) row.usedAt = new Date(store.now);
      repo.findRefreshTokenByHash = original;
      return stale;
    };
    const error = await rejection(
      service.refresh(
        { refreshToken: first.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
        'c',
      ),
    );
    expect(error.code).toBe('invalid_grant');
    expect(accessRow(first)?.revokedAt).not.toBeNull();
    expect(refreshRow(first)?.revokedAt).not.toBeNull();
  });

  it('an idle-expired refresh token is refused and mints nothing', async () => {
    const first = await exchange(await issueCode());
    store.now += (REFRESH_IDLE_TTL_SECONDS + 1) * 1000;
    const before = store.state.refresh.size;
    const error = await rejection(
      service.refresh(
        { refreshToken: first.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
        'c',
      ),
    );
    expect(error.code).toBe('invalid_grant');
    expect(store.state.refresh.size).toBe(before);
  });

  it('refuses another resource, an unknown token, and a token whose grant was revoked', async () => {
    const first = await exchange(await issueCode());
    expect(
      (
        await rejection(
          service.refresh(
            {
              refreshToken: first.refresh_token,
              resource: 'https://evil/mcp',
              clientId: CLIENT_ID,
            },
            'c',
          ),
        )
      ).code,
    ).toBe('invalid_target');
    expect(
      (
        await rejection(
          service.refresh(
            { refreshToken: 'garbage', resource: RESOURCE, clientId: CLIENT_ID },
            'c',
          ),
        )
      ).code,
    ).toBe('invalid_grant');
    const grant = store.state.grants.get(refreshRow(first)?.grantId ?? '');
    if (grant) store.state.grants.set(grant.id, { ...grant, revokedAt: new Date(store.now) });
    expect(
      (
        await rejection(
          service.refresh(
            { refreshToken: first.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
            'c',
          ),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(accessRow(first)?.revokedAt).not.toBeNull();
  });
});

describe('S14A refresh token client binding (OAuth 2.1 §4.3.1, FU2)', () => {
  it('refuses a refresh token presented by another client or without client_id, and spends nothing', async () => {
    const first = await exchange(await issueCode());
    const before = store.state.refresh.size;
    const foreign = await rejection(
      service.refresh(
        { refreshToken: first.refresh_token, resource: RESOURCE, clientId: OTHER_CLIENT_ID },
        'c',
      ),
    );
    expect(foreign.code).toBe('invalid_grant');
    const missing = await rejection(
      service.refresh({ refreshToken: first.refresh_token, resource: RESOURCE }, 'c'),
    );
    expect(missing.code).toBe('invalid_request');
    expect(refreshRow(first)?.usedAt).toBeNull();
    expect(store.state.refresh.size).toBe(before);
    // The owning client can still rotate it.
    const rotated = await service.refresh(
      { refreshToken: first.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
      'c',
    );
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
  });
});

describe('S14A revocation (RFC 7009)', () => {
  it('revoking a refresh token kills its family, access token included', async () => {
    const tokens = await exchange(await issueCode());
    await service.revoke(tokens.refresh_token, 'c');
    expect(accessRow(tokens)?.revokedAt).not.toBeNull();
    await expect(
      service.refresh(
        { refreshToken: tokens.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
        'c',
      ),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('revoking an access token kills its family, refresh token included', async () => {
    const tokens = await exchange(await issueCode());
    await service.revoke(tokens.access_token, 'c');
    expect(refreshRow(tokens)?.revokedAt).not.toBeNull();
    await expect(
      service.refresh(
        { refreshToken: tokens.refresh_token, resource: RESOURCE, clientId: CLIENT_ID },
        'c',
      ),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('an unknown, empty or non-string token is a silent no-op and touches no other family', async () => {
    const tokens = await exchange(await issueCode());
    await expect(service.revoke('not-a-token', 'c')).resolves.toBeUndefined();
    await expect(service.revoke('', 'c')).resolves.toBeUndefined();
    await expect(service.revoke({ token: 'x' }, 'c')).resolves.toBeUndefined();
    expect(accessRow(tokens)?.revokedAt).toBeNull();
    expect(refreshRow(tokens)?.revokedAt).toBeNull();
  });
});
