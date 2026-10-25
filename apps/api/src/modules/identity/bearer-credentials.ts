import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { GrantsRepository } from '../oauth/grants.repository.js';
import { OauthTokensRepository } from '../oauth/oauth-tokens.repository.js';
import { PersonalAccessTokensRepository } from '../personal-access-tokens/personal-access-tokens.repository.js';

/**
 * F19 (wave 9) — the per-user **bearer** cutoff.
 *
 * Every recovery lever (password reset, password change, "sign out other sessions", the
 * platform's "sign out everywhere") used to end only rows in `sessions`. A personal access token
 * (possibly non-expiring) or an AI app grant with its refresh family, minted by whoever held a
 * session before the recovery, kept working afterwards — while the reset mail promises
 * "Changing your password signs you out everywhere". This helper ends them too: every live
 * `personal_access_tokens` row and `oauth_grants` row the person holds, in **every** organization,
 * plus the access and refresh tokens issued under those grants.
 *
 * ## Why not inside the identity transaction
 *
 * Both tables are tenant-owned (`TENANT_TABLES`), and the identity runner refuses any statement
 * that mentions a tenant table — by design, it runs before any organization exists. So the
 * cutoff runs as one audited, read-only bootstrap read ("which organizations?") followed by one
 * ordinary tenant transaction per organization, each scoped on `organization_id`. Callers run it
 * **before** their identity transaction (a failure then refuses the whole recovery, so nothing is
 * half-done and the person can retry) and **again after** it commits (which closes the window in
 * which a session that was about to be revoked could still mint a token). Revoking is idempotent
 * (`revoked_at IS NULL` in every predicate), so the second pass is cheap and harmless.
 */

/** Why the one tenant-free read below may skip the tenant predicate (`bootstrapRead`). */
export const BEARER_CUTOFF_BOOTSTRAP_REASON =
  'finding every organization in which a person holds a personal access token or AI app grant, to end them after a recovery action';

/** The policy version stamped on the per-organization service context. */
const BEARER_CUTOFF_POLICY_VERSION = 'bearer-credential-cutoff';

export interface BearerCutoffResult {
  readonly personalAccessTokens: number;
  readonly grants: number;
}

/** The two database paths the cutoff needs, so a unit test can fake exactly these. */
export type BearerCutoffDatabase = Pick<TenantDatabase, 'bootstrapRead' | 'transaction'>;

/** What a recovery path depends on: one call that ends every bearer credential a person holds. */
export interface BearerCredentialCutoff {
  revokeAllForUser(
    database: BearerCutoffDatabase,
    input: { readonly userId: string; readonly correlationId: string },
  ): Promise<BearerCutoffResult>;
}

export class BearerCredentialsRevoker implements BearerCredentialCutoff {
  constructor(
    private readonly tokens: PersonalAccessTokensRepository = new PersonalAccessTokensRepository(),
    private readonly grants: GrantsRepository = new GrantsRepository(),
    private readonly oauthTokens: OauthTokensRepository = new OauthTokensRepository(),
  ) {}

  async revokeAllForUser(
    database: BearerCutoffDatabase,
    input: { readonly userId: string; readonly correlationId: string },
  ): Promise<BearerCutoffResult> {
    const { userId, correlationId } = input;
    const organizations = await database.bootstrapRead(
      {
        correlationId,
        reason: BEARER_CUTOFF_BOOTSTRAP_REASON,
        tables: ['personal_access_tokens', 'oauth_grants'],
      },
      async (db) => {
        const [withTokens, withGrants] = await Promise.all([
          this.tokens.listOrganizationsWithLiveTokens(db, userId),
          this.grants.listOrganizationsWithLiveGrants(db, userId),
        ]);
        return [...new Set([...withTokens, ...withGrants])];
      },
    );

    let personalAccessTokens = 0;
    let grants = 0;
    for (const organizationId of organizations) {
      const context = createServiceContext({
        organizationId,
        correlationId,
        policyVersion: BEARER_CUTOFF_POLICY_VERSION,
      });
      const ended = await database.transaction(context, async (tx) => {
        const tokenCount = await this.tokens.revokeAllForUser(tx, context, userId);
        const grantIds = await this.grants.revokeAllForUser(tx, context, userId);
        for (const grantId of grantIds) {
          await this.oauthTokens.revokeTokensByGrant(tx, grantId);
        }
        return { tokenCount, grantCount: grantIds.length };
      });
      personalAccessTokens += ended.tokenCount;
      grants += ended.grantCount;
    }
    return { personalAccessTokens, grants };
  }
}

/** The default cutoff. Stateless, so one shared instance is real, not a stand-in. */
export const BEARER_CREDENTIALS_REVOKER: BearerCredentialCutoff = new BearerCredentialsRevoker();

/**
 * `revokeAllBearerCredentialsForUser` — the name the wave-9 plan gives the cutoff. Ends every
 * personal access token and AI app grant (with its tokens) the person holds, in every organization.
 */
export function revokeAllBearerCredentialsForUser(
  database: BearerCutoffDatabase,
  userId: string,
  correlationId: string,
  cutoff: BearerCredentialCutoff = BEARER_CREDENTIALS_REVOKER,
): Promise<BearerCutoffResult> {
  return cutoff.revokeAllForUser(database, { userId, correlationId });
}
