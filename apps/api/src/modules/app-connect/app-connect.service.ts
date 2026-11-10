import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { oauthFlowIsOwnersAndMatches } from '../../common/http/oauth-flow.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import type { AuditService } from '../audit/audit.service.js';
import { connectorBinding } from '../connectors/connectors.service.js';
import type { ConnectorsRepository } from '../connectors/connectors.repository.js';
import {
  AppConnectRefusedError,
  appConnectCallbackPath,
  newAppConnectFlow,
  type AppConnectFlow,
  type AppConnectProvider,
} from './app-connect.flow.js';
import {
  gitHubAuthorizeUrl,
  gitHubGrantIsAllowed,
  type GitHubClient,
  type GitHubOAuthConfig,
} from './github.oauth.js';

/**
 * FIX5 — one-click Connect for GitHub (owner/admin, `org.manage`). Slack and Microsoft Teams were
 * removed on 2026-11-10; their stored vault rows and channel links are left untouched.
 *
 * The token lives in the token vault (`connector_installations.credential_enc`, the SeedCipher
 * bound to the organization and the vault key, {@link connectorBinding}) under `github`, where a
 * pasted token goes too, and never leaves the server: a view says whether the app is set up and
 * connected, and the account's login, nothing more.
 *
 * A second Connect revokes the token it replaces at GitHub (best effort, after the new one is
 * stored). Connect and Disconnect are audited (`github_connection.connected` / `.disconnected`)
 * in the same transaction as the vault change. Disconnect revokes at GitHub (best effort) and
 * forgets the token.
 *
 * Security review L4: a token whose granted scope holds anything other than `read:user` (the
 * consent URL can be edited to ask for `repo`) is revoked at GitHub (best effort), never stored,
 * audited as a refused `github_connection.connected` (`reason: scope_too_wide`) and answered with
 * 400 `validation_failed`, detail `{ field: 'scope', message: 'scope_too_wide' }`.
 */

export const APP_CONNECT_SERVICE = Symbol.for('tmanage.AppConnectService');

export interface AppConnectView {
  readonly provider: AppConnectProvider;
  /** The server has this provider's app registered (its env vars are set). */
  readonly setUp: boolean;
  readonly connected: boolean;
  /** GitHub login; null when unknown. */
  readonly account: string | null;
}

export interface AppConnectDeps {
  readonly database: TenantDatabase;
  readonly cipher: SeedCipher;
  readonly vault: Pick<ConnectorsRepository, 'findByKey' | 'insert' | 'remove'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly config: {
    readonly github: GitHubOAuthConfig | null;
  };
  /** Where GitHub redirects back to (`{apiPublicUrl}/v1/integrations/github/callback`). */
  readonly apiPublicUrl: string;
  readonly github: GitHubClient;
  readonly log?: (message: string) => void;
}

const VAULT_KEY: Readonly<Record<AppConnectProvider, string>> = {
  github: 'github',
};

const NAMES: Readonly<Record<AppConnectProvider, string>> = {
  github: 'GitHub',
};

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request is invalid', [{ field, message }]);
}

/** The detail token the web page reads to explain a too-wide GitHub grant. */
export const SCOPE_TOO_WIDE = 'scope_too_wide';

function conflict(provider: AppConnectProvider, reason: string, message: string): ApiError {
  return new ApiError(
    409,
    'conflict',
    message,
    [{ field: 'provider', message: reason }],
    `app_connect_${provider}_${reason}`,
  );
}

export class AppConnectService {
  constructor(private readonly deps: AppConnectDeps) {}

  private requireManage(context: TenantContext, principal: Principal): void {
    const { allowed } = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'denied_org.manage');
    }
  }

  private setUp(provider: AppConnectProvider): boolean {
    return this.deps.config[provider] !== null && this.deps.apiPublicUrl !== '';
  }

  private requireSetUp(provider: AppConnectProvider): void {
    if (!this.setUp(provider)) {
      throw conflict(provider, 'not_configured', `${NAMES[provider]} is not set up yet`);
    }
  }

  redirectUri(provider: AppConnectProvider): string {
    return `${this.deps.apiPublicUrl.replace(/\/+$/, '')}${appConnectCallbackPath(provider)}`;
  }

  // ── The vault ──────────────────────────────────────────────────────────

  private async readSecret(context: TenantContext, provider: AppConnectProvider) {
    const key = VAULT_KEY[provider];
    const row = await this.deps.database.read(context, (runner) =>
      this.deps.vault.findByKey(runner, context, key),
    );
    if (!row?.credentialEnc) return null;
    try {
      return this.deps.cipher.decrypt(
        row.credentialEnc,
        connectorBinding(context.organizationId, key),
      );
    } catch {
      return null;
    }
  }

  private async audit(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    action: 'github_connection.connected' | 'github_connection.disconnected',
    metadata: Readonly<Record<string, string | boolean>>,
    result: 'allowed' | 'denied' = 'allowed',
  ): Promise<void> {
    await this.deps.audit.record(tx, context, {
      action,
      objectId: null,
      result,
      actorUserId: principal.userId,
      metadata,
    });
  }

  /** Revoke a token at GitHub, best effort: a failure is logged (never the token) and ignored. */
  private async revokeQuietly(provider: AppConnectProvider, token: string): Promise<void> {
    const config = this.deps.config.github;
    if (!config) return;
    try {
      await this.deps.github.revoke(config, token);
    } catch {
      this.deps.log?.(`[app-connect] ${provider} revoke failed; the token is forgotten locally`);
    }
  }

  // ── Status, start, complete ────────────────────────────────────────────

  async status(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
  ): Promise<AppConnectView> {
    this.requireManage(context, principal);
    return {
      provider,
      setUp: this.setUp(provider),
      connected: (await this.readSecret(context, provider)) !== null,
      account: null,
    };
  }

  start(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
    organizationSlug: string,
  ): { readonly url: string; readonly flow: AppConnectFlow } {
    this.requireManage(context, principal);
    this.requireSetUp(provider);
    const flow = newAppConnectFlow({
      provider,
      organizationId: context.organizationId,
      organizationSlug,
      membershipId: context.membershipId,
    });
    const url = gitHubAuthorizeUrl({
      config: this.deps.config.github!,
      redirectUri: this.redirectUri(provider),
      state: flow.state,
      verifier: flow.verifier,
    });
    return { url, flow };
  }

  async complete(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
    flow: AppConnectFlow | undefined,
    input: { readonly code?: unknown; readonly state?: unknown },
  ): Promise<AppConnectView> {
    this.requireManage(context, principal);
    this.requireSetUp(provider);
    if (!oauthFlowIsOwnersAndMatches(flow, context, input) || flow.provider !== provider) {
      throw invalid('state', 'the sign-in expired; press Connect again');
    }
    const code = input.code as string;
    const config = this.deps.config.github!;
    let accessToken: string;
    let login: string;
    let granted: string | null;
    try {
      ({ accessToken, scope: granted } = await this.deps.github.exchangeCode({
        config,
        redirectUri: this.redirectUri(provider),
        code,
        verifier: flow.verifier,
      }));
      // L4: refuse a too-wide grant before the token is used for anything.
      if (granted !== null && !gitHubGrantIsAllowed(granted)) {
        return await this.refuseGrant(context, principal, provider, accessToken);
      }
      let scopes: string | null;
      ({ login, scopes } = await this.deps.github.me(accessToken));
      // Only when the token response carried no `scope`: the header on the `/user` call.
      if (granted === null && scopes !== null && !gitHubGrantIsAllowed(scopes)) {
        return await this.refuseGrant(context, principal, provider, accessToken);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof AppConnectRefusedError) {
        throw invalid('code', `${NAMES[provider]} did not accept the sign-in; press Connect again`);
      }
      throw conflict(provider, 'unreachable', `${NAMES[provider]} is not reachable right now`);
    }

    const key = VAULT_KEY[provider];
    const previous = await this.readSecret(context, provider);
    const credentialEnc = this.deps.cipher.encrypt(
      accessToken,
      connectorBinding(context.organizationId, key),
    );
    await this.deps.database.transaction(context, async (tx) => {
      // One connection per provider: a second Connect replaces the first.
      await this.deps.vault.remove(tx, context, key);
      await this.deps.vault.insert(tx, context, {
        connectorKey: key,
        credentialEnc,
        credentialHint: accessToken.slice(-4),
      });
      await this.audit(tx, context, principal, 'github_connection.connected', {
        provider,
        replaced: previous !== null,
      });
    });
    // The replaced token would otherwise stay valid at GitHub; never block the new connection.
    if (previous !== null && previous !== accessToken) await this.revokeQuietly(provider, previous);
    return { provider, setUp: true, connected: true, account: login || null };
  }

  /**
   * L4: the grant holds more than `read:user`. Revoke the token at GitHub (best effort), store
   * nothing, audit the refusal (never the token), and fail the connection.
   */
  private async refuseGrant(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
    accessToken: string,
  ): Promise<never> {
    await this.revokeQuietly(provider, accessToken);
    await this.deps.database.transaction(context, (tx) =>
      this.audit(
        tx,
        context,
        principal,
        'github_connection.connected',
        { provider, reason: SCOPE_TOO_WIDE },
        'denied',
      ),
    );
    throw new ApiError(
      400,
      'validation_failed',
      `${NAMES[provider]} gave TManage more access than it asks for, so the connection was refused. Press Connect again and keep the requested access as it is.`,
      [{ field: 'scope', message: SCOPE_TOO_WIDE }],
      `app_connect_${provider}_${SCOPE_TOO_WIDE}`,
    );
  }

  // ── Disconnect ─────────────────────────────────────────────────────────

  async disconnect(
    context: TenantContext,
    principal: Principal,
    provider: AppConnectProvider,
  ): Promise<AppConnectView> {
    this.requireManage(context, principal);
    const plain = await this.readSecret(context, provider);
    // The provider being down must not keep the token here: it is forgotten anyway.
    if (plain !== null) await this.revokeQuietly(provider, plain);
    await this.deps.database.transaction(context, async (tx) => {
      const existing = await this.deps.vault.findByKey(tx, context, VAULT_KEY[provider]);
      await this.deps.vault.remove(tx, context, VAULT_KEY[provider]);
      if (existing !== null) {
        await this.audit(tx, context, principal, 'github_connection.disconnected', { provider });
      }
    });
    return { provider, setUp: this.setUp(provider), connected: false, account: null };
  }
}
