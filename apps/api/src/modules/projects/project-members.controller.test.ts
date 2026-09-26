import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalRole, Principal, Role } from '@tmanage/domain';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import { CapabilityGuard } from '../../common/http/guards/capability.guard.js';
import { HttpExceptionFilter } from '../../common/http/http-exception.filter.js';
import { SessionNotAuthenticatedError } from '../identity/session.service.js';
import type { AuthenticatedSession } from '../identity/session.service.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  AUTHENTICATION_EVENT_RECORDER,
  MEMBERSHIPS_REPOSITORY,
  PROJECTS_REPOSITORY,
  PROJECT_MEMBERSHIPS_REPOSITORY,
  PROJECT_MEMBERSHIPS_SERVICE,
  SESSION_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { AuthenticationEventRecorder } from '../../common/http/authentication-event-recorder.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import { ProjectMembersController } from './project-members.controller.js';

/**
 * ADM-02 (x116). The HTTP surface for project member/role administration, proved over fakes with
 * the **real** `CapabilityGuard` and the **real** in-handler `authorize()`.
 *
 * What only this file proves — the service's own audit/transaction contract is
 * `aud-001-audit.db.test.ts`, and the repository's tenant scoping is the isolation corpus:
 *
 *  - the add→list→change-role→remove round trip, tenant-scoped, calls the command service;
 *  - the Known trap: an unknown/cross-tenant `projectId`, membership id or target `userId`
 *    resolves to **404 with no write**, never a 500;
 *  - a caller whose role does not include `project.member.manage` is **403** at the guard;
 *  - the escalation guards (the security substance): a caller cannot assign or act on a role
 *    above their own ceiling, cannot change their own role, and cannot strip the last owner —
 *    each **403 with no write**, so no audit row is written.
 */

const AUTHENTICATED: AuthenticatedSession = {
  userId: '0199aa00-0000-7000-8000-000000000001',
  sessionId: '0199aa00-0000-7000-8000-0000000000a1',
};
const ORG_ID = '0199aa00-0000-7000-8000-000000000010';
const MEMBERSHIP_ID = '0199aa00-0000-7000-8000-000000000020';
const PROJECT_ID = '0199aa00-0000-7000-8000-000000000100';
const OTHER_USER = '0199aa00-0000-7000-8000-000000000002';
const PM_ID = '0199aa00-0000-7000-8000-000000000200';
const COOKIE_NAME = 'tm_at';

/**
 * Stand in for `TenantContextGuard`, with the acting principal parameterised by headers so each
 * request can choose the caller's role and scope. Never read from a body — the role is a fact
 * about the session, and that is the property under test.
 */
@Injectable()
class TestContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
    }>();
    const state = ensureRequestState(request);
    if (!state.session) return true;

    const role = (request.headers['x-test-role'] ?? 'owner') as Role;
    const orgWide = request.headers['x-test-orgwide'] !== 'false';
    const projectIds = orgWide ? [] : [PROJECT_ID];

    state.tenant = createTenantContext({
      organizationId: ORG_ID,
      userId: state.session.userId,
      membershipId: MEMBERSHIP_ID,
      principalKind: 'internal',
      capabilities: [],
      policyVersion: '2026-09-19',
      correlationId: state.correlationId,
    });
    const principal: Principal = {
      userId: state.session.userId,
      organizationId: ORG_ID,
      kind: 'internal',
      role,
      membershipId: MEMBERSHIP_ID,
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds,
      hasOrgWideScope: orgWide,
    };
    state.principal = principal;
    return true;
  }
}

const projectFindById = vi.fn();
const memberFindByUserId = vi.fn();
const pmFindById = vi.fn();
const pmFindByProjectAndUser = vi.fn();
const pmListByProject = vi.fn();
const cmdAdd = vi.fn();
const cmdChangeRole = vi.fn();
const cmdRemove = vi.fn();

const database = {
  read: async (_ctx: unknown, fn: (runner: unknown) => unknown) => fn({}),
  transaction: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
};
const projects = { findById: projectFindById };
const memberships = { findByUserId: memberFindByUserId };
const projectMemberships = {
  findById: pmFindById,
  findByProjectAndUser: pmFindByProjectAndUser,
  listByProject: pmListByProject,
};
const command = { add: cmdAdd, changeRole: cmdChangeRole, remove: cmdRemove };

const sessions = {
  authenticate: vi.fn(async (input: { accessToken: string | undefined }) => {
    if (!input.accessToken) throw new SessionNotAuthenticatedError('no_cookie');
    return AUTHENTICATED;
  }),
};
const config = { cookieName: COOKIE_NAME } as unknown as ApiConfig;
const eventRecorder: AuthenticationEventRecorder = { recordGuardRefusal: () => {} };
/** The capability guard records denials; a no-op that reports nothing written keeps this focused. */
const audit = { recordDenial: vi.fn(async () => false) };

@Module({
  controllers: [ProjectMembersController],
  providers: [
    { provide: TENANT_DATABASE, useValue: database },
    { provide: PROJECTS_REPOSITORY, useValue: projects },
    { provide: MEMBERSHIPS_REPOSITORY, useValue: memberships },
    { provide: PROJECT_MEMBERSHIPS_REPOSITORY, useValue: projectMemberships },
    { provide: PROJECT_MEMBERSHIPS_SERVICE, useValue: command },
    { provide: SESSION_SERVICE, useValue: sessions },
    { provide: API_CONFIG, useValue: config },
    { provide: AUTHENTICATION_EVENT_RECORDER, useValue: eventRecorder },
    { provide: AUDIT_SERVICE, useValue: audit },
    { provide: Reflector, useClass: Reflector },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: TestContextGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class TestModule {}

let app: NestFastifyApplication;
const BASE = `/v1/organizations/northstar/projects/${PROJECT_ID}/members`;
const AUTH = { cookie: `${COOKIE_NAME}=a-signed-token` };

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    organizationId: ORG_ID,
    workspaceId: 'ws-1',
    name: 'Atlas',
    status: 'active',
    ownerUserId: AUTHENTICATED.userId,
    committedAt: null,
    forecastAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    archivedAt: null,
    ...overrides,
  };
}

function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PM_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    userId: OTHER_USER,
    role: 'member' as InternalRole,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ADM-02 project member admin — round trip', () => {
  it('adds, lists, changes a role and removes, tenant-scoped', async () => {
    projectFindById.mockResolvedValue(project());
    memberFindByUserId.mockResolvedValue({ id: 'm-2', userId: OTHER_USER, status: 'active' });
    pmFindByProjectAndUser.mockResolvedValue(null);
    cmdAdd.mockResolvedValue(membershipRow({ role: 'member' }));

    const added = await app.inject({
      method: 'POST',
      url: BASE,
      headers: AUTH,
      payload: { userId: OTHER_USER, role: 'member' },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      projectMembershipId: PM_ID,
      userId: OTHER_USER,
      role: 'member',
    });
    expect(cmdAdd).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT_ID,
      userId: OTHER_USER,
      role: 'member',
    });

    pmListByProject.mockResolvedValue([membershipRow()]);
    const listed = await app.inject({ method: 'GET', url: BASE, headers: AUTH });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().members).toHaveLength(1);

    pmFindById.mockResolvedValue(membershipRow({ role: 'member' }));
    cmdChangeRole.mockResolvedValue(membershipRow({ role: 'manager' }));
    const changed = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${PM_ID}`,
      headers: AUTH,
      payload: { role: 'manager', expectedRole: 'member' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().role).toBe('manager');
    expect(cmdChangeRole).toHaveBeenCalledWith(expect.anything(), PM_ID, 'member', 'manager');

    pmFindById.mockResolvedValue(membershipRow({ role: 'member' }));
    cmdRemove.mockResolvedValue(true);
    const removed = await app.inject({ method: 'DELETE', url: `${BASE}/${PM_ID}`, headers: AUTH });
    expect(removed.statusCode).toBe(204);
    expect(cmdRemove).toHaveBeenCalledWith(expect.anything(), PM_ID);
  });
});

describe('ADM-02 project member admin — the Known trap (tenant-scoped resolve before write)', () => {
  it('answers 404 with no write for an unknown or cross-tenant projectId', async () => {
    projectFindById.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: AUTH,
      payload: { userId: OTHER_USER, role: 'member' },
    });
    expect(res.statusCode).toBe(404);
    expect(cmdAdd).not.toHaveBeenCalled();
  });

  it('answers 404 with no write for a membership id that is not on this project', async () => {
    projectFindById.mockResolvedValue(project());
    pmFindById.mockResolvedValue(membershipRow({ projectId: 'other-project' }));
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${PM_ID}`,
      headers: AUTH,
      payload: { role: 'manager', expectedRole: 'member' },
    });
    expect(res.statusCode).toBe(404);
    expect(cmdChangeRole).not.toHaveBeenCalled();
  });

  it('answers 404 with no write for a target user with no membership in this tenant', async () => {
    projectFindById.mockResolvedValue(project());
    memberFindByUserId.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: AUTH,
      payload: { userId: 'cross-tenant-user', role: 'member' },
    });
    expect(res.statusCode).toBe(404);
    expect(cmdAdd).not.toHaveBeenCalled();
  });
});

describe('ADM-02 project member admin — capability and escalation guards', () => {
  it('answers 403 for a caller whose role does not include project.member.manage', async () => {
    projectFindById.mockResolvedValue(project());
    const res = await app.inject({
      method: 'GET',
      url: BASE,
      headers: { ...AUTH, 'x-test-role': 'member' },
    });
    expect(res.statusCode).toBe(403);
    expect(pmListByProject).not.toHaveBeenCalled();
  });

  it('refuses assigning a role above the caller’s ceiling (403, no write)', async () => {
    projectFindById.mockResolvedValue(project());
    memberFindByUserId.mockResolvedValue({ id: 'm-2', userId: OTHER_USER, status: 'active' });
    // org_admin (rank below owner) may manage members but may not mint an owner.
    const res = await app.inject({
      method: 'POST',
      url: BASE,
      headers: { ...AUTH, 'x-test-role': 'org_admin' },
      payload: { userId: OTHER_USER, role: 'owner' },
    });
    expect(res.statusCode).toBe(403);
    expect(cmdAdd).not.toHaveBeenCalled();
  });

  it('refuses a caller changing their own role (403, no write)', async () => {
    projectFindById.mockResolvedValue(project());
    pmFindById.mockResolvedValue(membershipRow({ userId: AUTHENTICATED.userId, role: 'member' }));
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${PM_ID}`,
      headers: { ...AUTH, 'x-test-role': 'org_admin' },
      payload: { role: 'manager', expectedRole: 'member' },
    });
    expect(res.statusCode).toBe(403);
    expect(cmdChangeRole).not.toHaveBeenCalled();
  });

  it('refuses demoting the last owner seat (403, no write)', async () => {
    projectFindById.mockResolvedValue(project());
    pmFindById.mockResolvedValue(membershipRow({ role: 'owner' }));
    pmListByProject.mockResolvedValue([membershipRow({ role: 'owner' })]);
    const res = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${PM_ID}`,
      headers: AUTH,
      payload: { role: 'manager', expectedRole: 'owner' },
    });
    expect(res.statusCode).toBe(403);
    expect(cmdChangeRole).not.toHaveBeenCalled();
  });

  it('refuses removing the last owner seat (403, no write)', async () => {
    projectFindById.mockResolvedValue(project());
    pmFindById.mockResolvedValue(membershipRow({ role: 'owner' }));
    pmListByProject.mockResolvedValue([membershipRow({ role: 'owner' })]);
    const res = await app.inject({ method: 'DELETE', url: `${BASE}/${PM_ID}`, headers: AUTH });
    expect(res.statusCode).toBe(403);
    expect(cmdRemove).not.toHaveBeenCalled();
  });

  it('removes an owner when another owner remains', async () => {
    projectFindById.mockResolvedValue(project());
    pmFindById.mockResolvedValue(membershipRow({ role: 'owner' }));
    pmListByProject.mockResolvedValue([
      membershipRow({ id: PM_ID, role: 'owner' }),
      membershipRow({ id: 'pm-2', userId: 'u-3', role: 'owner' }),
    ]);
    cmdRemove.mockResolvedValue(true);
    const res = await app.inject({ method: 'DELETE', url: `${BASE}/${PM_ID}`, headers: AUTH });
    expect(res.statusCode).toBe(204);
    expect(cmdRemove).toHaveBeenCalledWith(expect.anything(), PM_ID);
  });
});
