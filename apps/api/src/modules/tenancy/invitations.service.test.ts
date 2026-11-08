import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvitationRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import type { ClientMembershipsRepository } from '../clients/client-memberships.repository.js';
import type { ProjectClientsRepository } from '../clients/project-clients.repository.js';
import { InviteeAccountExistsError } from './invitee-accounts.repository.js';
import type { InviteeAccountsRepository } from './invitee-accounts.repository.js';
import { InvitationAlreadyPendingError } from './invitations.repository.js';
import type { InvitationsRepository } from './invitations.repository.js';
import type { MembershipsRepository } from './memberships.repository.js';
import type { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import type { StaffClientRowsRepository } from './membership-resolver.repository.js';
import { customRoleKey } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { PoliciesRepository } from '../admin/policies.repository.js';
import { withoutTokenForBoundCaller } from './invitations.controller.js';
import { requireMayGrantRole } from './role-grant-ceiling.js';
import {
  ACCOUNT_EXISTS_MESSAGE,
  ALREADY_MEMBER_MESSAGE,
  INVITATION_ALREADY_PENDING,
  InvitationsService,
  projectRoleForInvitation,
  requireOwnerToGrantOwner,
} from './invitations.service.js';

/**
 * The acceptance and registration paths, without a database.
 *
 * `apps/api/test/ten-003-invitations.db.test.ts` proves the SQL against a real server. This
 * file proves what the service decides around it — the two live failures the 2026-10-18
 * walkthroughs found:
 *
 * - **ACC-04.** Accepting while signed in to an account that already holds the membership hit
 *   `uq_memberships_org_user` and answered a bare 500, which `ID-03` rendered as "This
 *   invitation cannot be accepted any more". It must be a 409 that says "already a member".
 * - **ACC-01.** A brand-new invitee had no way to create an account. `register` creates it,
 *   from the invitation's own address, and grants the membership in the same transaction.
 *
 * And that every real refusal still refuses: a malformed or unknown token is 404 on both paths,
 * a weak password is 422, an address that already has an account is 409 — never a takeover.
 */

const TOKEN = 'A'.repeat(43);
const ORG = '01a14fe5-ada6-7287-922a-9079a2b2b004';
const OWNER = '01a14fe5-ada6-7287-922a-9079a2b2b001';
const USER = '01a14fe5-ada6-7287-922a-9079a2b2b002';
const CORR = '01a14fe5-ada6-7287-922a-9079a2b2b0cc';

const INVITATION: InvitationRow = {
  id: 'inv-1',
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

function duplicate(key: string): Error {
  return Object.assign(new Error(`Duplicate entry 'x' for key '${key}'`), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
  });
}

interface Harness {
  readonly service: InvitationsService;
  readonly insertUser: ReturnType<typeof vi.fn>;
  readonly setPassword: ReturnType<typeof vi.fn>;
  readonly invite: ReturnType<typeof vi.fn>;
  readonly markAccepted: ReturnType<typeof vi.fn>;
  readonly addProjectMemberships: ReturnType<typeof vi.fn>;
  readonly issue: ReturnType<typeof vi.fn>;
  readonly attachProjects: ReturnType<typeof vi.fn>;
  readonly share: ReturnType<typeof vi.fn>;
}

function harness(
  options: {
    readonly pending?: InvitationRow | undefined;
    readonly invite?: () => Promise<unknown>;
    readonly insertUser?: () => Promise<void>;
    /** A1: the invitation's live projects, and which ids the tenant holds live. */
    readonly projectIds?: readonly string[];
    readonly liveProjectIds?: readonly string[];
    /** F1: the organization's custom roles, by id. */
    readonly customRoles?: readonly { id: string; capabilitiesJson: string }[];
    /** F06: the inviter's membership at acceptance (default: an active owner). */
    readonly inviter?: { role: string; status: string } | null;
    /** F52b: the stored access-policy document, if any. */
    readonly policy?: unknown;
    /** F36b: invitations this organization created in the last hour. */
    readonly issuedLastHour?: number;
    /** NV04. */
    readonly platformAdminEmails?: readonly string[];
    readonly existingAccount?: boolean;
    /** R38 G4: accept as a client invitation of this client organization. */
    readonly clientOrganizationId?: string;
    /** R38 G4: projects already shared with that client organization. */
    readonly alreadyShared?: readonly string[];
  } = {},
): Harness {
  const pending = 'pending' in options ? options.pending : INVITATION;
  const runner = {};
  const database = {
    bootstrapRead: (_options: unknown, work: (runner: unknown) => Promise<unknown>) => work(runner),
    identityRead: (_options: unknown, work: (runner: unknown) => Promise<unknown>) => work(runner),
    transaction: (_context: unknown, work: (runner: unknown) => Promise<unknown>) => work(runner),
    invitationRegistrationTransaction: (
      _options: unknown,
      work: (scope: unknown) => Promise<unknown>,
    ) => work({ identity: runner, tenant: () => runner }),
  } as unknown as TenantDatabase;

  const markAccepted = vi.fn(() =>
    Promise.resolve({
      ...INVITATION,
      status: 'accepted',
      clientOrganizationId: options.clientOrganizationId ?? null,
    }),
  );
  const share = vi.fn((_r: unknown, _c: unknown, input: { projectId: string }) =>
    Promise.resolve({ id: `share-${input.projectId}` }),
  );
  const addProjectMemberships = vi.fn(
    (_r: unknown, _c: unknown, _u: string, ids: readonly string[]) => Promise.resolve(ids.length),
  );
  const issue = vi.fn((_r: unknown, _c: unknown, input: Record<string, unknown>) =>
    Promise.resolve({ ...INVITATION, ...input, id: 'inv-2' }),
  );
  const attachProjects = vi.fn(() => Promise.resolve());
  const invitations = {
    findPendingByTokenHash: vi.fn(() => Promise.resolve(pending)),
    markAccepted,
    projectIdsFor: vi.fn(() => Promise.resolve(options.projectIds ?? [])),
    addProjectMemberships,
    findPendingForEmail: vi.fn(() => Promise.resolve([])),
    liveProjectIds: vi.fn(() => Promise.resolve(options.liveProjectIds ?? [])),
    issue,
    attachProjects,
    countIssuedInLastHour: vi.fn(() => Promise.resolve(options.issuedLastHour ?? 0)),
    requireById: vi.fn(() => Promise.resolve(INVITATION)),
    revoke: vi.fn(() => Promise.resolve({ ...INVITATION, status: 'revoked' })),
    mailFactsById: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as InvitationsRepository;

  const invite = vi.fn(
    options.invite ?? (() => Promise.resolve({ id: 'm-1', version: 1, role: 'member' })),
  );
  const inviter = 'inviter' in options ? options.inviter : { role: 'owner', status: 'active' };
  const memberships = {
    invite,
    transitionStatus: vi.fn(() => Promise.resolve({ id: 'm-1', role: 'member' })),
    findByUserId: vi.fn((_r: unknown, _c: unknown, id: string) =>
      Promise.resolve(
        inviter && !(options.clientOrganizationId && id === USER)
          ? { id: 'm-inviter', userId: OWNER, ...inviter }
          : null,
      ),
    ),
  } as unknown as MembershipsRepository;

  const insertUser = vi.fn(options.insertUser ?? (() => Promise.resolve()));
  const setPassword = vi.fn(() => Promise.resolve());

  const service = new InvitationsService(
    database,
    invitations,
    memberships,
    {
      invite: () => Promise.resolve({ id: 'cm-1', updatedAt: new Date() }),
      transitionStatus: () =>
        Promise.resolve({
          id: 'cm-1',
          clientOrganizationId: options.clientOrganizationId,
          role: 'client_reviewer',
        }),
    } as unknown as ClientMembershipsRepository,
    undefined,
    undefined,
    { platformAdminEmails: options.platformAdminEmails ?? [] },
    { insertUser } as unknown as InviteeAccountsRepository,
    {
      setPassword,
      findUserIdByEmail: () =>
        Promise.resolve(options.existingAccount ? { id: USER, displayName: 'Ops' } : null),
    } as unknown as CredentialsRepository,
    {
      findRoleById: (_r: unknown, _c: unknown, id: string) =>
        Promise.resolve(options.customRoles?.find((role) => role.id === id)),
    } as unknown as MemberBulkRoleRepository,
    {
      find: () =>
        Promise.resolve(options.policy === undefined ? undefined : { policyJson: options.policy }),
    } as unknown as PoliciesRepository,
    // Wave 11 Q4 (M05): this harness's accepting account holds no client row to end.
    { openClientRowsOf: () => Promise.resolve([]) } as unknown as StaffClientRowsRepository,
    {
      find: (_r: unknown, _c: unknown, input: { projectId: string }) =>
        Promise.resolve(
          options.alreadyShared?.includes(input.projectId) ? { id: 'old' } : undefined,
        ),
      share,
    } as unknown as ProjectClientsRepository,
  );
  return {
    service,
    insertUser,
    setPassword,
    invite,
    markAccepted,
    addProjectMemberships,
    issue,
    attachProjects,
    share,
  };
}

async function refusal(work: Promise<unknown>): Promise<ApiError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('InvitationsService.accept', () => {
  it('ACC-04: says "already a member" (409) instead of a 500 when the membership exists', async () => {
    const { service } = harness({
      invite: () => Promise.reject(duplicate('uq_memberships_org_user')),
    });

    const error = await refusal(service.accept(TOKEN, OWNER, CORR));

    expect(error.status).toBe(409);
    expect(error.code).toBe('conflict');
    expect(error.message).toBe(ALREADY_MEMBER_MESSAGE);
    expect(error.details).toEqual([{ field: 'token', message: 'already_member' }]);
  });

  it('says the same for a client membership that already exists', async () => {
    const { service } = harness({
      invite: () => Promise.reject(duplicate('uq_client_memberships_identity')),
    });

    const error = await refusal(service.accept(TOKEN, OWNER, CORR));
    expect(error.status).toBe(409);
  });

  it('lets any other failure through untouched', async () => {
    const boom = new Error('connection lost');
    const { service } = harness({ invite: () => Promise.reject(boom) });

    await expect(service.accept(TOKEN, USER, CORR)).rejects.toBe(boom);
  });

  it('still refuses an unknown, used, revoked or expired token with the one 404', async () => {
    const { service } = harness({ pending: undefined });

    const error = await refusal(service.accept(TOKEN, USER, CORR));
    expect(error.status).toBe(404);
  });

  it('still refuses a malformed token without reading anything', async () => {
    const { service } = harness();

    const error = await refusal(service.accept('short', USER, CORR));
    expect(error.status).toBe(404);
  });
});

describe('InvitationsService.register (ACC-01)', () => {
  const strong = 'violet-harbour-lantern-41';

  it('creates the account from the invitation address, sets its password and joins', async () => {
    const { service, insertUser, setPassword, markAccepted } = harness();

    const result = await service.register(
      TOKEN,
      // An `email` in the body is ignored: the account is the invitation's address.
      { displayName: '  Sara Nabil ', password: strong, email: 'attacker@evil.test' } as never,
      CORR,
    );

    expect(insertUser).toHaveBeenCalledTimes(1);
    const user = insertUser.mock.calls[0]?.[1] as {
      email: string;
      displayName: string;
      id: string;
    };
    expect(user.email).toBe('sara@example.com');
    expect(user.displayName).toBe('Sara Nabil');
    expect(setPassword).toHaveBeenCalledWith({}, user.id, expect.stringMatching(/^\$argon2id\$/u));
    expect(markAccepted).toHaveBeenCalledWith({}, expect.anything(), 'inv-1', user.id);
    expect(result).toMatchObject({ userId: user.id, organizationId: ORG, role: 'member' });
  });

  it('refuses an address that already has an account (409), never touching it', async () => {
    const { service, setPassword } = harness({
      insertUser: () => Promise.reject(new InviteeAccountExistsError()),
    });

    const error = await refusal(
      service.register(TOKEN, { displayName: 'Sara', password: strong }, CORR),
    );

    expect(error.status).toBe(409);
    expect(error.message).toBe(ACCOUNT_EXISTS_MESSAGE);
    expect(setPassword).not.toHaveBeenCalled();
  });

  it('refuses a weak password and a missing name with field errors (422)', async () => {
    const { service, insertUser } = harness();

    const error = await refusal(
      service.register(TOKEN, { displayName: ' ', password: 'short' }, CORR),
    );

    expect(error.status).toBe(422);
    const fields = (error.details ?? []).map((detail) => detail.field);
    expect(fields).toContain('displayName');
    expect(fields).toContain('password');
    expect(insertUser).not.toHaveBeenCalled();
  });

  it('refuses an unusable token with the same 404 as acceptance', async () => {
    const { service, insertUser } = harness({ pending: undefined });

    const error = await refusal(
      service.register(TOKEN, { displayName: 'Sara', password: strong }, CORR),
    );

    expect(error.status).toBe(404);
    expect(insertUser).not.toHaveBeenCalled();
  });
});

describe('requireOwnerToGrantOwner (CQ-06)', () => {
  const caller = (role: Principal['role']) => ({ kind: 'internal', role }) as Principal;

  it('lets only an owner invite an owner; any role may invite below owner', () => {
    expect(() =>
      requireOwnerToGrantOwner(caller('owner'), 'owner', 'invitation.issue'),
    ).not.toThrow();
    expect(() =>
      requireOwnerToGrantOwner(caller('org_admin'), 'owner', 'invitation.issue'),
    ).toThrow(ApiError);
    expect(() =>
      requireOwnerToGrantOwner(caller('org_admin'), 'org_admin', 'invitation.issue'),
    ).not.toThrow();
  });
});

describe('A1: "Add to projects" and "Personal note" on an invitation', () => {
  const owner: Principal = {
    userId: OWNER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'm-owner',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
  const context = { organizationId: ORG, userId: OWNER } as unknown as TenantContext;
  const P1 = '01a14fe5-ada6-7287-922a-9079a2b2b0p1';
  const P2 = '01a14fe5-ada6-7287-922a-9079a2b2b0p2';

  it('adds the accepted invitee to the invitation projects, as their project role', async () => {
    const { service, addProjectMemberships } = harness({ projectIds: [P1, P2] });

    await service.accept(TOKEN, USER, CORR);

    expect(addProjectMemberships).toHaveBeenCalledWith(
      {},
      expect.anything(),
      USER,
      [P1, P2],
      'member',
    );
    expect(projectRoleForInvitation('manager')).toBe('manager');
    expect(projectRoleForInvitation('org_admin')).toBe('member');
  });

  it('stores the trimmed note and the projects at issue, granting nothing yet', async () => {
    const { service, issue, attachProjects, addProjectMemberships } = harness({
      liveProjectIds: [P1],
    });

    await service.issue(context, owner, {
      email: 'omar@example.com',
      role: 'manager',
      projectIds: [P1, P1],
      note: '  Welcome aboard  ',
    });

    expect(issue.mock.calls[0]?.[2]).toMatchObject({ note: 'Welcome aboard', role: 'manager' });
    expect(attachProjects).toHaveBeenCalledWith({}, context, 'inv-2', [P1]);
    expect(addProjectMemberships).not.toHaveBeenCalled();
  });

  it('refuses a project that is not live in this tenant (400), without a write', async () => {
    const { service, issue } = harness({ liveProjectIds: [P1] });

    const error = await refusal(
      service.issue(context, owner, {
        email: 'omar@example.com',
        role: 'member',
        projectIds: [P1, P2],
      }),
    );

    expect(error.status).toBe(400);
    expect(issue).not.toHaveBeenCalled();
  });

  it('R38 G4: stores the projects on a client invitation at issue, sharing nothing yet', async () => {
    const { service, attachProjects, share } = harness({ liveProjectIds: [P1, P2] });

    await service.issue(context, owner, {
      email: 'c@example.com',
      role: 'client_reviewer',
      clientOrganizationId: 'co-1',
      projectIds: [P1, P2],
    });

    expect(attachProjects).toHaveBeenCalledWith({}, context, 'inv-2', [P1, P2]);
    expect(share).not.toHaveBeenCalled();
  });

  it('R38 G4: a client admin may not tag projects on a client invitation (403, no write)', async () => {
    const { service, issue } = harness({ liveProjectIds: [P1] });
    const clientAdmin: Principal = {
      ...owner,
      kind: 'client',
      role: 'client_admin',
      clientOrganizationId: 'co-1',
      hasOrgWideScope: false,
    } as Principal;

    const error = await refusal(
      service.issue(context, clientAdmin, {
        email: 'c@example.com',
        role: 'client_reviewer',
        clientOrganizationId: 'co-1',
        projectIds: [P1],
      }),
    );

    expect(error.status).toBe(403);
    expect(error.details).toEqual([{ field: 'projectIds', message: 'project_not_manageable' }]);
    expect(issue).not.toHaveBeenCalled();
  });

  it('R38 G4: on acceptance shares each tagged project with the client company once', async () => {
    const { service, share } = harness({
      clientOrganizationId: 'co-1',
      projectIds: [P1, P2],
      alreadyShared: [P2],
    });

    await service.accept(TOKEN, USER, CORR);

    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({}, expect.anything(), {
      projectId: P1,
      clientOrganizationId: 'co-1',
    });
  });

  it('refuses a note over 500 characters (400)', async () => {
    const { service } = harness();

    const long = await refusal(
      service.issue(context, owner, {
        email: 'o@example.com',
        role: 'member',
        note: 'x'.repeat(501),
      }),
    );

    expect(long.status).toBe(400);
  });

  it('B11: a concurrent issue that loses the address claim is the named 409', async () => {
    const { service, issue } = harness();
    issue.mockRejectedValueOnce(new InvitationAlreadyPendingError());

    const error = await refusal(
      service.issue(context, owner, { email: 'o@example.com', role: 'member' }),
    );

    expect(error).toMatchObject({
      status: 409,
      details: [{ field: 'email', message: INVITATION_ALREADY_PENDING }],
    });
  });
});

describe('F1: an invitation with a custom role', () => {
  const ROLE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const REVIEWER = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
  const customRoles = [
    { id: ROLE, capabilitiesJson: '["work.read"]' },
    { id: REVIEWER, capabilitiesJson: '["approval.decide"]' },
  ];
  const as = (role: Principal['role']): Principal => ({
    userId: OWNER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-owner',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  });
  const context = { organizationId: ORG, userId: OWNER } as unknown as TenantContext;

  it('issues an internal invitation carrying the custom role id', async () => {
    const { service, issue } = harness({ customRoles });
    await service.issue(context, as('org_admin'), { email: 'omar@example.com', role: ROLE });
    expect(issue.mock.calls[0]?.[2]).toMatchObject({ role: ROLE });
  });

  it('400s a custom role id this organization does not have, without a write', async () => {
    const { service, issue } = harness({ customRoles });
    const error = await refusal(
      service.issue(context, as('owner'), {
        email: 'omar@example.com',
        role: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
      }),
    );
    expect(error.status).toBe(400);
    expect(issue).not.toHaveBeenCalled();
  });

  it('403s a custom role granting a right the inviter cannot grant', async () => {
    const { service, issue } = harness({ customRoles });
    const error = await refusal(
      service.issue(context, as('org_admin'), { email: 'omar@example.com', role: REVIEWER }),
    );
    expect(error.status).toBe(403);
    expect(issue).not.toHaveBeenCalled();
  });
});

describe('Wave 9 S3: who may issue what', () => {
  const DELEGATE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e';
  const as = (role: Principal['role'], kind: Principal['kind'] = 'internal'): Principal => ({
    userId: OWNER,
    organizationId: ORG,
    kind,
    role,
    membershipId: 'm-caller',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  });
  const delegate = as(customRoleKey(DELEGATE, ['org.manage']));
  const context = {
    organizationId: ORG,
    userId: OWNER,
    correlationId: CORR,
  } as unknown as TenantContext;
  const boundContext = { ...context, actorChannel: 'ai_assistant' } as unknown as TenantContext;

  it('F05: a custom org.manage holder cannot invite org_admin, workspace_admin or manager (403, no row)', async () => {
    for (const role of ['org_admin', 'workspace_admin', 'manager']) {
      const { service, issue } = harness();
      const error = await refusal(
        service.issue(context, delegate, { email: 'alias@example.test', role }),
      );
      expect(error.status).toBe(403);
      expect(error.auditCode).toBe('invitation.issue:role_escalation');
      expect(issue).not.toHaveBeenCalled();
    }
  });

  it('F05: an org admin still invites an org admin (issued)', async () => {
    const { service, issue } = harness();
    const issued = await service.issue(context, as('org_admin'), {
      email: 'alias@example.test',
      role: 'org_admin',
    });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(issued.token.length).toBeGreaterThan(20);
  });

  it('F05: a re-issue cannot switch the role to org_admin for a custom-role holder (403, no write)', async () => {
    const { service, issue } = harness();
    const error = await refusal(service.reissue(context, delegate, 'inv-1', { role: 'org_admin' }));
    expect(error.status).toBe(403);
    expect(issue).not.toHaveBeenCalled();
  });

  it('F05: the shared ceiling — owner only for owner; a client admin within its own ceiling', () => {
    expect(() => requireMayGrantRole(as('org_admin'), 'owner', ORG, 'x')).toThrow(ApiError);
    expect(() => requireMayGrantRole(as('owner'), 'owner', ORG, 'x')).not.toThrow();
    expect(() => requireMayGrantRole(as('org_admin'), 'workspace_admin', ORG, 'x')).not.toThrow();
    expect(() =>
      requireMayGrantRole(as('client_admin', 'client'), 'client_viewer', ORG, 'x'),
    ).not.toThrow();
    expect(() => requireMayGrantRole(delegate, 'member', ORG, 'x')).toThrow(ApiError);
  });

  it('F06: acceptance is refused (404) once the inviter is offboarded', async () => {
    const { service, markAccepted } = harness({
      pending: { ...INVITATION, role: 'org_admin' } as InvitationRow,
      inviter: { role: 'org_admin', status: 'offboarded' },
    });
    const error = await refusal(service.accept(TOKEN, USER, CORR));
    expect(error.status).toBe(404);
    expect(error.auditCode).toBe('invitation_inviter_revoked');
    expect(markAccepted).not.toHaveBeenCalled();
  });

  it('F06: acceptance is refused (404) once the inviter is demoted below the role', async () => {
    const { service, markAccepted } = harness({
      pending: { ...INVITATION, role: 'org_admin' } as InvitationRow,
      inviter: { role: 'member', status: 'active' },
    });
    expect((await refusal(service.accept(TOKEN, USER, CORR))).status).toBe(404);
    expect(markAccepted).not.toHaveBeenCalled();
  });

  it('F06: the normal path still accepts', async () => {
    const { service, markAccepted } = harness({ inviter: { role: 'org_admin', status: 'active' } });
    await service.accept(TOKEN, USER, CORR);
    expect(markAccepted).toHaveBeenCalledTimes(1);
  });

  it('F36b: the 51st invitation in an hour is refused with 429 and no row', async () => {
    const { service, issue } = harness({ issuedLastHour: 50 });
    const error = await refusal(
      service.issue(context, as('owner'), { email: 'n51@example.test', role: 'member' }),
    );
    expect(error.status).toBe(429);
    expect(issue).not.toHaveBeenCalled();
    const under = harness({ issuedLastHour: 49 });
    await under.service.issue(context, as('owner'), { email: 'n50@example.test', role: 'member' });
    expect(under.issue).toHaveBeenCalledTimes(1);
  });

  it('F52b: an address outside a non-empty invite domain allowlist is refused (422)', async () => {
    const { service, issue } = harness({ policy: { invite_domain_allowlist: ['studio.example'] } });
    const error = await refusal(
      service.issue(context, as('owner'), { email: 'x@elsewhere.example', role: 'member' }),
    );
    expect(error.status).toBe(422);
    expect(error.details).toEqual([{ field: 'email', message: 'invite_domain_not_allowed' }]);
    expect(issue).not.toHaveBeenCalled();
    await service.issue(context, as('owner'), { email: 'x@studio.example', role: 'member' });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('F52b: an empty allowlist allows every domain', async () => {
    const { service, issue } = harness({ policy: { invite_domain_allowlist: [] } });
    await service.issue(context, as('owner'), { email: 'x@anywhere.example', role: 'member' });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('F52b: a guest is refused while guest access is off, and issued once it is on', async () => {
    const off = harness();
    const error = await refusal(
      off.service.issue(context, as('owner'), { email: 'g@example.test', role: 'guest' }),
    );
    expect(error.status).toBe(422);
    expect(error.details).toEqual([{ field: 'role', message: 'guest_access_disabled' }]);
    expect(off.issue).not.toHaveBeenCalled();
    const on = harness({ policy: { guest_access_enabled: true } });
    await on.service.issue(context, as('owner'), { email: 'g@example.test', role: 'guest' });
    expect(on.issue).toHaveBeenCalledTimes(1);
  });

  it('NV04: an operator address with no account cannot be invited or registered (422)', async () => {
    const { service, issue, insertUser } = harness({
      platformAdminEmails: ['ops@dummy.test'],
      pending: { ...INVITATION, email: 'ops@dummy.test' } as InvitationRow,
    });
    const error = await refusal(
      service.issue(context, as('owner'), { email: 'ops@dummy.test', role: 'member' }),
    );
    expect(error.status).toBe(422);
    expect(issue).not.toHaveBeenCalled();
    const registration = await refusal(
      service.register(TOKEN, { displayName: 'Ops', password: 'violet-harbour-lantern-41' }, CORR),
    );
    expect(registration.status).toBe(422);
    expect(insertUser).not.toHaveBeenCalled();
    // An operator who already has an account is an ordinary invitee.
    const existing = harness({ platformAdminEmails: ['ops@dummy.test'], existingAccount: true });
    await existing.service.issue(context, as('owner'), { email: 'ops@dummy.test', role: 'member' });
    expect(existing.issue).toHaveBeenCalledTimes(1);
  });

  it('NV13: a bound token cannot invite an org admin (403) and never sees the raw token', async () => {
    const admin = harness();
    const error = await refusal(
      admin.service.issue(boundContext, as('owner'), {
        email: 'a@example.test',
        role: 'org_admin',
      }),
    );
    expect(error.status).toBe(403);
    expect(error.details).toEqual([
      { field: 'role', message: 'session_required_for_privileged_invite' },
    ]);
    expect(admin.issue).not.toHaveBeenCalled();

    const plain = harness();
    const issued = await plain.service.issue(boundContext, as('owner'), {
      email: 'm@example.test',
      role: 'member',
    });
    const body = withoutTokenForBoundCaller(boundContext, issued);
    expect('token' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain(issued.token);
    // A cookie session is unchanged.
    expect(withoutTokenForBoundCaller(context, issued)).toHaveProperty('token', issued.token);
  });
});
