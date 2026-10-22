import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { IS_PUBLIC } from '../../common/http/decorators.js';
import type { FeatureFlagsRepository } from '../../modules/admin/feature-flags.repository.js';
import { AiConnectorFallbacksController } from '../../modules/mcp/ai-connector-fallbacks.controller.js';
import type { AiAccessSwitches } from '../../modules/oauth/ai-access.js';
import { ConnectedAppsController } from '../../modules/oauth/grants.controller.js';
import { GrantsRepository } from '../../modules/oauth/grants.repository.js';
import { ConnectedAppsService } from '../../modules/oauth/grants.service.js';
import { OauthTokensRepository } from '../../modules/oauth/oauth-tokens.repository.js';
import { OAuthService } from '../../modules/oauth/oauth.service.js';
import { codeChallengeS256 } from '../../modules/oauth/pkce.js';

/**
 * S14C — Connected apps revoke kills the app's tokens (S11), and the S13 fallbacks (the OpenAPI
 * document and the stdio-bridge download) expose nothing they should not.
 */

const context = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'mem-1',
} as TenantContext;

function capturingRunner() {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const runner = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      return { affectedRows: 1 };
    },
  } as unknown as TenantQueryRunner;
  return { runner, statements };
}

function appsOver(runner: TenantQueryRunner): ConnectedAppsService {
  const database = {
    transaction: (_c: unknown, fn: (tx: unknown) => unknown) => fn(runner),
  } as unknown as TenantDatabase;
  return new ConnectedAppsService(
    database,
    { forget: () => undefined } as unknown as AiAccessSwitches,
    new GrantsRepository(),
    new OauthTokensRepository(),
    {} as FeatureFlagsRepository,
  );
}

describe('S14C connected apps — revoke kills every token of the grant', () => {
  it("a member's revoke is scoped to their own live grant, then revokes its access and refresh tokens", async () => {
    const { runner, statements } = capturingRunner();
    await appsOver(runner).revoke(context, false, 'grant-1');
    const [grant, access, refresh] = statements;
    expect(grant?.sql).toMatch(/^update `oauth_grants` set `revoked_at`/);
    for (const predicate of [
      '`organization_id` = ?',
      '`id` = ?',
      '`revoked_at` is null',
      '`membership_id` = ?',
    ]) {
      expect(grant?.sql).toContain(predicate);
    }
    expect(grant?.params).toEqual(expect.arrayContaining(['org-1', 'grant-1', 'mem-1']));
    expect(access?.sql).toMatch(/^update `oauth_access_tokens` set `revoked_at`/);
    expect(access?.sql).toContain('`grant_id` = ?');
    expect(refresh?.sql).toMatch(/^update `oauth_refresh_tokens` set `revoked_at`/);
    expect(refresh?.sql).toContain('`grant_id` = ?');
    expect(access?.params).toContain('grant-1');
    expect(refresh?.params).toContain('grant-1');
  });

  it("an owner's revoke is workspace-wide but still bound to this organization", async () => {
    const { runner, statements } = capturingRunner();
    await appsOver(runner).revoke(context, true, 'grant-2');
    expect(statements[0]?.sql).toContain('`organization_id` = ?');
    expect(statements[0]?.sql).not.toContain('`membership_id`');
    expect(statements[0]?.params).toContain('org-1');
  });

  it('an AI credential cannot revoke (or keep alive) a connection through the page API', async () => {
    const apps = { revoke: vi.fn(), list: vi.fn(), setAiAccess: vi.fn() };
    const controller = new ConnectedAppsController(apps as never);
    for (const authScheme of ['ai_grant', 'personal_access_token']) {
      await expect(
        controller.revoke(context, { authScheme, role: 'owner' }, 'grant-1'),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(apps.revoke).not.toHaveBeenCalled();
  });

  describe('after revocation the token endpoint refuses the grant', () => {
    const VERIFIER = 'w'.repeat(64);
    const RESOURCE = 'https://tmanage.example/mcp';
    function revokedService() {
      const repository = {
        findCodeByHash: vi.fn(async () => ({
          grantId: 'grant-1',
          challenge: codeChallengeS256(VERIFIER),
          redirectUri: 'https://app.example/cb',
          resource: RESOURCE,
          usedAt: null,
        })),
        findRefreshTokenByHash: vi.fn(async () => ({
          familyId: 'fam-1',
          grantId: 'grant-1',
          usedAt: null,
          revokedAt: null,
          absoluteExpiresAt: new Date(Date.now() + 60_000),
        })),
        findGrantById: vi.fn(async () => ({
          id: 'grant-1',
          organizationId: 'org-1',
          clientPk: 'pk-1',
          membershipId: 'mem-1',
          userId: 'user-1',
          scopes: 'tmanage:read',
          revokedAt: new Date(),
        })),
        findClientByClientId: vi.fn(async () => ({ id: 'pk-1' })),
        spendCode: vi.fn(async () => true),
        spendRefreshToken: vi.fn(async () => true),
        revokeFamily: vi.fn(async () => undefined),
        insertAccessToken: vi.fn(async () => undefined),
        insertRefreshToken: vi.fn(async () => undefined),
      };
      const database = {
        identityRead: (_o: unknown, fn: (db: unknown) => unknown) => fn({}),
        bootstrapRead: (_o: unknown, fn: (db: unknown) => unknown) => fn({}),
        identityTransaction: (_o: unknown, fn: (db: unknown) => unknown) => fn({}),
      } as unknown as TenantDatabase;
      const service = new OAuthService({
        database,
        repository: repository as unknown as OauthTokensRepository,
        issuer: 'https://tmanage.example',
        canonicalResource: RESOURCE,
      });
      return { service, repository };
    }

    it('refresh on a revoked grant is invalid_grant, revokes the family and mints nothing', async () => {
      const { service, repository } = revokedService();
      await expect(
        service.refresh({ refreshToken: 'r-1', resource: RESOURCE }, 'corr'),
      ).rejects.toMatchObject({ code: 'invalid_grant' });
      expect(repository.revokeFamily).toHaveBeenCalledWith({}, 'fam-1');
      expect(repository.insertAccessToken).not.toHaveBeenCalled();
    });

    it('a still-unspent code of a revoked grant cannot be exchanged', async () => {
      const { service, repository } = revokedService();
      await expect(
        service.exchangeCode(
          {
            code: 'c-1',
            codeVerifier: VERIFIER,
            redirectUri: 'https://app.example/cb',
            clientId: 'dcr-1',
            resource: RESOURCE,
          },
          'corr',
        ),
      ).rejects.toMatchObject({ code: 'invalid_grant' });
      expect(repository.spendCode).not.toHaveBeenCalled();
      expect(repository.insertAccessToken).not.toHaveBeenCalled();
    });
  });
});

class FakeReply {
  statusCode: number | undefined;
  readonly headers: Record<string, string> = {};
  payload: unknown;
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  type(): this {
    return this;
  }
  header(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }
  send(payload: unknown): unknown {
    this.payload = payload;
    return payload;
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('S14C AI connector fallbacks (S13)', () => {
  it('/openapi/ai.json never lists the consent, approval, connected-apps or AI-switch routes', () => {
    const doc = new AiConnectorFallbacksController({
      baseUrl: 'https://tmanage.example',
      bridgeTarballPath: undefined,
    }).openApiDocument() as unknown as { paths: Record<string, unknown> };
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path).not.toMatch(/\/oauth\b|\/ai\/approvals|ai-access|personal-access-tokens/);
    }
    expect(JSON.stringify(doc)).not.toMatch(/consent|connected-apps/i);
  });

  it('the bridge download is 503 (no-store) when the configured path is a directory, not a built tarball', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmanage-s14c-'));
    tmpDirs.push(dir);
    const reply = new FakeReply();
    await new AiConnectorFallbacksController({
      baseUrl: 'http://localhost',
      bridgeTarballPath: dir,
    }).bridgeTarball(reply as never);
    expect(reply.statusCode).toBe(503);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect((reply.payload as { error: string }).error).toBe('bridge_unavailable');
  });

  it('both fallback routes are public reads that carry no per-caller data', () => {
    const proto = AiConnectorFallbacksController.prototype;
    expect(Reflect.getMetadata(IS_PUBLIC, proto.openApiDocument)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC, proto.bridgeTarball)).toBe(true);
    const a = new AiConnectorFallbacksController({
      baseUrl: 'https://x',
      bridgeTarballPath: undefined,
    });
    expect(JSON.stringify(a.openApiDocument())).toBe(JSON.stringify(a.openApiDocument()));
  });
});
