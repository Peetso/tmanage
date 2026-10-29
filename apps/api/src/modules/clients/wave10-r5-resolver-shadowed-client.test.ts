import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
} from '../tenancy/membership-resolver.repository.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * Wave 10 R5 — F27 variant 2, defence in depth: a person who holds an active internal membership
 * and a live client row in the same company used to be refused as `principal_kind_ambiguous`,
 * which locked a staff member out of the whole tenant. The resolver now resolves the internal
 * principal (exactly what the internal row alone grants) and records one audit row naming the
 * ignored client row. A client row alone, or an internal row alone, resolve as before.
 */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const USER = '0199aa00-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0199aa00-0000-7000-8000-0000000000b1';
const CLIENT_MEMBERSHIP = '0199aa00-0000-7000-8000-0000000000b2';
const CLIENT_ORG = '0199aa00-0000-7000-8000-0000000000d1';
const CORRELATION = '0199aa00-0000-7000-8000-0000000000e9';

function setup(rows: { internal: boolean; client: boolean; clientOrg?: string }) {
  const database = {
    // PA-01: the resolver reads the member's live permission overrides on the scoped path.
    read: async () => ({ allow: [], deny: [] }),
    bootstrapRead: async <T>(_o: unknown, work: (db: unknown) => Promise<T>) => {
      let call = 0;
      return work({
        query: async () => {
          call += 1;
          if (call === 1) {
            return rows.internal ? [[ORG, 1, MEMBERSHIP, 'manager', 1, 0, null, null]] : [];
          }
          return rows.client
            ? [
                [
                  rows.clientOrg ?? ORG,
                  1,
                  CLIENT_MEMBERSHIP,
                  'client_admin',
                  '2026-10-18 10:00:00.000',
                  CLIENT_ORG,
                  null,
                ],
              ]
            : [];
        },
      });
    },
  } as unknown as TenantDatabase;
  const recordStandalone = vi.fn(async () => ({}) as never);
  const audit = { recordStandalone } as unknown as AuditService;
  const resolver = new MembershipResolver(database, audit);
  const resolve = () =>
    resolver.resolve({
      userId: USER,
      organization: { slug: 'northstar' },
      correlationId: CORRELATION,
    });
  return { resolve, recordStandalone };
}

describe('wave 10 R5 — F27b: staff with a leftover client row resolve as staff', () => {
  it('resolves the internal principal (not a refusal) and audits the shadowed client row once', async () => {
    const { resolve, recordStandalone } = setup({ internal: true, client: true });
    const resolved = await resolve();
    expect(resolved.role).toBe('manager');
    expect(resolved.clientOrganizationId).toBeNull();
    expect(resolved.context.principalKind).toBe('internal');
    expect(resolved.context.membershipId).toBe(MEMBERSHIP);
    expect(recordStandalone).toHaveBeenCalledTimes(1);
    expect(recordStandalone).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
      expect.objectContaining({
        action: 'client_membership.shadowed_by_internal',
        objectId: CLIENT_MEMBERSHIP,
        metadata: { client_organization_id: CLIENT_ORG, internal_membership_id: MEMBERSHIP },
      }),
    );

    await resolve();
    expect(recordStandalone).toHaveBeenCalledTimes(1);
  });

  it('still resolves as staff when the audit write fails', async () => {
    const { resolve, recordStandalone } = setup({ internal: true, client: true });
    recordStandalone.mockRejectedValueOnce(new Error('db down'));
    await expect(resolve()).resolves.toMatchObject({ role: 'manager' });
  });

  it('keeps rows from two different organizations fail-closed (principal_kind_ambiguous)', async () => {
    const other = '0199aa00-0000-7000-8000-0000000000c2';
    const { resolve, recordStandalone } = setup({ internal: true, client: true, clientOrg: other });
    const error = await resolve().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MembershipNotResolvedError);
    expect((error as MembershipNotResolvedError).code).toBe('principal_kind_ambiguous');
    expect(recordStandalone).not.toHaveBeenCalled();
  });

  it('leaves a client-only person a client principal, with no audit', async () => {
    const { resolve, recordStandalone } = setup({ internal: false, client: true });
    const resolved = await resolve();
    expect(resolved.role).toBe('client_admin');
    expect(resolved.clientOrganizationId).toBe(CLIENT_ORG);
    expect(recordStandalone).not.toHaveBeenCalled();
  });

  it('still refuses someone with neither row', async () => {
    const { resolve } = setup({ internal: false, client: false });
    const error = await resolve().catch((e: unknown) => e);
    expect((error as MembershipNotResolvedError).code).toBe('no_active_membership');
  });
});
