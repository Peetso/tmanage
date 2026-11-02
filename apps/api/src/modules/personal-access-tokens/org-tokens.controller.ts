import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  createParamDecorator,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { GrantsRepository } from '../oauth/grants.repository.js';
import { OauthTokensRepository } from '../oauth/oauth-tokens.repository.js';
import { isUnusedFor90Days, parseStoredScopes } from './personal-access-token.js';
import { PersonalAccessTokensRepository } from './personal-access-tokens.repository.js';

/**
 * R13 s3 (56-09) — the owner's org-wide view of API credentials.
 *
 * `GET …/security/tokens` lists every member's live personal access tokens together with the AI
 * apps connected through MCP OAuth, in one list; `DELETE …/security/tokens/:id` revokes one of
 * either kind. Both are behind `org.security.manage` (the security-admin gate the IP allowlist and
 * the Connected-apps owner view use) and, like the member's own token routes, need a real cookie
 * session: a token must never list or revoke tokens.
 *
 * Every read and write is scoped on the acting organization: a token or grant from another company
 * is invisible here and its id answers 404. "Unused for 90 days" is computed per row, no job. The
 * hashed last IP is not recorded yet (no column), so it is always `null` in this slice.
 */

export const ORG_TOKENS_SERVICE = Symbol.for('tmanage.OrgTokensService');

export type OrgCredentialKind = 'personal_access_token' | 'oauth_grant';

/** One credential in the owner overview. Never the secret, never the hash. */
export interface OrgCredentialView {
  readonly id: string;
  readonly kind: OrgCredentialKind;
  /** The token's name, or the connected app's name. */
  readonly name: string;
  readonly creatorName: string;
  readonly membershipId: string;
  /** The display hint (`tmanage_pat_a1b2c3…`) for a token; `null` for an app. */
  readonly tokenPrefix: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  /** Not recorded yet (no column); always `null`. */
  readonly lastIpHash: string | null;
  readonly createdAt: string;
  /** No use (or, never used, no creation) in the last 90 days. */
  readonly unusedFor90Days: boolean;
}

export class OrgTokensService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly tokens: PersonalAccessTokensRepository = new PersonalAccessTokensRepository(),
    private readonly grants: GrantsRepository = new GrantsRepository(),
    private readonly oauthTokens: OauthTokensRepository = new OauthTokensRepository(),
  ) {}

  /** Every live token and connected app in the acting organization, newest first. */
  async list(
    context: TenantContext,
    now: Date = new Date(),
  ): Promise<readonly OrgCredentialView[]> {
    return this.database.read(context, async (runner) => {
      const tokenRows = await this.tokens.listLiveForOrganization(runner, context, now);
      const grantRows = await this.grants.listLive(runner, context, null);
      const lastUsed = await this.grants.lastTokenIssuedAt(
        runner,
        grantRows.map((row) => row.id),
      );
      const views: OrgCredentialView[] = [
        ...tokenRows.map((row) => ({
          id: row.id,
          kind: 'personal_access_token' as const,
          name: row.name,
          creatorName: row.creatorName,
          membershipId: row.membershipId,
          tokenPrefix: row.tokenPrefix,
          scopes: parseStoredScopes(row.scopes),
          expiresAt: row.expiresAt?.toISOString() ?? null,
          lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          lastIpHash: null,
          createdAt: row.createdAt.toISOString(),
          unusedFor90Days: isUnusedFor90Days(row.lastUsedAt, row.createdAt, now),
        })),
        ...grantRows.map((row) => {
          const used = lastUsed.get(row.id) ?? null;
          return {
            id: row.id,
            kind: 'oauth_grant' as const,
            name: row.clientName,
            creatorName: row.memberName,
            membershipId: row.membershipId,
            tokenPrefix: null,
            scopes: parseStoredScopes(row.scopes),
            expiresAt: null,
            lastUsedAt: used?.toISOString() ?? null,
            lastIpHash: null,
            createdAt: row.createdAt.toISOString(),
            unusedFor90Days: isUnusedFor90Days(used, row.createdAt, now),
          };
        }),
      ];
      return views.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  /**
   * Revoke one credential in the acting organization, whoever created it: a personal access token
   * by id, else a connected app (the grant and every one of its OAuth tokens). Unknown, foreign or
   * already revoked is a 404.
   */
  async revoke(context: TenantContext, id: string): Promise<OrgCredentialKind> {
    return this.database.transaction(context, async (tx) => {
      const token = await this.tokens.revokeInOrganization(tx, context, id, new Date());
      if (token !== undefined) return 'personal_access_token';
      const changed = await this.grants.revokeGrant(tx, context, id, null);
      if (changed === 1) {
        await this.oauthTokens.revokeTokensByGrant(tx, id);
        return 'oauth_grant';
      }
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'credential_not_visible');
    });
  }
}

/** How `SessionAuthGuard` authenticated this request (server-set state, never the request). */
const AuthScheme = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    requestState(context.switchToHttp().getRequest())?.authScheme,
);

/** Token management is a session-only action: no token may list or revoke tokens. */
function requireInteractiveSession(authScheme: string | undefined): void {
  if (authScheme !== 'cookie') {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'session_required_for_token_management',
    );
  }
}

@Controller('v1/organizations/:orgSlug/security/tokens')
export class OrgTokensController {
  constructor(@Inject(ORG_TOKENS_SERVICE) private readonly service: OrgTokensService) {}

  /** Every member's live tokens and connected AI apps. `org.security.manage`, cookie session. */
  @Get()
  @RequireCapability('org.security.manage')
  async list(
    @Ctx() context: TenantContext,
    @AuthScheme() authScheme: string | undefined,
  ): Promise<{ readonly tokens: readonly OrgCredentialView[] }> {
    requireInteractiveSession(authScheme);
    return { tokens: await this.service.list(context) };
  }

  /** Revoke any member's token or connected app. `org.security.manage`, cookie session; 204. */
  @Delete(':id')
  @RequireCapability('org.security.manage')
  @HttpCode(204)
  async revoke(
    @Ctx() context: TenantContext,
    @Param('id') id: string,
    @AuthScheme() authScheme: string | undefined,
  ): Promise<void> {
    requireInteractiveSession(authScheme);
    if (typeof id !== 'string' || id === '' || id.length > 64) {
      throw new ApiError(400, 'validation_failed', 'id is required', [
        { field: 'id', message: 'must be a non-empty id' },
      ]);
    }
    await this.service.revoke(context, id);
  }
}
