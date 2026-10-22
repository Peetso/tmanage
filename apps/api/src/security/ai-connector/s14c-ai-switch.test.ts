import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import { AiPlatformSwitchGuard } from '../../modules/oauth/ai-access.js';
import type { AiAccessSwitches } from '../../modules/oauth/ai-access.js';
import { OAuthAuthorizeController } from '../../modules/oauth/authorize.controller.js';
import { OAuthConsentController } from '../../modules/oauth/consent.controller.js';
import { ConnectedAppsController } from '../../modules/oauth/grants.controller.js';
import type { OauthTokensRepository } from '../../modules/oauth/oauth-tokens.repository.js';
import { OAuthService } from '../../modules/oauth/oauth.service.js';
import { codeChallengeS256 } from '../../modules/oauth/pkce.js';
import { OAuthRegisterController } from '../../modules/oauth/register.controller.js';
import { OAuthRevokeController } from '../../modules/oauth/revoke.controller.js';
import { OAuthTokenController } from '../../modules/oauth/token.controller.js';

/**
 * S14C — the platform and workspace AI access switches (S11, `oauth/ai-access.ts`; T-KILL-01).
 * Platform off: every OAuth entry point answers 503, revocation stays open. Workspace off: no
 * token is minted, and the code or refresh token presented is not spent, so the connection works
 * again when the owner turns AI back on.
 */

function guardsOf(controller: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
}

function httpContext(): ExecutionContext {
  const request = { headers: {} };
  ensureRequestState(request);
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function switches(platform: boolean, workspace: boolean): AiAccessSwitches {
  return {
    platformOn: async () => platform,
    organizationOn: async () => workspace,
    forget: () => undefined,
  };
}

describe('S14C platform AI switch — which routes it closes', () => {
  it('authorize, register, token and consent are all behind the platform switch guard', () => {
    for (const controller of [
      OAuthAuthorizeController,
      OAuthRegisterController,
      OAuthTokenController,
      OAuthConsentController,
    ]) {
      expect(guardsOf(controller)).toContain(AiPlatformSwitchGuard);
    }
  });

  it('revocation and the Connected apps page stay open, so an app can always be disconnected', () => {
    expect(guardsOf(OAuthRevokeController)).not.toContain(AiPlatformSwitchGuard);
    expect(guardsOf(ConnectedAppsController)).not.toContain(AiPlatformSwitchGuard);
  });

  it('the guard answers 503 ai_access_disabled while off and lets the request through while on', async () => {
    await expect(
      new AiPlatformSwitchGuard(switches(false, true)).canActivate(httpContext()),
    ).rejects.toMatchObject({ status: 503, auditCode: 'ai_access_disabled' });
    await expect(
      new AiPlatformSwitchGuard(switches(true, true)).canActivate(httpContext()),
    ).resolves.toBe(true);
  });
});

const ISSUER = 'https://tmanage.example';
const RESOURCE = `${ISSUER}/mcp`;
const VERIFIER = 'v'.repeat(64);
const REDIRECT = 'https://app.example/cb';

const database = {
  identityRead: (_o: unknown, fn: (db: unknown) => unknown) => fn({}),
  bootstrapRead: (_o: unknown, fn: (db: unknown) => unknown) => fn({}),
  identityTransaction: (_o: unknown, fn: (db: unknown) => unknown) => fn({}),
} as unknown as TenantDatabase;

function tokenService(workspaceOn: { value: boolean }) {
  const repository = {
    findCodeByHash: vi.fn(async () => ({
      codeHash: 'h',
      grantId: 'grant-1',
      challenge: codeChallengeS256(VERIFIER),
      redirectUri: REDIRECT,
      resource: RESOURCE,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    })),
    findGrantById: vi.fn(async () => ({
      id: 'grant-1',
      organizationId: 'org-1',
      clientPk: 'pk-1',
      membershipId: 'mem-1',
      userId: 'user-1',
      scopes: 'tmanage:read',
      revokedAt: null,
    })),
    findClientByClientId: vi.fn(async () => ({ id: 'pk-1', clientId: 'dcr-1' })),
    findRefreshTokenByHash: vi.fn(async () => ({
      tokenHash: 'r',
      familyId: 'fam-1',
      grantId: 'grant-1',
      parentHash: null,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
      revokedAt: null,
      createdAt: new Date(),
    })),
    spendCode: vi.fn(async () => true),
    spendRefreshToken: vi.fn(async () => true),
    revokeFamily: vi.fn(async () => undefined),
    revokeTokensByGrant: vi.fn(async () => undefined),
    insertAccessToken: vi.fn(async () => undefined),
    insertRefreshToken: vi.fn(async () => undefined),
  };
  const service = new OAuthService({
    database,
    repository: repository as unknown as OauthTokensRepository,
    issuer: ISSUER,
    canonicalResource: RESOURCE,
    aiAccess: {
      platformOn: async () => true,
      organizationOn: async () => workspaceOn.value,
      forget: () => undefined,
    },
  });
  return { service, repository };
}

const exchange = {
  code: 'code-1',
  codeVerifier: VERIFIER,
  redirectUri: REDIRECT,
  clientId: 'dcr-1',
  resource: RESOURCE,
};

describe('S14C workspace AI switch — no tokens, nothing spent', () => {
  it('code exchange answers 403 access_denied without spending the code; it works once AI is back on', async () => {
    const on = { value: false };
    const { service, repository } = tokenService(on);
    await expect(service.exchangeCode(exchange, 'corr')).rejects.toMatchObject({
      code: 'access_denied',
      httpStatus: 403,
    });
    expect(repository.spendCode).not.toHaveBeenCalled();
    expect(repository.insertAccessToken).not.toHaveBeenCalled();

    on.value = true;
    const tokens = await service.exchangeCode(exchange, 'corr');
    expect(tokens.token_type).toBe('Bearer');
    expect(repository.spendCode).toHaveBeenCalledOnce();
  });

  it('refresh answers 403 without spending the refresh token or revoking its family', async () => {
    const { service, repository } = tokenService({ value: false });
    await expect(
      service.refresh({ refreshToken: 'refresh-1', resource: RESOURCE }, 'corr'),
    ).rejects.toMatchObject({ code: 'access_denied', httpStatus: 403 });
    expect(repository.spendRefreshToken).not.toHaveBeenCalled();
    expect(repository.revokeFamily).not.toHaveBeenCalled();
    expect(repository.insertAccessToken).not.toHaveBeenCalled();
  });
});
