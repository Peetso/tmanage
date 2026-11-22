import type { PersonalAccessTokenRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { InsertPersonalAccessTokenInput } from './personal-access-tokens.repository.js';

/**
 * Test fakes (IP-14): an in-memory `personal_access_tokens` store with the methods
 * `AgentKeysService` uses, for the unit tests of 60-05 agent keys. Never wired in a module.
 */
export class MemoryTokens {
  readonly rows: PersonalAccessTokenRow[] = [];
  private next = 1;

  constructor(private readonly createdAt: Date = new Date('2026-11-21T09:00:00.000Z')) {}

  async listForMembership(_r: TenantQueryRunner, _c: TenantContext, membershipId: string) {
    return this.rows.filter((row) => row.membershipId === membershipId);
  }
  async findForMembership(
    _r: TenantQueryRunner,
    _c: TenantContext,
    membershipId: string,
    id: string,
  ) {
    return this.rows.find((row) => row.membershipId === membershipId && row.id === id);
  }
  async insert(_r: TenantQueryRunner, _c: TenantContext, input: InsertPersonalAccessTokenInput) {
    const row = {
      id: `k-${this.next++}`,
      organizationId: _c.organizationId,
      membershipId: input.membershipId,
      userId: input.userId,
      createdByMembershipId: input.createdByMembershipId ?? null,
      name: input.name,
      tokenHash: input.tokenHash,
      tokenPrefix: input.tokenPrefix,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      ipAllowlistJson: input.ipAllowlistJson ?? null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: this.createdAt,
    } as unknown as PersonalAccessTokenRow;
    this.rows.push(row);
    return row;
  }
  async revoke(
    _r: TenantQueryRunner,
    _c: TenantContext,
    membershipId: string,
    id: string,
    at: Date,
  ) {
    const row = this.rows.find(
      (r) => r.membershipId === membershipId && r.id === id && r.revokedAt === null,
    );
    if (row === undefined) return 0;
    (row as { revokedAt: Date | null }).revokedAt = at;
    return 1;
  }
  async endNoLaterThan(
    _r: TenantQueryRunner,
    _c: TenantContext,
    membershipId: string,
    id: string,
    until: Date,
  ) {
    const row = this.rows.find(
      (r) => r.membershipId === membershipId && r.id === id && r.revokedAt === null,
    );
    if (row === undefined || (row.expiresAt !== null && row.expiresAt <= until)) return 0;
    (row as { expiresAt: Date | null }).expiresAt = until;
    return 1;
  }
  async countLiveForMembership(
    _r: TenantQueryRunner,
    _c: TenantContext,
    membershipId: string,
    at: Date,
  ) {
    return this.rows.filter(
      (r) =>
        r.membershipId === membershipId &&
        r.revokedAt === null &&
        (r.expiresAt === null || r.expiresAt > at),
    ).length;
  }
}
