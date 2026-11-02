import { evaluateSignIn, parseSignInPolicy } from '@tmanage/domain';
import type { SignInMethod } from '@tmanage/domain';
import type {
  BootstrapQueryRunner,
  QueryRows,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 56-25 (R18-e) — the data half of the organization sign-in policy.
 *
 * The policy lives in the organization's access-policy document (`org_policies.policy_json`, keys
 * `signin.*` / `security.*`); writing it goes through `PoliciesRepository.upsert`. This file holds
 * the reads the policy route and the sign-in paths need that the access-policy repository does not.
 *
 * ## The sign-in read is a bootstrap read
 *
 * At sign-in no organization is resolved yet, so "which organizations is this person in, and what
 * do their policies allow" is the same question `MembershipResolver` asks: an audited, read-only,
 * table-allowlisted bootstrap read keyed by the user id the correct password (or Google) proved.
 */

export const SIGN_IN_POLICY_REASON =
  'R18-e 56-25: the sign-in policies of the organizations a just-authenticated person belongs to';

const SIGN_IN_TABLES = ['memberships', 'client_memberships', 'organizations', 'org_policies'];

export interface SignInMembershipRow {
  readonly role: string;
  readonly slug: string;
  readonly policy: unknown;
}

export interface OwnerRecipient {
  readonly email: string;
  readonly locale: string | null;
}

export class SignInPolicyRepository {
  /** The acting organization's stored policy document (raw JSON), or `undefined`. */
  async readDocument(runner: TenantQueryRunner, context: TenantContext): Promise<unknown> {
    const rows = await runner.query<QueryRows>(
      'SELECT policy_json AS policy FROM org_policies WHERE organization_id = ? LIMIT 1',
      [context.organizationId],
    );
    return rows[0]?.['policy'];
  }

  /**
   * Active members and clients of the acting organization, owners excluded, holding no linked
   * identity for any of `providers` — the people a policy without `password` would lock out.
   */
  async countMembersWithout(
    runner: TenantQueryRunner,
    context: TenantContext,
    providers: readonly string[],
  ): Promise<number> {
    const list = providers.length > 0 ? providers : ['-'];
    const marks = list.map(() => '?').join(', ');
    const internal = await runner.query<QueryRows>(
      `SELECT COUNT(*) AS n FROM memberships m
        WHERE m.organization_id = ? AND m.status = 'active' AND m.role <> 'owner'
          AND m.platform_support_session_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_identities ui
                           WHERE ui.user_id = m.user_id AND ui.provider IN (${marks}))`,
      [context.organizationId, ...list],
    );
    const client = await runner.query<QueryRows>(
      `SELECT COUNT(*) AS n FROM client_memberships c
        WHERE c.organization_id = ? AND c.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM user_identities ui
                           WHERE ui.user_id = c.user_id AND ui.provider IN (${marks}))`,
      [context.organizationId, ...list],
    );
    return Number(internal[0]?.['n'] ?? 0) + Number(client[0]?.['n'] ?? 0);
  }

  /** The acting organization's active owners and their mail language. */
  async listOwners(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly OwnerRecipient[]> {
    const rows = await runner.query<QueryRows>(
      `SELECT u.email AS email, u.locale AS locale FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ? AND m.role = 'owner' AND m.status = 'active'`,
      [context.organizationId],
    );
    return rows.map((row) => ({
      email: String(row['email']),
      locale: typeof row['locale'] === 'string' ? row['locale'] : null,
    }));
  }

  /** Every active membership (internal and client) of a person, with its org's policy document. */
  async listSignInMemberships(
    runner: BootstrapQueryRunner,
    userId: string,
  ): Promise<readonly SignInMembershipRow[]> {
    const internal = await runner.query<QueryRows>(
      `SELECT m.role AS role, o.slug AS slug, p.policy_json AS policy FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
         LEFT JOIN org_policies p ON p.organization_id = m.organization_id
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
    return [...internal, ...client].map((row) => ({
      role: String(row['role']),
      slug: String(row['slug']),
      policy: row['policy'],
    }));
  }
}

/** A sign-in refused by every organization's policy: what to use instead, and which org said so. */
export interface SignInMethodRefusal {
  readonly use: readonly SignInMethod[];
  readonly organization: string;
}

/**
 * Decide whether a person who just proved who they are may sign in with `method`. The session is
 * global, so a person in several organizations is refused only when EVERY organization forbids the
 * method; a person in none is never refused here. Owners are exempt in their own organization. A
 * failed read throws — the caller fails closed (no session).
 */
export class SignInPolicyGate {
  constructor(
    private readonly database: Pick<TenantDatabase, 'bootstrapRead'>,
    private readonly repository: SignInPolicyRepository = new SignInPolicyRepository(),
  ) {}

  async check(
    userId: string,
    method: SignInMethod,
    correlationId: string,
  ): Promise<SignInMethodRefusal | null> {
    const rows = await this.database.bootstrapRead(
      { correlationId, reason: SIGN_IN_POLICY_REASON, tables: SIGN_IN_TABLES },
      (db) => this.repository.listSignInMemberships(db, userId),
    );
    return decideSignInMethod(rows, method);
  }
}

/** The pure half of {@link SignInPolicyGate.check}. */
export function decideSignInMethod(
  rows: readonly SignInMembershipRow[],
  method: SignInMethod,
): SignInMethodRefusal | null {
  let refusal: SignInMethodRefusal | null = null;
  for (const row of rows) {
    const verdict = evaluateSignIn({
      policy: parseSignInPolicy(row.policy),
      method,
      isOwner: row.role === 'owner',
    });
    if (verdict.ok) return null;
    refusal ??= { use: verdict.use, organization: row.slug };
  }
  return refusal;
}
