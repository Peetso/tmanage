import { uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import {
  createServiceContext,
  type BootstrapQueryRunner,
  type TenantContext,
  type TenantDatabase,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PendingMfa } from '../google-auth/google-oidc.js';
import {
  GOOGLE_IDENTITY_TABLES,
  UserIdentitiesRepository,
} from '../google-auth/user-identities.repository.js';
import { CHALLENGE_TTL_SECONDS, signChallengeToken } from '../identity/challenge-token.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import type { SignInContext } from '../identity/authentication.service.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import {
  SSO_BOOTSTRAP_REASON,
  SsoConnectionsRepository,
  type SsoConnectionInput,
  type SsoSignInConnection,
} from './sso-connections.repository.js';
import type { SsoEnforcedSignInPolicyGate } from './sso-enforcement.js';
import {
  SSO_CALLBACK_PATH,
  SsoTokenRejectedError,
  emailDomain,
  isClaimableDomain,
  newSsoFlow,
  normalizeIssuer,
  parseDomainList,
  ssoAuthorizationUrl,
  tokenKeyId,
  verifySsoIdToken,
  type SsoClaims,
  type SsoFlow,
} from './sso-oidc.js';
import type { SsoTransport } from './sso-transport.js';

/**
 * 54-14 — company sign-in over OpenID Connect.
 *
 * **Settings** (owner only; `org.security.manage` at the route): one connection per organization.
 * The client secret is a FieldCipher envelope (`integration_token`, owner = row id) and never
 * leaves the server; without `FIELD_CIPHER_KEYS` nothing can be saved (409 `conflict`).
 *
 * **Sign-in**: the e-mail domain picks the organization (exactly one connection must list it).
 * At the callback, after the ID token checks: the token's address must be in an allowed domain
 * and belong to an existing TManage account whose address was proved. Membership is then
 * just-in-time only within the owner's rule — an active member signs in; an invited member's
 * membership becomes active; anyone else joins as `member` only when `auto_join` is on. The sign-in
 * policy (and "require company sign-in") is checked with method `sso`, and a second factor is still
 * required when the account has one.
 */

export const SSO_SIGN_IN_ACTION = 'sso_sign_in';
const MAX_DOMAINS = 20;
const SSO_PURPOSE = 'integration_token' as const;

/** The owner's view of the connection. Mirrors `apps/web/src/lib/api/sso.ts`. */
export interface SsoConnectionView {
  readonly configured: boolean;
  readonly issuer: string;
  readonly clientId: string;
  readonly hasClientSecret: boolean;
  readonly allowedDomains: readonly string[];
  readonly enforce: boolean;
  readonly autoJoin: boolean;
  /** What the owner registers at the provider. */
  readonly redirectUri: string;
  /** False when this server has no FIELD_CIPHER_KEYS: the secret cannot be stored. */
  readonly secretStorageReady: boolean;
  readonly updatedAt: string | null;
}

export type SsoRefusal =
  | 'not_set_up'
  | 'domain'
  | 'no_account'
  | 'unverified_account'
  | 'not_member'
  | 'method_not_allowed';

export type SsoOutcome =
  | { readonly kind: 'signed-in'; readonly userId: string; readonly returnTo: string }
  | { readonly kind: 'mfa'; readonly userId: string; readonly pending: PendingMfa }
  | { readonly kind: 'refused'; readonly reason: SsoRefusal };

export interface SsoServiceDeps {
  readonly database: TenantDatabase;
  readonly cipher: FieldCipher;
  readonly transport: SsoTransport;
  readonly credentials: Pick<
    CredentialsRepository,
    'listActiveFactors' | 'recordAuthenticationEvent'
  >;
  readonly sessionSecret: string;
  readonly webPublicUrl: string;
  readonly audit?: Pick<AuditService, 'record'>;
  readonly signInPolicy?: Pick<SsoEnforcedSignInPolicyGate, 'check'>;
  readonly repository?: SsoConnectionsRepository;
  readonly memberships?: MembershipsRepository;
  readonly identities?: UserIdentitiesRepository;
  readonly now?: () => number;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

/** The settings body, checked. `clientSecret` undefined = keep the stored one. */
export function parseSsoSettings(body: unknown): {
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  allowedDomains: string[];
  enforce: boolean;
  autoJoin: boolean;
} {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const issuer = normalizeIssuer(input['issuer']);
  if (!issuer) throw invalid('issuer', 'must be an https URL without a query');
  const clientId = typeof input['clientId'] === 'string' ? input['clientId'].trim() : '';
  if (clientId === '' || clientId.length > 255 || /[\s]/u.test(clientId)) {
    throw invalid('clientId', 'must be 1 to 255 characters without spaces');
  }
  const rawSecret = input['clientSecret'];
  let clientSecret: string | undefined;
  if (typeof rawSecret === 'string' && rawSecret.trim() !== '') {
    if (rawSecret.length > 2000) throw invalid('clientSecret', 'is too long');
    clientSecret = rawSecret.trim();
  } else if (rawSecret !== undefined && rawSecret !== null && rawSecret !== '') {
    throw invalid('clientSecret', 'must be text');
  }
  const rawDomains = input['allowedDomains'];
  if (!Array.isArray(rawDomains) || rawDomains.length === 0 || rawDomains.length > MAX_DOMAINS) {
    throw invalid('allowedDomains', `must list 1 to ${MAX_DOMAINS} domains`);
  }
  const allowedDomains = [
    ...new Set(rawDomains.map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : ''))),
  ];
  if (!allowedDomains.every(isClaimableDomain)) {
    throw invalid('allowedDomains', 'must be company domains (no public mail domains)');
  }
  if (typeof input['enforce'] !== 'boolean' || typeof input['autoJoin'] !== 'boolean') {
    throw invalid('enforce', 'enforce and autoJoin must be true or false');
  }
  return {
    issuer,
    clientId,
    clientSecret,
    allowedDomains,
    enforce: input['enforce'],
    autoJoin: input['autoJoin'],
  };
}

function requireOwner(principal: Principal): void {
  if (principal.kind !== 'internal' || principal.role !== 'owner') {
    throw new ApiError(403, 'forbidden', 'Only the company owner can change company sign-in.');
  }
}

export class SsoService {
  private readonly repository: SsoConnectionsRepository;
  private readonly memberships: MembershipsRepository;
  private readonly identities: UserIdentitiesRepository;
  private readonly now: () => number;

  constructor(private readonly deps: SsoServiceDeps) {
    this.repository = deps.repository ?? new SsoConnectionsRepository();
    this.memberships = deps.memberships ?? new MembershipsRepository();
    this.identities = deps.identities ?? new UserIdentitiesRepository();
    this.now = deps.now ?? Date.now;
  }

  redirectUri(): string {
    return `${this.deps.webPublicUrl.replace(/\/+$/u, '')}${SSO_CALLBACK_PATH}`;
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async read(context: TenantContext, principal: Principal): Promise<SsoConnectionView> {
    requireOwner(principal);
    const row = await this.deps.database.read(context, (runner) =>
      this.repository.find(runner, context),
    );
    return {
      configured: row !== null,
      issuer: row?.issuer ?? '',
      clientId: row?.clientId ?? '',
      hasClientSecret: row !== null,
      allowedDomains: row ? parseDomainList(row.allowedDomains) : [],
      enforce: row?.enforceSso ?? false,
      autoJoin: row?.autoJoin ?? false,
      redirectUri: this.redirectUri(),
      secretStorageReady: this.deps.cipher.enabled,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  }

  async save(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<SsoConnectionView> {
    requireOwner(principal);
    const settings = parseSsoSettings(body);
    if (!this.deps.cipher.enabled) {
      throw new ApiError(409, 'conflict', 'Secret storage is not set up on this server.');
    }
    await this.deps.database.transaction(context, async (tx) => {
      const existing = await this.repository.find(tx, context);
      if (!existing && settings.clientSecret === undefined) {
        throw invalid('clientSecret', 'is required for a new connection');
      }
      const id = existing?.id ?? uuidv7();
      const clientSecretEnc =
        settings.clientSecret === undefined
          ? (existing?.clientSecretEnc ?? '')
          : this.deps.cipher.encrypt(settings.clientSecret, { purpose: SSO_PURPOSE, ownerId: id });
      const input: SsoConnectionInput = {
        issuer: settings.issuer,
        clientId: settings.clientId,
        clientSecretEnc,
        allowedDomains: settings.allowedDomains,
        enforceSso: settings.enforce,
        autoJoin: settings.autoJoin,
      };
      if (existing) await this.repository.update(tx, context, id, input);
      else await this.repository.insert(tx, context, id, input);
      await this.deps.audit?.record(tx, context, {
        action: 'org.sign_in_policy_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: {
          change: existing ? 'sso_connection_updated' : 'sso_connection_created',
          sso_enforce: settings.enforce,
          sso_auto_join: settings.autoJoin,
          sso_domain_count: settings.allowedDomains.length,
          sso_secret_replaced: settings.clientSecret !== undefined,
        },
      });
    });
    return this.read(context, principal);
  }

  async remove(context: TenantContext, principal: Principal): Promise<SsoConnectionView> {
    requireOwner(principal);
    await this.deps.database.transaction(context, async (tx) => {
      const existing = await this.repository.find(tx, context);
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.repository.remove(tx, context);
      await this.deps.audit?.record(tx, context, {
        action: 'org.sign_in_policy_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { change: 'sso_connection_removed' },
      });
    });
    return this.read(context, principal);
  }

  // ── Sign-in ────────────────────────────────────────────────────────────────

  /** The provider's authorization URL for this address and the flow to seal in the cookie. */
  async start(
    email: unknown,
    correlationId: string,
  ): Promise<{ readonly url: string; readonly flow: SsoFlow } | null> {
    const domain = emailDomain(email);
    if (domain === null) return null;
    const candidates = await this.bootstrap(correlationId, (db) =>
      this.repository.findByDomain(db, domain),
    );
    const matches = candidates.filter((c) => parseDomainList(c.allowedDomains).includes(domain));
    // Two organizations listing one domain is ambiguous: refuse rather than guess.
    if (matches.length !== 1) return null;
    const connection = matches[0]!;
    const metadata = await this.deps.transport.discover(connection.issuer);
    const flow = newSsoFlow(connection.organizationId, Math.floor(this.now() / 1000));
    return {
      flow,
      url: ssoAuthorizationUrl({
        authorizationEndpoint: metadata.authorizationEndpoint,
        clientId: connection.clientId,
        redirectUri: this.redirectUri(),
        flow,
        loginHint: String(email).trim().toLowerCase(),
      }),
    };
  }

  /**
   * Exchange the code and verify the ID token. Throws {@link SsoTokenRejectedError} with the
   * reason; returns null when the organization's connection is gone.
   */
  async verify(
    flow: SsoFlow,
    code: string,
    correlationId: string,
  ): Promise<{ readonly claims: SsoClaims; readonly connection: SsoSignInConnection } | null> {
    const connection = await this.bootstrap(correlationId, (db) =>
      this.repository.findByOrganization(db, flow.organizationId),
    );
    if (!connection) return null;
    const clientSecret = this.deps.cipher.decrypt(connection.clientSecretEnc, {
      purpose: SSO_PURPOSE,
      ownerId: connection.id,
    });
    const metadata = await this.deps.transport.discover(connection.issuer);
    const { idToken } = await this.deps.transport.exchangeCode({
      tokenEndpoint: metadata.tokenEndpoint,
      code,
      clientId: connection.clientId,
      clientSecret,
      redirectUri: this.redirectUri(),
      verifier: flow.verifier,
    });
    let keys = await this.deps.transport.signingKeys(metadata.jwksUri);
    const kid = tokenKeyId(idToken);
    if (kid !== undefined && !keys.some((key) => key.kid === kid)) {
      keys = await this.deps.transport.signingKeys(metadata.jwksUri, true);
    }
    const claims = verifySsoIdToken({
      idToken,
      issuer: connection.issuer,
      clientId: connection.clientId,
      nonce: flow.nonce,
      keys,
      nowSeconds: Math.floor(this.now() / 1000),
    });
    return { claims, connection };
  }

  /** What a verified identity may do in the connection's organization. */
  async complete(
    connection: SsoSignInConnection,
    claims: SsoClaims,
    context: SignInContext,
  ): Promise<SsoOutcome> {
    const domain = emailDomain(claims.email);
    if (domain === null || !parseDomainList(connection.allowedDomains).includes(domain)) {
      await this.record(context, null, 'failed', 'sso_domain_not_allowed');
      return { kind: 'refused', reason: 'domain' };
    }
    const account = await this.deps.database.identityRead(
      { correlationId: context.correlationId, tables: [...GOOGLE_IDENTITY_TABLES] },
      (db) => this.identities.findUserByEmail(db, claims.email),
    );
    if (!account) {
      await this.record(context, null, 'failed', 'sso_no_account');
      return { kind: 'refused', reason: 'no_account' };
    }
    // An address nobody proved may be pre-registered by someone else (audit run 1, F03).
    if (!account.emailVerifiedAt) {
      await this.record(context, account.userId, 'failed', 'sso_unverified_account');
      return { kind: 'refused', reason: 'unverified_account' };
    }
    const joined = await this.ensureMembership(connection, account.userId, context);
    if (!joined) {
      await this.record(context, account.userId, 'failed', 'sso_not_member');
      return { kind: 'refused', reason: 'not_member' };
    }
    const refusal = await this.deps.signInPolicy?.check(
      account.userId,
      'sso',
      context.correlationId,
    );
    if (refusal) {
      await this.record(context, account.userId, 'failed', 'policy_method_not_allowed');
      return { kind: 'refused', reason: 'method_not_allowed' };
    }
    const factors = await this.deps.database.identityRead(
      { correlationId: context.correlationId, tables: [...GOOGLE_IDENTITY_TABLES] },
      (db) => this.deps.credentials.listActiveFactors(db, account.userId),
    );
    const returnTo = `/${encodeURIComponent(connection.slug)}/home`;
    if (factors.length > 0) {
      await this.record(context, account.userId, 'succeeded', 'mfa_required');
      const expiresAt = new Date(this.now() + CHALLENGE_TTL_SECONDS * 1000);
      return {
        kind: 'mfa',
        userId: account.userId,
        pending: {
          challengeToken: signChallengeToken(
            { userId: account.userId, expiresAt },
            this.deps.sessionSecret,
          ),
          expiresAt: expiresAt.toISOString(),
          factors: factors.map((f) => ({ id: f.id, kind: f.kind, label: f.label })),
          returnTo,
        },
      };
    }
    await this.record(context, account.userId, 'succeeded', joined === 'joined' ? 'sso_jit' : null);
    return { kind: 'signed-in', userId: account.userId, returnTo };
  }

  /**
   * `member` already active; `joined` when an invited membership was activated or, with
   * `auto_join`, a new `member` one created; `null` when the person may not come in.
   */
  private async ensureMembership(
    connection: SsoSignInConnection,
    userId: string,
    context: SignInContext,
  ): Promise<'member' | 'joined' | null> {
    const service = createServiceContext({
      organizationId: connection.organizationId,
      correlationId: context.correlationId,
      policyVersion: 'sso-sign-in',
    });
    return this.deps.database.transaction(service, async (tx) => {
      const current = await this.memberships.findByUserId(tx, service, userId);
      if (current?.status === 'active') return 'member';
      if (current?.status === 'invited') {
        await this.memberships.transitionStatus(tx, service, current.id, current.version, 'active');
        return 'joined';
      }
      if (current || !connection.autoJoin) return null;
      const invited = await this.memberships.invite(tx, service, { userId, role: 'member' });
      await this.memberships.transitionStatus(tx, service, invited.id, invited.version, 'active');
      return 'joined';
    });
  }

  async record(
    context: SignInContext,
    userId: string | null,
    outcome: 'succeeded' | 'failed',
    reason: string | null,
  ): Promise<void> {
    await this.deps.database.identityTransaction(
      { correlationId: context.correlationId, tables: [...GOOGLE_IDENTITY_TABLES] },
      (tx) =>
        this.deps.credentials.recordAuthenticationEvent(tx, {
          userId,
          action: SSO_SIGN_IN_ACTION,
          outcome,
          reason,
          ip: context.ip ?? null,
          userAgent: context.userAgent ?? null,
          correlationId: context.correlationId,
        }),
    );
  }

  private bootstrap<T>(
    correlationId: string,
    work: (db: BootstrapQueryRunner) => Promise<T>,
  ): Promise<T> {
    return this.deps.database.bootstrapRead(
      {
        correlationId,
        reason: SSO_BOOTSTRAP_REASON,
        tables: ['sso_connections', 'organizations'],
      },
      work,
    );
  }
}

export { SsoTokenRejectedError };
