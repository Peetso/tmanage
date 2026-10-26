import { describe, expect, it, vi } from 'vitest';
import { customRoleKey } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvitationRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import type { ClientMembershipsRepository } from '../clients/client-memberships.repository.js';
import type { PoliciesRepository } from '../admin/policies.repository.js';
import { InviteeAccountsRepository } from './invitee-accounts.repository.js';
import type { InvitationsRepository } from './invitations.repository.js';
import type { MembershipsRepository } from './memberships.repository.js';
import type { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import {
  INVITATION_CLIENT_ISSUE_LIMIT_PER_HOUR,
  INVITATION_ISSUE_LIMIT_PER_HOUR,
  InvitationsService,
} from './invitations.service.js';

/**
 * Wave 10 lane R2 — security audit run 2, the invitation items. Each `it` is the exploit from
 * the report, and passes only because the exploit now fails.
 *
 * - F03 / NV04: registering an invitation no longer marks the address verified.
 * - F05: "Add to projects" is held to the inviter's own project authority.
 * - F27a: a client invitation cannot be accepted by a staff account of the same tenant.
 * - N05: client invitations count in their own bucket, never against the internal quota.
 */

const TOKEN = 'A'.repeat(43);
const ORG = '01a14fe5-ada6-7287-922a-9079a2b2b004';
const OWNER = '01a14fe5-ada6-7287-922a-9079a2b2b001';
const STAFF = '01a14fe5-ada6-7287-922a-9079a2b2b002';
const CLIENT_ORG = '01a14fe5-ada6-7287-922a-9079a2b2b0c0';
const CLIENT_ORG_2 = '01a14fe5-ada6-7287-922a-9079a2b2b0c2';
const CORR = '01a14fe5-ada6-7287-922a-9079a2b2b0cc';
const DELEGATE_ROLE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e';
const INVITED_ROLE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5f';
const P_ON = '01a14fe5-ada6-7287-922a-9079a2b2b0a1';
const P_OFF = '01a14fe5-ada6-7287-922a-9079a2b2b0a2';

const INVITATION: InvitationRow = {
  id: 'inv-1',
  organizationId: ORG,
  clientOrganizationId: null,
  email: 'victim@x.example',
  role: 'member',
  tokenHash: 'h'.repeat(64),
  status: 'pending',
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  invitedByUserId: OWNER,
  acceptedByUserId: null,
  acceptedAt: null,
  revokedAt: null,
  createdAt: new Date('2026-10-26T00:00:00Z'),
  updatedAt: new Date('2026-10-26T00:00:00Z'),
} as unknown as InvitationRow;

const context = { organizationId: ORG, userId: OWNER, correlationId: CORR } as TenantContext;

function principal(role: Principal['role'], overrides: Partial<Principal> = {}): Principal {
  return {
    userId: OWNER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-caller',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
    ...overrides,
  };
}

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** What a captured `insert into users (...) values (...)` wrote to each column. */
function insertedColumns(statement: Captured): Record<string, unknown> {
  const match = /insert into `users` \((.+?)\) values \((.+)\)/iu.exec(statement.sql);
  if (!match) throw new Error(`not a users insert: ${statement.sql}`);
  const columns = match[1]!.split(',').map((column) => column.trim().replaceAll('`', ''));
  const values = match[2]!.split(/,(?![^(]*\))/u).map((value) => value.trim());
  const params = [...statement.params];
  const row: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    const value = values[index] ?? '';
    if (value === '?') row[column] = params.shift();
    else if (/^(?:null|default)$/iu.test(value)) row[column] = null;
    else row[column] = { sql: value };
  });
  return row;
}

interface Options {
  readonly pending?: InvitationRow;
  /** Every user's internal membership in the tenant, by user id. */
  readonly internalMembers?: Record<string, { role: string; status: string }>;
  readonly issuedLastHour?: (bucket: { clientOrganizationId: string | null }) => number;
  readonly projectIdsFor?: readonly string[];
  readonly liveProjectIds?: readonly string[];
}

function harness(options: Options = {}) {
  const pending = options.pending ?? INVITATION;
  const captured: Captured[] = [];
  const identityRunner = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      captured.push({ sql, params });
      return { affectedRows: 1, insertId: 0 };
    }),
  };
  const tenantRunner = {};
  const database = {
    bootstrapRead: (_o: unknown, work: (r: unknown) => Promise<unknown>) => work(tenantRunner),
    identityRead: (_o: unknown, work: (r: unknown) => Promise<unknown>) => work(tenantRunner),
    transaction: (_c: unknown, work: (r: unknown) => Promise<unknown>) => work(tenantRunner),
    invitationRegistrationTransaction: (_o: unknown, work: (scope: unknown) => Promise<unknown>) =>
      work({ identity: identityRunner, tenant: () => tenantRunner }),
  } as unknown as TenantDatabase;

  const issue = vi.fn((_r: unknown, _c: unknown, input: Record<string, unknown>) =>
    Promise.resolve({ ...INVITATION, ...input, id: 'inv-2' }),
  );
  const revoke = vi.fn(() => Promise.resolve({ ...pending, status: 'revoked' }));
  const countIssuedInLastHour = vi.fn(
    (_r: unknown, _c: unknown, bucket: { clientOrganizationId: string | null }) =>
      Promise.resolve(options.issuedLastHour?.(bucket) ?? 0),
  );
  const invitations = {
    findPendingByTokenHash: vi.fn(() => Promise.resolve(pending)),
    markAccepted: vi.fn(() => Promise.resolve({ ...pending, status: 'accepted' })),
    projectIdsFor: vi.fn(() => Promise.resolve(options.projectIdsFor ?? [])),
    addProjectMemberships: vi.fn(() => Promise.resolve(0)),
    findPendingForEmail: vi.fn(() => Promise.resolve([])),
    liveProjectIds: vi.fn((_r: unknown, _c: unknown, ids: readonly string[]) =>
      Promise.resolve(options.liveProjectIds ?? ids),
    ),
    issue,
    attachProjects: vi.fn(() => Promise.resolve()),
    countIssuedInLastHour,
    requireById: vi.fn(() => Promise.resolve(pending)),
    revoke,
    mailFactsById: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as InvitationsRepository;

  const internalMembers = options.internalMembers ?? {
    [OWNER]: { role: 'owner', status: 'active' },
  };
  const memberships = {
    invite: vi.fn(() => Promise.resolve({ id: 'm-new', version: 1, role: 'member' })),
    transitionStatus: vi.fn(() => Promise.resolve({ id: 'm-new', role: 'member' })),
    findByUserId: vi.fn((_r: unknown, _c: unknown, userId: string) => {
      const found = internalMembers[userId];
      return Promise.resolve(found ? { id: `m-${userId}`, userId, ...found } : null);
    }),
  } as unknown as MembershipsRepository;

  const clientInvite = vi.fn(() =>
    Promise.resolve({ id: 'cm-1', updatedAt: new Date(), clientOrganizationId: CLIENT_ORG }),
  );
  const clientMemberships = {
    invite: clientInvite,
    transitionStatus: vi.fn(() =>
      Promise.resolve({ id: 'cm-1', clientOrganizationId: CLIENT_ORG, role: 'client_member' }),
    ),
    findByUser: vi.fn(() =>
      Promise.resolve({ status: 'active', role: 'client_admin', expiresAt: null }),
    ),
  } as unknown as ClientMembershipsRepository;

  const setPassword = vi.fn(() => Promise.resolve());
  const service = new InvitationsService(
    database,
    invitations,
    memberships,
    clientMemberships,
    undefined,
    undefined,
    { platformAdminEmails: [] },
    new InviteeAccountsRepository(),
    {
      setPassword,
      findUserIdByEmail: () => Promise.resolve(null),
    } as unknown as CredentialsRepository,
    {
      findRoleById: (_r: unknown, _c: unknown, id: string) =>
        Promise.resolve(
          id === INVITED_ROLE ? { id, capabilitiesJson: '["work.read"]' } : undefined,
        ),
    } as unknown as MemberBulkRoleRepository,
    { find: () => Promise.resolve(undefined) } as unknown as PoliciesRepository,
  );
  return { service, captured, issue, revoke, clientInvite, countIssuedInLastHour, setPassword };
}

async function refusal(work: Promise<unknown>): Promise<ApiError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('F03 / NV04: an invitation registration does not verify the address', () => {
  it('owner invites victim@x and registers with the token -> users.email_verified_at is NULL', async () => {
    // The owner holds the raw token: the issue response returns it (ON-06 "copy link").
    const { service, captured } = harness();
    const registered = await service.register(
      TOKEN,
      { displayName: 'Victim', password: 'violet-harbour-lantern-41' },
      CORR,
    );
    expect(registered.userId).toBeTruthy();

    const insert = captured.find((statement) => /insert into `users`/iu.test(statement.sql));
    expect(insert).toBeDefined();
    const row = insertedColumns(insert!);
    expect(row['email']).toBe('victim@x.example');
    expect('email_verified_at' in row).toBe(true);
    expect(row['email_verified_at']).toBeNull();
  });
});

describe('F05: invitation projects within the inviter project authority', () => {
  // The invited role is a custom role from Control > Roles granting `work.read`; the delegate
  // holds org.manage, that capability (so the role-escalation guard passes) and
  // project.member.manage, and is a member of P_ON only.
  const delegateCaps = ['org.manage', 'project.member.manage', 'work.read'];

  it('a custom delegate inviting into a project they are not on -> 403, no row', async () => {
    const delegate = principal(customRoleKey(DELEGATE_ROLE, delegateCaps), { projectIds: [P_ON] });
    const { service, issue } = harness();
    const error = await refusal(
      service.issue(context, delegate, {
        email: 'new@x.example',
        role: INVITED_ROLE,
        projectIds: [P_ON, P_OFF],
      }),
    );
    expect(error.status).toBe(403);
    expect(error.auditCode).toMatch(/^invitation\.issue:project_authority:/u);
    expect(issue).not.toHaveBeenCalled();
  });

  it('a delegate without project.member.manage cannot add even their own project (403)', async () => {
    const delegate = principal(customRoleKey(DELEGATE_ROLE, ['org.manage']), {
      projectIds: [P_ON],
    });
    const { service, issue } = harness();
    const error = await refusal(
      service.issue(context, delegate, {
        email: 'new@x.example',
        role: INVITED_ROLE,
        projectIds: [P_ON],
      }),
    );
    expect(error.status).toBe(403);
    expect(error.auditCode).toMatch(/^invitation\.issue:project_authority:/u);
    expect(issue).not.toHaveBeenCalled();
  });

  it('the same delegate may add people to their own project (issued)', async () => {
    const delegate = principal(customRoleKey(DELEGATE_ROLE, delegateCaps), { projectIds: [P_ON] });
    const { service, issue } = harness();
    await service.issue(context, delegate, {
      email: 'new@x.example',
      role: INVITED_ROLE,
      projectIds: [P_ON],
    });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('a re-issue by the delegate cannot carry a project they are not on (403, nothing revoked)', async () => {
    const delegate = principal(customRoleKey(DELEGATE_ROLE, delegateCaps), { projectIds: [P_ON] });
    const { service, issue, revoke } = harness({
      pending: { ...INVITATION, role: INVITED_ROLE } as InvitationRow,
      projectIdsFor: [P_OFF],
    });
    const error = await refusal(service.reissue(context, delegate, 'inv-1', {}));
    expect(error.status).toBe(403);
    expect(error.auditCode).toMatch(/^invitation\.reissue:project_authority:/u);
    expect(revoke).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it('org_admin still invites into any project (201 path)', async () => {
    const admin = principal('org_admin', { hasOrgWideScope: true });
    const { service, issue } = harness();
    const issued = await service.issue(context, admin, {
      email: 'new@x.example',
      role: 'member',
      projectIds: [P_ON, P_OFF],
    });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(issued.token.length).toBeGreaterThan(20);
  });
});

describe('F27a: a client invitation cannot be accepted by a staff account', () => {
  const portalInvitation = {
    ...INVITATION,
    clientOrganizationId: CLIENT_ORG,
    role: 'client_member',
  } as InvitationRow;

  it("a client_admin's portal invitation accepted by an active staff account -> 409, no client membership", async () => {
    const { service, clientInvite } = harness({
      pending: portalInvitation,
      internalMembers: {
        [OWNER]: { role: 'owner', status: 'active' },
        [STAFF]: { role: 'member', status: 'active' },
      },
    });
    const error = await refusal(service.accept(TOKEN, STAFF, CORR));
    expect(error.status).toBe(409);
    expect(error.auditCode).toBe('invitation_internal_member');
    expect(error.message).not.toMatch(/staff|internal|member/iu);
    expect(clientInvite).not.toHaveBeenCalled();
  });

  it('a suspended staff account is refused too; an offboarded one and an outsider are not', async () => {
    const suspended = harness({
      pending: portalInvitation,
      internalMembers: { [STAFF]: { role: 'member', status: 'suspended' } },
    });
    expect((await refusal(suspended.service.accept(TOKEN, STAFF, CORR))).status).toBe(409);
    expect(suspended.clientInvite).not.toHaveBeenCalled();

    const offboarded = harness({
      pending: portalInvitation,
      internalMembers: { [STAFF]: { role: 'member', status: 'offboarded' } },
    });
    await offboarded.service.accept(TOKEN, STAFF, CORR);
    expect(offboarded.clientInvite).toHaveBeenCalledTimes(1);

    const outsider = harness({ pending: portalInvitation, internalMembers: {} });
    await outsider.service.accept(TOKEN, STAFF, CORR);
    expect(outsider.clientInvite).toHaveBeenCalledTimes(1);
  });
});

describe('N05: client invitations have their own hourly bucket', () => {
  const clientAdmin = principal('client_admin', {
    kind: 'client',
    clientOrganizationId: CLIENT_ORG,
  });
  const owner = principal('owner', { hasOrgWideScope: true });

  it('20 client invites from one client org -> the 21st is 429, a staff invite still issues', async () => {
    expect(INVITATION_CLIENT_ISSUE_LIMIT_PER_HOUR).toBe(20);
    // The world after 20 portal invitations from CLIENT_ORG this hour, and none internal.
    const counts = (bucket: { clientOrganizationId: string | null }) =>
      bucket.clientOrganizationId === CLIENT_ORG ? INVITATION_CLIENT_ISSUE_LIMIT_PER_HOUR : 0;

    const client = harness({ issuedLastHour: counts });
    const error = await refusal(
      client.service.issue(context, clientAdmin, {
        email: 'c21@client.example',
        role: 'client_member',
        clientOrganizationId: CLIENT_ORG,
      }),
    );
    expect(error.status).toBe(429);
    expect(client.issue).not.toHaveBeenCalled();
    expect(client.countIssuedInLastHour).toHaveBeenCalledWith(expect.anything(), context, {
      clientOrganizationId: CLIENT_ORG,
    });

    const staff = harness({ issuedLastHour: counts });
    await staff.service.issue(context, owner, { email: 'staff@x.example', role: 'member' });
    expect(staff.issue).toHaveBeenCalledTimes(1);
    expect(staff.countIssuedInLastHour).toHaveBeenCalledWith(expect.anything(), context, {
      clientOrganizationId: null,
    });

    // Another client organization is its own bucket as well.
    const other = harness({ issuedLastHour: counts });
    await other.service.issue(context, owner, {
      email: 'c@other.example',
      role: 'client_member',
      clientOrganizationId: CLIENT_ORG_2,
    });
    expect(other.issue).toHaveBeenCalledTimes(1);
  });

  it('the internal quota is unchanged at 50', async () => {
    expect(INVITATION_ISSUE_LIMIT_PER_HOUR).toBe(50);
    const full = harness({
      issuedLastHour: (bucket) => (bucket.clientOrganizationId === null ? 50 : 0),
    });
    const error = await refusal(
      full.service.issue(context, owner, { email: 'n51@x.example', role: 'member' }),
    );
    expect(error.status).toBe(429);
  });
});
