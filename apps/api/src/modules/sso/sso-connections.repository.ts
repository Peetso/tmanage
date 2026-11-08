import { and, eq, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { ssoConnections } from '../../common/database/schema.js';
import type { SsoConnectionRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 54-14 — storage for `sso_connections` (0327). The owner's reads and writes carry the
 * `organization_id` predicate through the tenant runner; the three sign-in reads run before any
 * organization is resolved and go through `bootstrapRead` with {@link SSO_BOOTSTRAP_REASON}.
 */

export const SSO_BOOTSTRAP_REASON =
  '54-14: company sign-in reads the OpenID Connect provider before an organization is resolved';

export interface SsoConnectionInput {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecretEnc: string;
  readonly allowedDomains: readonly string[];
  readonly enforceSso: boolean;
  readonly autoJoin: boolean;
}

/** What the sign-in paths need of a connection. */
export interface SsoSignInConnection {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecretEnc: string;
  readonly allowedDomains: string;
  readonly autoJoin: boolean;
}

/** One active membership of a person, with its organization's policy and SSO enforcement. */
export interface SsoMembershipRow {
  readonly kind: 'internal' | 'client';
  readonly role: string;
  readonly slug: string;
  readonly policy: unknown;
  readonly enforceSso: boolean;
}

const truthy = (value: unknown): boolean => value === 1 || value === true || value === '1';

function signInConnectionOf(row: Record<string, unknown>): SsoSignInConnection {
  return {
    id: String(row['id']),
    organizationId: String(row['organization_id']),
    slug: String(row['slug']),
    issuer: String(row['issuer']),
    clientId: String(row['client_id']),
    clientSecretEnc: String(row['client_secret_enc']),
    allowedDomains: String(row['allowed_domains']),
    autoJoin: truthy(row['auto_join']),
  };
}

const SIGN_IN_COLUMNS = `s.id, s.organization_id, o.slug, s.issuer, s.client_id, s.client_secret_enc,
  s.allowed_domains, s.auto_join`;

export class SsoConnectionsRepository {
  async find(runner: TenantQueryRunner, context: TenantContext): Promise<SsoConnectionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.organizationId, context.organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: SsoConnectionInput,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(ssoConnections)
      .values({
        id,
        organizationId: context.organizationId,
        issuer: input.issuer,
        clientId: input.clientId,
        clientSecretEnc: input.clientSecretEnc,
        allowedDomains: input.allowedDomains.join(','),
        enforceSso: input.enforceSso,
        autoJoin: input.autoJoin,
        createdBy: context.userId,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });
  }

  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: SsoConnectionInput,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(ssoConnections)
      .set({
        issuer: input.issuer,
        clientId: input.clientId,
        clientSecretEnc: input.clientSecretEnc,
        allowedDomains: input.allowedDomains.join(','),
        enforceSso: input.enforceSso,
        autoJoin: input.autoJoin,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(eq(ssoConnections.organizationId, context.organizationId), eq(ssoConnections.id, id)),
      );
  }

  async remove(runner: TenantQueryRunner, context: TenantContext): Promise<void> {
    await tenantDrizzle(runner)
      .delete(ssoConnections)
      .where(eq(ssoConnections.organizationId, context.organizationId));
  }

  /** Connections whose stored list may hold `domain`; the caller matches the list exactly. */
  async findByDomain(
    runner: BootstrapQueryRunner,
    domain: string,
  ): Promise<readonly SsoSignInConnection[]> {
    const escaped = domain.replace(/[\\%_]/gu, (c) => `\\${c}`);
    const rows = await runner.query<QueryRows>(
      `SELECT ${SIGN_IN_COLUMNS} FROM sso_connections s
         JOIN organizations o ON o.id = s.organization_id
        WHERE s.allowed_domains LIKE ? AND o.deleted_at IS NULL`,
      [`%${escaped}%`],
    );
    return rows.map(signInConnectionOf);
  }

  async findByOrganization(
    runner: BootstrapQueryRunner,
    organizationId: string,
  ): Promise<SsoSignInConnection | null> {
    const rows = await runner.query<QueryRows>(
      `SELECT ${SIGN_IN_COLUMNS} FROM sso_connections s
         JOIN organizations o ON o.id = s.organization_id
        WHERE s.organization_id = ? AND o.deleted_at IS NULL LIMIT 1`,
      [organizationId],
    );
    return rows[0] ? signInConnectionOf(rows[0]) : null;
  }

  /** Every active membership of a person with its policy document and `enforce_sso`. */
  async listMembershipsWithEnforcement(
    runner: BootstrapQueryRunner,
    userId: string,
  ): Promise<readonly SsoMembershipRow[]> {
    const internal = await runner.query<QueryRows>(
      `SELECT m.role AS role, o.slug AS slug, p.policy_json AS policy, s.enforce_sso AS enforce
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
         LEFT JOIN org_policies p ON p.organization_id = m.organization_id
         LEFT JOIN sso_connections s ON s.organization_id = m.organization_id
        WHERE m.user_id = ? AND m.status = 'active' AND m.platform_support_session_id IS NULL
          AND o.deleted_at IS NULL`,
      [userId],
    );
    const client = await runner.query<QueryRows>(
      `SELECT c.role AS role, o.slug AS slug, p.policy_json AS policy FROM client_memberships c
         JOIN organizations o ON o.id = c.organization_id
         LEFT JOIN org_policies p ON p.organization_id = c.organization_id
        WHERE c.user_id = ? AND c.status = 'active' AND o.deleted_at IS NULL`,
      [userId],
    );
    return [
      ...internal.map((row) => ({
        kind: 'internal' as const,
        role: String(row['role']),
        slug: String(row['slug']),
        policy: row['policy'],
        enforceSso: truthy(row['enforce']),
      })),
      ...client.map((row) => ({
        kind: 'client' as const,
        role: String(row['role']),
        slug: String(row['slug']),
        policy: row['policy'],
        enforceSso: false,
      })),
    ];
  }
}
