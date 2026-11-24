import type { ExecutionContext } from '@nestjs/common';
import { CAPABILITIES, capabilitiesFor, type Capability, type Principal } from '@tmanage/domain';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import { TenantContextGuard } from '../../common/http/guards/tenant-context.guard.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { NEVER, OPS } from '../ai-actions/registry/index.js';
import { mintPersonalAccessToken } from '../personal-access-tokens/personal-access-token.js';
import { MembershipNotResolvedError } from '../tenancy/membership-resolver.repository.js';
import { AGENT_PREAMBLE, AgentWhoamiService } from './agent-whoami.js';
import type { AiEmployeeRecord, AiEmployeeStamp, MemberFacts } from './ai-employees.repository.js';
import {
  AGENT_CONTRACT_ROUTES,
  AgentEnforcement,
  agentContractRouteFor,
  overridesHolding,
  type AgentGate,
  type AgentGateDecision,
} from './enforcement.js';

/**
 * 60-06 (plan 60 v2 §4.4, §4.6; security tests 2, 4, 5) with fakes (IP-14): the tool wall, the
 * agent gate's decisions in the plan's order, the narrowing to role ∩ ceiling ∩ sponsor, project
 * exclusion, and both guards wired to them. The SQL and a real agent key end to end are
 * `apps/api/test/t-60-06-agent-enforcement.db.test.ts` (test phase).
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const AI_ID = '0190a000-0000-7000-8000-0000000000e1';
const AI_M = '0190a000-0000-7000-8000-0000000000e2';
const AI_USER = '0190a000-0000-7000-8000-0000000000e3';
const SPONSOR_M = '0190a000-0000-7000-8000-0000000000e4';
const SPONSOR_USER = '0190a000-0000-7000-8000-0000000000e5';
const CORRELATION = '0190a000-0000-7000-8000-0000000000e6';
const PROJECT_A = '0190a000-0000-7000-8000-0000000000f1';
const PROJECT_X = '0190a000-0000-7000-8000-0000000000f2';
// A Tuesday, 10:00 UTC.
const T0 = new Date('2026-11-24T10:00:00.000Z');

const AI_CONTEXT = {
  organizationId: ORG,
  userId: AI_USER,
  principalKind: 'internal',
  membershipId: AI_M,
  capabilities: capabilitiesFor('member'),
  policyVersion: '1',
  correlationId: CORRELATION,
} as unknown as TenantContext;

function stamp(over: Partial<AiEmployeeStamp> = {}): AiEmployeeStamp {
  return {
    id: AI_ID,
    membershipId: AI_M,
    sponsorMembershipId: SPONSOR_M,
    status: 'active',
    timezone: 'UTC',
    workingHoursJson: null,
    limitsJson: null,
    allowedTaskTypesJson: '["social_post"]',
    ...over,
  };
}

const SPONSOR: MemberFacts = {
  membershipId: SPONSOR_M,
  userId: SPONSOR_USER,
  role: 'manager',
  status: 'active',
  kind: 'human',
};

function gate(input: {
  row?: AiEmployeeStamp | null;
  sponsor?: MemberFacts | null;
  sponsorCapabilities?: readonly Capability[];
  sponsorResolveFails?: boolean;
  excluded?: readonly string[];
  enabled?: boolean;
  workspaceOn?: boolean;
  closedProjectIds?: readonly string[];
}): AgentEnforcement {
  const runner = {} as TenantQueryRunner;
  return new AgentEnforcement({
    database: {
      read: (async (_c: TenantContext, work: (r: TenantQueryRunner) => Promise<unknown>) =>
        work(runner)) as never,
    },
    repository: {
      findStampByMembership: async () => (input.row === undefined ? stamp() : input.row),
      findMember: async () => (input.sponsor === undefined ? SPONSOR : input.sponsor),
      excludedProjectIds: async () => input.excluded ?? [],
    },
    resolver: {
      resolve: vi.fn(async () => {
        if (input.sponsorResolveFails) throw new MembershipNotResolvedError('no_active_membership');
        return {
          context: {
            principalKind: 'internal',
            capabilities: input.sponsorCapabilities ?? capabilitiesFor('manager'),
          },
        };
      }) as never,
    },
    enabled: input.enabled ?? true,
    rules: {
      read: async () => ({
        enabled: input.workspaceOn ?? true,
        closedProjectIds: input.closedProjectIds ?? [],
      }),
    },
    now: () => T0,
  });
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; auditCode?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { status: number; auditCode?: string };
  }
  throw new Error('expected a refusal');
}

const asAgent = { context: AI_CONTEXT, agentCredential: true, correlationId: CORRELATION };

describe('tool wall: the agent contract routes', () => {
  it('matches only the contract route, by method and whole path', () => {
    expect(agentContractRouteFor('GET', '/v1/organizations/acme/agent/me')?.tool).toBe(
      'agent_whoami',
    );
    expect(agentContractRouteFor('get', '/v1/organizations/acme/agent/me?x=1')?.tool).toBe(
      'agent_whoami',
    );
    for (const [method, url] of [
      ['POST', '/v1/organizations/acme/agent/me'],
      ['GET', '/v1/organizations/acme/agent/me/keys'],
      ['GET', '/v1/organizations/acme/agent/mex'],
      ['GET', '/v1/organizations/acme/ai-employees'],
      ['GET', '/v1/organizations/acme/projects'],
      ['POST', '/mcp'],
      ['GET', '/v1/organizations//agent/me'],
    ] as const) {
      expect(agentContractRouteFor(method, url), `${method} ${url}`).toBeNull();
    }
    expect(agentContractRouteFor('GET', undefined)).toBeNull();
  });

  it('no registry op is reachable by an agent key; every contract route is NEVER agent_contract', () => {
    const asUrl = (path: string) => path.replace(/:[A-Za-z]+/g, 'x');
    for (const op of OPS) {
      expect(agentContractRouteFor(op.method, asUrl(op.path)), op.id).toBeNull();
    }
    const contract = NEVER.filter((entry) => entry.reason === 'agent_contract');
    expect(contract.map((e) => `${e.method} ${e.path}`).sort()).toEqual(
      AGENT_CONTRACT_ROUTES.map((r) => `${r.method} ${r.path}`).sort(),
    );
    // Every other NEVER route stays behind the wall.
    for (const entry of NEVER.filter((e) => e.reason !== 'agent_contract')) {
      expect(agentContractRouteFor(entry.method, asUrl(entry.path)), entry.path).toBeNull();
    }
  });
});

describe('agent gate: decisions in the plan order', () => {
  it('a person’s token passes untouched', async () => {
    await expect(
      gate({ row: null }).decide({ ...asAgent, agentCredential: false }),
    ).resolves.toBeNull();
  });

  it('refuses an agent key on a person, a person’s credential on an AI employee, and the switch off', async () => {
    expect((await refusal(gate({ row: null }).decide(asAgent))).auditCode).toBe(
      'agent:not_ai_member',
    );
    expect((await refusal(gate({}).decide({ ...asAgent, agentCredential: false }))).auditCode).toBe(
      'agent:credential_not_agent',
    );
    expect(await refusal(gate({ enabled: false }).decide(asAgent))).toMatchObject({
      status: 404,
      auditCode: 'feature.ai_employees_off',
    });
  });

  it('60-07: refuses every call while the workspace switched AI off, and drops client projects', async () => {
    expect((await refusal(gate({ workspaceOn: false }).decide(asAgent))).auditCode).toBe(
      'agent:workspace_off',
    );
    const decision = await gate({
      excluded: ['p-excluded'],
      closedProjectIds: ['p-client', 'p-excluded'],
    }).decide(asAgent);
    expect([...(decision?.excludedProjectIds ?? [])].sort()).toEqual(['p-client', 'p-excluded']);
  });

  it('refuses a paused or retired AI employee', async () => {
    expect(
      (await refusal(gate({ row: stamp({ status: 'paused' }) }).decide(asAgent))).auditCode,
    ).toBe('agent:paused');
    expect(
      (await refusal(gate({ row: stamp({ status: 'retired' }) }).decide(asAgent))).auditCode,
    ).toBe('agent:not_active');
    expect((await refusal(gate({ row: stamp({ status: null }) }).decide(asAgent))).auditCode).toBe(
      'agent:not_active',
    );
  });

  it('refuses without an active human sponsor, also when the sponsor no longer resolves', async () => {
    for (const sponsor of [
      null,
      { ...SPONSOR, status: 'offboarded' },
      { ...SPONSOR, kind: 'ai' as const },
      { ...SPONSOR, kind: null },
    ]) {
      expect((await refusal(gate({ sponsor }).decide(asAgent))).auditCode).toBe(
        'agent:sponsor_not_active',
      );
    }
    expect((await refusal(gate({ sponsorResolveFails: true }).decide(asAgent))).auditCode).toBe(
      'agent:sponsor_not_active',
    );
  });

  it('refuses outside the working hours and when the stored hours cannot be read', async () => {
    const monday = JSON.stringify([{ day: 1, start: '09:00', end: '17:00' }]);
    const tuesday = JSON.stringify([{ day: 2, start: '09:00', end: '17:00' }]);
    expect(
      (await refusal(gate({ row: stamp({ workingHoursJson: monday }) }).decide(asAgent))).auditCode,
    ).toBe('agent:outside_hours');
    await expect(
      gate({ row: stamp({ workingHoursJson: tuesday }) }).decide(asAgent),
    ).resolves.not.toBeNull();
    expect(
      (await refusal(gate({ row: stamp({ workingHoursJson: '{nope' }) }).decide(asAgent)))
        .auditCode,
    ).toBe('agent:hours_unreadable');
  });

  it('narrows to role ∩ AI ceiling ∩ sponsor; demoting the sponsor narrows at once', async () => {
    const full = (await gate({}).decide(asAgent)) as AgentGateDecision;
    // Never an admin or masked capability, whatever the role holds.
    expect(full.capabilities).not.toContain('people.view');
    expect(full.capabilities).not.toContain('work.create');
    expect(full.capabilities).not.toContain('approval.decide');
    expect(full.capabilities).toContain('work.read');
    // The sponsor loses file.upload: so does the AI employee, on the next call.
    const demoted = (await gate({
      sponsorCapabilities: capabilitiesFor('manager').filter((c) => c !== 'file.upload'),
    }).decide(asAgent)) as AgentGateDecision;
    expect(full.capabilities).toContain('file.upload');
    expect(demoted.capabilities).not.toContain('file.upload');
    // The principal's deny list leaves exactly the same set.
    expect(CAPABILITIES.filter((c) => !demoted.overrides.deny.includes(c))).toEqual(
      demoted.capabilities,
    );
    expect(demoted.overrides.allow).toEqual([]);
    expect(full.stamp).toEqual({
      aiEmployeeId: AI_ID,
      sponsorMembershipId: SPONSOR_M,
      allowedTaskTypes: ['social_post'],
    });
  });

  it('unreadable allowed task types mean none', async () => {
    const decision = (await gate({
      row: stamp({ allowedTaskTypesJson: 'not json' }),
    }).decide(asAgent)) as AgentGateDecision;
    expect(decision.stamp.allowedTaskTypes).toEqual([]);
    expect(overridesHolding(new Set()).deny).toEqual(CAPABILITIES);
  });
});

// ---- the guards ----

function executionFor(request: unknown): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const reflector = { getAllAndOverride: () => false } as never;

describe('SessionAuthGuard: the wall for an agent key', () => {
  const token = mintPersonalAccessToken().token;
  const agentKey = {
    authenticate: vi.fn(async () => ({
      tokenId: 't1',
      name: 'Mat on Claude',
      organizationId: ORG,
      membershipId: AI_M,
      userId: AI_USER,
      scopes: [],
      ipAllowlist: [],
      agent: true,
    })),
  } as never;
  const events = { recordGuardRefusal: vi.fn() };
  const guard = new SessionAuthGuard(
    reflector,
    { authenticate: vi.fn() } as never,
    { cookieName: 'tm', sessionSecret: 's', csrfSecret: 'c' } as never,
    events as never,
    agentKey,
  );

  it('lets the contract route through and marks the binding as an agent', async () => {
    const request = {
      method: 'GET',
      url: '/v1/organizations/acme/agent/me',
      headers: { authorization: `Bearer ${token}` },
    };
    await expect(guard.canActivate(executionFor(request))).resolves.toBe(true);
    expect(requireRequestState(request).personalAccessToken).toMatchObject({ agent: true });
  });

  it('refuses every other route, a read included, and /mcp, recording the refusal', async () => {
    for (const [method, url] of [
      ['GET', '/v1/organizations/acme/projects'],
      ['POST', '/v1/organizations/acme/work-items'],
      ['GET', '/v1/organizations/acme/ai-employees'],
      ['POST', '/mcp'],
    ] as const) {
      const request = { method, url, headers: { authorization: `Bearer ${token}` } };
      await expect(guard.canActivate(executionFor(request)), url).rejects.toMatchObject({
        status: 403,
        auditCode: 'agent_tool_wall',
      });
    }
    expect(events.recordGuardRefusal).toHaveBeenCalled();
  });
});

describe('TenantContextGuard: the agent gate on a bound token', () => {
  class GatedGuard extends TenantContextGuard {
    constructor(
      private readonly fake: AgentGate,
      deps: { resolver: unknown; principals: unknown; database: unknown },
    ) {
      super(reflector, deps.resolver as never, deps.principals as never, deps.database as never);
    }
    protected override agentGate(): AgentGate {
      return this.fake;
    }
  }

  function build(decision: AgentGateDecision | null | Error) {
    const fake: AgentGate = {
      decide: vi.fn(async () => {
        if (decision instanceof Error) throw decision;
        return decision;
      }),
    };
    const loads: unknown[] = [];
    const guard = new GatedGuard(fake, {
      resolver: {
        resolve: async () => ({
          context: AI_CONTEXT,
          role: 'member',
          clientOrganizationId: null,
          hasOrgWideScope: true,
          workspaceScopeId: null,
          overrides: { allow: [], deny: [] },
        }),
      },
      principals: {
        load: async (_r: unknown, resolved: unknown) => {
          loads.push(resolved);
          return {
            projectIds: [PROJECT_A, PROJECT_X],
            hasOrgWideScope: false,
          } as unknown as Principal;
        },
      },
      database: {
        read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
      },
    });
    return { guard, fake, loads };
  }

  function agentRequest() {
    const request = { params: { orgSlug: 'acme' }, headers: {} };
    const state = requireRequestState(request);
    state.session = { sessionId: 'pat:t1', userId: AI_USER };
    state.authScheme = 'personal_access_token';
    state.personalAccessToken = { organizationId: ORG, membershipId: AI_M, agent: true };
    return { request, state };
  }

  it('stamps the context, narrows it, drops org-wide scope and the excluded projects', async () => {
    const decision = (await gate({ excluded: [PROJECT_X] }).decide(asAgent)) as AgentGateDecision;
    const { guard, fake, loads } = build(decision);
    const { request, state } = agentRequest();
    await expect(guard.canActivate(executionFor(request))).resolves.toBe(true);
    expect(fake.decide).toHaveBeenCalledWith(expect.objectContaining({ agentCredential: true }));
    expect(state.tenant?.aiEmployee).toEqual(decision.stamp);
    expect(state.tenant?.capabilities).toEqual(decision.capabilities);
    expect(loads[0]).toMatchObject({ hasOrgWideScope: false, overrides: decision.overrides });
    expect(state.principal?.projectIds).toEqual([PROJECT_A]);
  });

  it('a refusal from the gate stops the request before any principal is loaded', async () => {
    const { guard, loads } = build(
      Object.assign(new Error('x'), { status: 403, auditCode: 'agent:paused' }),
    );
    const { request, state } = agentRequest();
    await expect(guard.canActivate(executionFor(request))).rejects.toMatchObject({
      auditCode: 'agent:paused',
    });
    expect(loads).toEqual([]);
    expect(state.tenant).toBeUndefined();
  });

  it('a cookie session never asks the gate', async () => {
    const { guard, fake } = build(null);
    const request = { params: { orgSlug: 'acme' }, headers: {} };
    const state = requireRequestState(request);
    state.session = { sessionId: 's1', userId: AI_USER };
    state.authScheme = 'cookie';
    await guard.canActivate(executionFor(request));
    expect(fake.decide).not.toHaveBeenCalled();
  });
});

describe('agent_whoami', () => {
  const ROW = {
    id: AI_ID,
    membershipId: AI_M,
    displayName: 'Mat',
    jobTitle: 'Social media designer',
    departmentKey: 'marketing',
    sponsorMembershipId: SPONSOR_M,
    sponsorDisplayName: 'Omar',
    timezone: 'UTC',
    workingHoursJson: null,
    limitsJson: null,
  } as unknown as AiEmployeeRecord;

  function service(enabled = true) {
    const seen: string[][] = [];
    return {
      seen,
      service: new AgentWhoamiService({
        database: {
          read: (async (_c: TenantContext, work: (r: TenantQueryRunner) => Promise<unknown>) =>
            work({} as TenantQueryRunner)) as never,
        },
        repository: {
          findById: async () => ROW,
          projectNames: async (_r, _c, ids) => {
            seen.push([...ids]);
            return ids.map((id) => ({ id, name: `P ${id.slice(-2)}` }));
          },
        },
        enabled,
      }),
    };
  }
  const stamped = {
    ...AI_CONTEXT,
    aiEmployee: { aiEmployeeId: AI_ID, sponsorMembershipId: SPONSOR_M, allowedTaskTypes: ['x'] },
  } as unknown as TenantContext;
  const principal = { projectIds: [PROJECT_A] } as unknown as Principal;

  it('answers who the AI employee is, with only the principal’s (non-excluded) projects', async () => {
    const { service: s, seen } = service();
    const view = await s.whoami(stamped, principal);
    expect(view).toMatchObject({
      contract: '1.0',
      id: AI_ID,
      name: 'Mat',
      sponsor: { membershipId: SPONSOR_M, name: 'Omar' },
      allowedTaskTypes: ['x'],
      instructions: AGENT_PREAMBLE,
      projects: [{ id: PROJECT_A }],
    });
    expect(seen).toEqual([[PROJECT_A]]);
  });

  it('refuses a person, and is 404 while the switch is off', async () => {
    expect((await refusal(service().service.whoami(AI_CONTEXT, principal))).auditCode).toBe(
      'agent:agents_only',
    );
    expect((await refusal(service(false).service.whoami(stamped, principal))).status).toBe(404);
  });
});
