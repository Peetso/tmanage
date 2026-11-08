import type { SignInMethod } from '@tmanage/domain';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import {
  SIGN_IN_POLICY_REASON,
  decideSignInMethod,
  type SignInMethodRefusal,
} from '../identity/sign-in-policy.repository.js';
import { SsoConnectionsRepository, type SsoMembershipRow } from './sso-connections.repository.js';

/**
 * 54-14 — "Require company sign-in". The organization sign-in policy gate (56-25) with one more
 * rule: in an organization whose connection has `enforce_sso`, an internal member who is not the
 * owner may sign in only with company sign-in. The owner keeps every method the policy allows
 * (break-glass: a broken provider must not lock the company out). Client accounts are outside
 * the company's identity provider and are judged by the policy alone.
 *
 * Same global-session rule as the policy gate: refused only when EVERY organization refuses the
 * method; a person in none is never refused here. A failed read throws (the caller fails closed).
 */

const ENFORCEMENT_TABLES = [
  'memberships',
  'client_memberships',
  'organizations',
  'org_policies',
  'sso_connections',
];

/** The pure half: the policy verdict per organization, with `enforce_sso` applied first. */
export function decideWithSsoEnforcement(
  rows: readonly SsoMembershipRow[],
  method: SignInMethod,
): SignInMethodRefusal | null {
  let refusal: SignInMethodRefusal | null = null;
  for (const row of rows) {
    const enforced =
      row.kind === 'internal' && row.enforceSso && row.role !== 'owner' && method !== 'sso';
    const verdict = enforced
      ? ({ use: ['sso'], organization: row.slug } satisfies SignInMethodRefusal)
      : decideSignInMethod([{ role: row.role, slug: row.slug, policy: row.policy }], method);
    if (verdict === null) return null;
    refusal ??= verdict;
  }
  return refusal;
}

export class SsoEnforcedSignInPolicyGate {
  constructor(
    private readonly database: Pick<TenantDatabase, 'bootstrapRead'>,
    private readonly repository: SsoConnectionsRepository = new SsoConnectionsRepository(),
  ) {}

  async check(
    userId: string,
    method: SignInMethod,
    correlationId: string,
  ): Promise<SignInMethodRefusal | null> {
    const rows = await this.database.bootstrapRead(
      { correlationId, reason: SIGN_IN_POLICY_REASON, tables: ENFORCEMENT_TABLES },
      (db) => this.repository.listMembershipsWithEnforcement(db, userId),
    );
    return decideWithSsoEnforcement(rows, method);
  }
}
