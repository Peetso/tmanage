import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvitationRow } from '../../common/database/schema.js';
import { TenantContextGuard } from '../../common/http/guards/tenant-context.guard.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ClientMembershipsRepository } from '../clients/client-memberships.repository.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import type { PoliciesRepository } from '../admin/policies.repository.js';
import type { InvitationsRepository } from './invitations.repository.js';
import type { InviteeAccountsRepository } from './invitee-accounts.repository.js';
import type { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import type { MembershipsRepository } from './memberships.repository.js';
import { InvitationsService } from './invitations.service.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
  StaffClientRowsRepository,
} from './membership-resolver.repository.js';

/**
 * Wave 11 Q4 — M05 (security run 3). A staff member who also held an older client row in the same
 * company kept portal access after being suspended: the resolver only looked at *active* staff
 * rows, so with the staff row suspended the client row resolved on its own.
 *
 * Now (1) the resolver, on a client-only resolution, looks at the person's staff row in that
 * company: `suspended`, or `offboarded` at/after the client row's creation, refuses as
 * `staff_access_stopped` (mapped by the guard like every other refusal, so nothing leaks); a
 * client row created after offboarding (a real re-invite as client) still works; active staff
 * still resolve as staff (F27b). (2) Internal acceptance ends the person's open client rows in
 * the same transaction, each with an audit row.
 */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const USER = '0199aa00-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0199aa00-0000-7000-8000-0000000000b1';
const CLIENT_MEMBERSHIP = '0199aa00-0000-7000-8000-0000000000b2';
const CLIENT_ORG = '0199aa00-0000-7000-8000-0000000000d1';
const CORRELATION = '0199aa00-0000-7000-8000-0000000000e9';

const CLIENT_CREATED = Date.parse('2026-09-01T10:00:00Z');

interface Staff {
  readonly status: 'active' | 'invited' | 'suspended' | 'offboarded';
  /** When the staff row last changed (its suspension or offboarding). */
  readonly updatedAt: number;
}

/**
 * A bootstrap runner standing in for the database: the internal read returns the staff row only
 * when it is active (the real predicate), the client read returns the client row, and the staff
 * history read applies the predicate the SQL states — suspended, or offboarded at/after the
 * client row's `created_at` — which the test also checks is what the SQL says.
 */
function setup(options: { staff: Staff | null; client: boolean }) {
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const database = {
    bootstrapRead: async <T>(_o: unknown, work: (db: unknown) => Promise<T>) => {
      let call = 0;
      return work({
        query: async (sql: string, params: readonly unknown[]) => {
          call += 1;
          statements.push({ sql, params });
          if (call === 1) {
            return options.staff?.status === 'active'
              ? [[ORG, 1, MEMBERSHIP, 'manager', 1, 0, null, null]]
              : [];
          }
          if (call === 2) {
            return options.client
              ? [
                  [
                    ORG,
                    1,
                    CLIENT_MEMBERSHIP,
                    'client_admin',
                    '2026-10-18 10:00:00.000',
                    CLIENT_ORG,
                    null,
                  ],
                ]
              : [];
          }
          const staff = options.staff;
          if (!staff) return [];
          const stopped =
            staff.status === 'suspended' ||
            (staff.status === 'offboarded' && staff.updatedAt >= CLIENT_CREATED);
          return stopped ? [[staff.status]] : [];
        },
      });
    },
  } as unknown as TenantDatabase;
  const recordStandalone = vi.fn(async () => ({}) as never);
  const resolver = new MembershipResolver(database, {
    recordStandalone,
  } as unknown as AuditService);
  const resolve = () =>
    resolver.resolve({
      userId: USER,
      organization: { slug: 'northstar' },
      correlationId: CORRELATION,
    });
  return { resolver, resolve, statements, recordStandalone };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(MembershipNotResolvedError);
  return (error as MembershipNotResolvedError).code;
}

function guardOver(resolver: MembershipResolver) {
  const reflector = { getAllAndOverride: () => false } as never;
  const principals = { load: vi.fn(async () => ({})) } as never;
  const database = {
    read: vi.fn(async (ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({ ctx })),
  } as never;
  const guard = new TenantContextGuard(reflector, resolver as never, principals, database);
  const request = { params: { orgSlug: 'northstar' } };
  const state = requireRequestState(request);
  state.session = { sessionId: 's1', userId: USER };
  state.authScheme = 'cookie';
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard, context, principals, state };
}

describe('wave 11 Q4 — M05: a stopped staff member loses the older client row too', () => {
  it('(i) suspended staff + an older active client row: the resolver refuses', async () => {
    const { resolve, statements } = setup({
      staff: { status: 'suspended', updatedAt: CLIENT_CREATED + 86_400_000 },
      client: true,
    });
    expect(await code(resolve())).toBe('staff_access_stopped');

    // The history read is bound to the proved company, the person and the proved client row.
    const history = statements[2]!;
    expect(history.sql).toMatch(/from `memberships`/u);
    expect(history.sql).toMatch(
      /`memberships`\.`updated_at` >= `client_memberships`\.`created_at`/u,
    );
    expect(history.params).toEqual(
      expect.arrayContaining([CLIENT_MEMBERSHIP, ORG, USER, 'suspended', 'offboarded']),
    );
  });

  it('(i) the portal request is refused by the guard exactly like a non-member, no principal loaded', async () => {
    const stopped = guardOver(
      setup({ staff: { status: 'suspended', updatedAt: CLIENT_CREATED }, client: true }).resolver,
    );
    const stoppedError = await stopped.guard.canActivate(stopped.context).catch((e: unknown) => e);
    expect(stoppedError).toMatchObject({ auditCode: 'staff_access_stopped' });
    expect((stopped.principals as { load: ReturnType<typeof vi.fn> }).load).not.toHaveBeenCalled();
    expect(stopped.state.tenant).toBeUndefined();

    const outsider = guardOver(setup({ staff: null, client: false }).resolver);
    const outsiderError = await outsider.guard
      .canActivate(outsider.context)
      .catch((e: unknown) => e);
    // Same status, code and body: the refusal says nothing about the company.
    const { status, code: errorCode, message } = outsiderError as Record<string, unknown>;
    expect(stoppedError).toMatchObject({ status, code: errorCode, message });
    expect(status).toBeGreaterThanOrEqual(403);
  });

  it('(ii) offboarded staff + a client row created before offboarding: refused', async () => {
    const { resolve } = setup({
      staff: { status: 'offboarded', updatedAt: CLIENT_CREATED + 1 },
      client: true,
    });
    expect(await code(resolve())).toBe('staff_access_stopped');
    const sameInstant = setup({
      staff: { status: 'offboarded', updatedAt: CLIENT_CREATED },
      client: true,
    });
    expect(await code(sameInstant.resolve())).toBe('staff_access_stopped');
  });

  it('(ii) offboarded staff + a client row created after offboarding (a real re-invite): allowed', async () => {
    const { resolve } = setup({
      staff: { status: 'offboarded', updatedAt: CLIENT_CREATED - 86_400_000 },
      client: true,
    });
    const resolved = await resolve();
    expect(resolved.role).toBe('client_admin');
    expect(resolved.context.principalKind).toBe('client');
    expect(resolved.clientOrganizationId).toBe(CLIENT_ORG);
  });

  it('(iv) active staff + a client row still resolves as staff (F27b unchanged), no history read', async () => {
    const { resolve, statements, recordStandalone } = setup({
      staff: { status: 'active', updatedAt: CLIENT_CREATED },
      client: true,
    });
    const resolved = await resolve();
    expect(resolved.role).toBe('manager');
    expect(resolved.context.principalKind).toBe('internal');
    expect(statements).toHaveLength(2);
    expect(recordStandalone).toHaveBeenCalledTimes(1);
  });

  it('a client with no staff history at all is unaffected', async () => {
    const { resolve } = setup({ staff: null, client: true });
    await expect(resolve()).resolves.toMatchObject({ role: 'client_admin' });
  });
});

const TOKEN = 'A'.repeat(43);
const OWNER = '0199aa00-0000-7000-8000-0000000000a9';
const INVITATION = {
  id: 'inv-staff',
  organizationId: ORG,
  clientOrganizationId: null,
  email: 'sara@example.com',
  role: 'member',
  tokenHash: 'h'.repeat(64),
  status: 'pending',
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  invitedByUserId: OWNER,
  acceptedByUserId: null,
  acceptedAt: null,
  revokedAt: null,
  createdAt: new Date('2026-10-18T00:00:00Z'),
  updatedAt: new Date('2026-10-18T00:00:00Z'),
} as unknown as InvitationRow;

function acceptanceHarness() {
  const order: string[] = [];
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const clientUpdatedAt = new Date('2026-09-01T10:00:00.000Z');
  // The tenant transaction's runner: it answers the open-client-rows read with the older row.
  const runner = {
    query: vi.fn(async (sql: string, params: readonly unknown[]) => {
      statements.push({ sql, params });
      return [[CLIENT_MEMBERSHIP, CLIENT_ORG, 'active', '2026-09-01 10:00:00.000']];
    }),
  };
  const database = {
    bootstrapRead: (_o: unknown, work: (r: unknown) => Promise<unknown>) => work(runner),
    transaction: (_c: unknown, work: (r: unknown) => Promise<unknown>) => {
      order.push('transaction');
      return work(runner);
    },
  } as unknown as TenantDatabase;
  const invitations = {
    findPendingByTokenHash: vi.fn(() => Promise.resolve(INVITATION)),
    markAccepted: vi.fn(() => Promise.resolve({ ...INVITATION, status: 'accepted' })),
    projectIdsFor: vi.fn(() => Promise.resolve([])),
    addProjectMemberships: vi.fn(() => Promise.resolve(0)),
  } as unknown as InvitationsRepository;
  const memberships = {
    invite: vi.fn(() => Promise.resolve({ id: MEMBERSHIP, version: 1, role: 'member' })),
    transitionStatus: vi.fn(() => {
      order.push('staff_active');
      return Promise.resolve({ id: MEMBERSHIP, role: 'member' });
    }),
    findByUserId: vi.fn(() => Promise.resolve({ id: 'm-owner', role: 'owner', status: 'active' })),
  } as unknown as MembershipsRepository;
  const clientTransition = vi.fn(
    (_r: unknown, _c: TenantContext, id: string, _at: Date, to: string) => {
      order.push(`client_${to}`);
      return Promise.resolve({ id, status: to, clientOrganizationId: CLIENT_ORG });
    },
  );
  const clientMemberships = {
    transitionStatus: clientTransition,
  } as unknown as ClientMembershipsRepository;
  const record = vi.fn((_r: unknown, _c: unknown, input: { action: string }) => {
    order.push(input.action);
    return Promise.resolve({});
  });
  const service = new InvitationsService(
    database,
    invitations,
    memberships,
    clientMemberships,
    { record } as unknown as AuditService,
    undefined,
    { platformAdminEmails: [] },
    {} as InviteeAccountsRepository,
    {} as CredentialsRepository,
    {} as MemberBulkRoleRepository,
    { find: () => Promise.resolve(undefined) } as unknown as PoliciesRepository,
    new StaffClientRowsRepository(),
  );
  return { service, order, statements, clientTransition, record, runner, clientUpdatedAt };
}

describe('wave 11 Q4 — M05 (iii): internal acceptance ends the earlier client row', () => {
  it('offboards the open client row in the acceptance transaction and audits it', async () => {
    const { service, order, statements, clientTransition, record, runner, clientUpdatedAt } =
      acceptanceHarness();
    const accepted = await service.accept(TOKEN, USER, CORRELATION);
    expect(accepted).toMatchObject({ membershipId: MEMBERSHIP, clientOrganizationId: null });

    // The open-rows read is tenant-scoped, bound to this person, and skips ended rows.
    const read = statements.find((s) => /from `client_memberships`/u.test(s.sql))!;
    expect(read.sql).toMatch(/`client_memberships`\.`organization_id` = \?/u);
    expect(read.sql).toMatch(/`client_memberships`\.`status` <> \?/u);
    expect(read.params).toEqual([ORG, USER, 'offboarded']);

    expect(clientTransition).toHaveBeenCalledTimes(1);
    const [txRunner, , id, expected, to] = clientTransition.mock.calls[0]!;
    expect(txRunner).toBe(runner);
    expect(id).toBe(CLIENT_MEMBERSHIP);
    expect(expected.getTime()).toBe(clientUpdatedAt.getTime());
    expect(to).toBe('offboarded');

    expect(record).toHaveBeenCalledWith(
      runner,
      expect.objectContaining({ organizationId: ORG }),
      expect.objectContaining({
        action: 'client_membership.status_changed',
        objectId: CLIENT_MEMBERSHIP,
        result: 'allowed',
        metadata: expect.objectContaining({
          client_organization_id: CLIENT_ORG,
          status_before: 'active',
          status_after: 'offboarded',
          invitation_id: INVITATION.id,
        }),
      }),
    );
    // One transaction; the client row ends after the staff row is active, before the acceptance.
    expect(order).toEqual([
      'transaction',
      'staff_active',
      'client_offboarded',
      'client_membership.status_changed',
      'invitation.accepted',
    ]);
  });

  it('a failure ending the client row fails the whole acceptance (no staff row without it)', async () => {
    const { service, clientTransition, record } = acceptanceHarness();
    clientTransition.mockRejectedValueOnce(new Error('version conflict'));
    await expect(service.accept(TOKEN, USER, CORRELATION)).rejects.toThrow('version conflict');
    expect(record).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'invitation.accepted' }),
    );
  });
});
