import {
  CAPABILITIES,
  aiEffectiveCapabilities,
  isWithinWorkingHours,
  parseWorkingHours,
  type Capability,
  type PermissionOverrides,
} from '@tmanage/domain';
import type {
  AiEmployeeContextStamp,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { MembershipResolver } from '../tenancy/membership-resolver.repository.js';
import { MembershipNotResolvedError } from '../tenancy/membership-resolver.repository.js';
import { AiEmployeesRepository, type AiEmployeeStamp } from './ai-employees.repository.js';
import { aiEmployeesOff } from './ai-employees.switch.js';
import { AiEmployeeSettingsRepository } from './ai-employee-settings.repository.js';

/**
 * 60-07 (S8): the workspace rules the gate applies on every call: the workspace switch, and the
 * client projects to drop when the workspace keeps AI to internal projects.
 */
export interface WorkspaceAiRules {
  readonly enabled: boolean;
  readonly closedProjectIds: readonly string[];
}

export interface WorkspaceAiRulesReader {
  read(runner: TenantQueryRunner, context: TenantContext): Promise<WorkspaceAiRules>;
}

/** The real reader: the settings row, then (only for `internal_only`) the client projects. */
export class SettingsAiRulesReader implements WorkspaceAiRulesReader {
  constructor(
    private readonly settings = new AiEmployeeSettingsRepository(),
    private readonly projects: Pick<
      AiEmployeesRepository,
      'clientProjectIds'
    > = new AiEmployeesRepository(),
  ) {}

  async read(runner: TenantQueryRunner, context: TenantContext): Promise<WorkspaceAiRules> {
    const settings = await this.settings.read(runner, context);
    return {
      enabled: settings.enabled,
      closedProjectIds:
        settings.clientWork === 'internal_only'
          ? await this.projects.clientProjectIds(runner, context)
          : [],
    };
  }
}

/**
 * 60-06 (plan 60 v2 §4.4, §4.6; security tests 2, 4, 5) — the server-side wall around an AI
 * employee's credential. Two places, both fail closed:
 *
 * 1. **Tool wall, at authentication** (`SessionAuthGuard`): an agent key (a token holding
 *    `tmanage:agent`) reaches only the routes of the agent contract ({@link AGENT_CONTRACT_ROUTES})
 *    and nothing else, REST or connector. Every other route, every registry op and `/mcp` answer
 *    403 `agent_tool_wall` before any tenant work. The connector tool set for agents arrives with
 *    the contract tools (60-22); until then `/mcp` refuses an agent key outright.
 * 2. **Agent gate, at tenant resolution** (`TenantContextGuard`, {@link AgentGate}): for every
 *    bound token (agent key or OAuth grant) the gate asks whether the membership is an AI
 *    employee's. A person's token passes untouched. For an AI employee, in the plan's order:
 *    the server switch is on; the credential is an agent credential (a person's token or grant on
 *    an AI membership, or an agent key on a person's membership, is refused); the AI employee is
 *    `active`; its sponsor is an active person of the workspace; the call is inside its working
 *    hours. The context then carries the immutable `aiEmployee` stamp, and its capabilities are
 *    narrowed to role ∩ AI ceiling ∩ the sponsor's current effective rights, re-read on every call
 *    (demoting the sponsor narrows the AI employee at once). The principal gets the same set as a
 *    deny list, never org-wide scope, and loses every project the workspace excluded for AI.
 *
 * Each refusal is an `ApiError` with a distinct audit code, so the refusal log names the rule.
 * Limits and counters are 60-34; this slice reads the stored limits for `agent_whoami` only.
 *
 * Rules: AR-7 (the AI-employee module owns the AI rules; guards only call it), AR-8 (one door per
 * concern), SE-1 (deny by default), DA-12 (organization from the verified context), IP-2.
 */

// ---- the agent contract (tool wall) ----

export interface AgentContractRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The Nest path with `:params`, exactly as the registry and NEVER list spell it. */
  readonly path: string;
  /** The tool name of the same call on the connector (plan §4.4). */
  readonly tool: string;
}

/**
 * Every route an agent credential may call. Grows with 60-22 / 60-24 / 60-26. Each entry is also a
 * NEVER entry with reason `agent_contract` (the generic AI registry never lists agent calls), which
 * `enforcement.test.ts` checks both ways.
 */
export const AGENT_CONTRACT_ROUTES: readonly AgentContractRoute[] = Object.freeze([
  { method: 'GET', path: '/v1/organizations/:orgSlug/agent/me', tool: 'agent_whoami' },
]);

/** `agent_whoami` reports this; additive changes raise the minor version (plan §4.4). */
export const AGENT_CONTRACT_VERSION = '1.0';

function compile(path: string): RegExp {
  const pattern = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/?#]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern}/?(?:[?#].*)?$`);
}

const COMPILED = AGENT_CONTRACT_ROUTES.map((route) => ({ route, pattern: compile(route.path) }));

/** The contract route a request names, or `null` (refused for an agent credential). */
export function agentContractRouteFor(method: string, url: unknown): AgentContractRoute | null {
  if (typeof url !== 'string') return null;
  const upper = method.toUpperCase();
  for (const { route, pattern } of COMPILED) {
    if (route.method === upper && pattern.test(url)) return route;
  }
  return null;
}

export function agentToolWall(): ApiError {
  return new ApiError(
    403,
    'forbidden',
    'An AI employee can only use the agent tools.',
    undefined,
    'agent_tool_wall',
  );
}

// ---- the agent gate (tenant resolution) ----

export type { AiEmployeeContextStamp } from '../../common/database/tenant-context.js';

export interface AgentGateInput {
  readonly context: TenantContext;
  /** The credential holds `tmanage:agent` (an agent key). */
  readonly agentCredential: boolean;
  readonly correlationId: string;
}

export interface AgentGateDecision {
  readonly stamp: AiEmployeeContextStamp;
  /** role ∩ AI ceiling ∩ sponsor, in `CAPABILITIES` order. */
  readonly capabilities: readonly Capability[];
  /** The principal's overrides that make its capability checks agree with `capabilities`. */
  readonly overrides: PermissionOverrides;
  /** Projects the workspace excluded for AI employees; removed from the principal's projects. */
  readonly excludedProjectIds: readonly string[];
  /** The stored row, for `agent_whoami`. */
  readonly row: AiEmployeeStamp;
}

/** The seam `TenantContextGuard` calls for every bound-token request. */
export interface AgentGate {
  /** `null`: not an AI employee and not an agent credential, so nothing changes. */
  decide(input: AgentGateInput): Promise<AgentGateDecision | null>;
}

const DEFAULT_RULES: WorkspaceAiRulesReader = new SettingsAiRulesReader();

function refused(cause: string, message: string): ApiError {
  return new ApiError(403, 'forbidden', message, undefined, cause);
}

/** Stored allowed task types: a JSON list of keys; anything unreadable is "none". */
export function readAllowedTaskTypes(stored: string | null): readonly string[] {
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return Object.freeze(
      parsed.filter((key): key is string => typeof key === 'string' && key.length > 0),
    );
  } catch {
    return [];
  }
}

/** Working hours as stored (`timezone` column + windows JSON). Unreadable: `null` (refuse). */
export function readStoredHours(
  timezone: string,
  windowsJson: string | null,
): ReturnType<typeof parseWorkingHours> {
  let windows: unknown = null;
  if (windowsJson !== null) {
    try {
      windows = JSON.parse(windowsJson);
    } catch {
      return { ok: false, reason: 'windows' };
    }
  }
  return parseWorkingHours({ timezone, windows });
}

/** The deny list that leaves a principal holding exactly `allowed`. */
export function overridesHolding(allowed: ReadonlySet<Capability>): PermissionOverrides {
  return Object.freeze({
    allow: Object.freeze([]),
    deny: Object.freeze(CAPABILITIES.filter((capability) => !allowed.has(capability))),
  });
}

export interface AgentEnforcementOptions {
  readonly database: Pick<TenantDatabase, 'read'>;
  readonly repository: Pick<
    AiEmployeesRepository,
    'findStampByMembership' | 'findMember' | 'excludedProjectIds'
  >;
  readonly resolver: Pick<MembershipResolver, 'resolve'>;
  /** `TMANAGE_AI_EMPLOYEES=on`. Off: an AI employee's credential is 404, like the whole surface. */
  readonly enabled: boolean;
  /** 60-07: the workspace switch and client-work rule (S8). Defaults to the settings row. */
  readonly rules?: WorkspaceAiRulesReader;
  readonly now?: () => Date;
}

export class AgentEnforcement implements AgentGate {
  private readonly now: () => Date;

  constructor(private readonly options: AgentEnforcementOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async decide(input: AgentGateInput): Promise<AgentGateDecision | null> {
    const { context } = input;
    const read = await this.options.database.read(context, async (runner) => {
      const row = await this.options.repository.findStampByMembership(
        runner,
        context,
        context.membershipId,
      );
      if (row === null) {
        return { row, sponsor: null, excluded: [] as readonly string[], workspaceOn: true };
      }
      const sponsor = await this.options.repository.findMember(
        runner,
        context,
        row.sponsorMembershipId,
      );
      const excluded = await this.options.repository.excludedProjectIds(runner, context);
      const rules = await (this.options.rules ?? DEFAULT_RULES).read(runner, context);
      return {
        row,
        sponsor,
        excluded: [...new Set([...excluded, ...rules.closedProjectIds])],
        workspaceOn: rules.enabled,
      };
    });

    if (read.row === null) {
      // An agent key is only ever minted on an AI membership (60-05); one on a person is a
      // broken invariant, refused rather than treated as the person's token.
      if (input.agentCredential) {
        throw refused('agent:not_ai_member', 'This key does not belong to an AI employee.');
      }
      return null;
    }
    const row = read.row;
    if (!this.options.enabled) throw aiEmployeesOff();
    if (!input.agentCredential) {
      // A person's token or OAuth grant can never act as an AI employee (no human scopes, §4.5).
      throw refused('agent:credential_not_agent', 'Use the AI employee’s agent key.');
    }
    if (!read.workspaceOn) {
      throw refused('agent:workspace_off', 'AI employees are switched off in this workspace.');
    }
    if (row.status !== 'active') {
      throw refused(
        row.status === 'paused' ? 'agent:paused' : 'agent:not_active',
        'This AI employee is paused or retired.',
      );
    }
    const sponsor = read.sponsor;
    if (sponsor === null || sponsor.kind !== 'human' || sponsor.status !== 'active') {
      throw refused('agent:sponsor_not_active', 'This AI employee has no active sponsor.');
    }
    const hours = readStoredHours(row.timezone, row.workingHoursJson);
    if (!hours.ok) {
      throw refused('agent:hours_unreadable', 'This AI employee’s working hours cannot be read.');
    }
    if (!isWithinWorkingHours(hours.hours, this.now())) {
      throw refused('agent:outside_hours', 'This AI employee is outside its working hours.');
    }

    // The sponsor's current effective rights, resolved like any request of theirs (role, custom
    // role, overrides), so a demotion or a removed override narrows the AI employee on this call.
    let sponsorCapabilities: readonly Capability[];
    try {
      const resolved = await this.options.resolver.resolve({
        userId: sponsor.userId,
        organization: { organizationId: context.organizationId },
        correlationId: input.correlationId,
      });
      if (resolved.context.principalKind !== 'internal') {
        throw refused('agent:sponsor_not_active', 'This AI employee has no active sponsor.');
      }
      sponsorCapabilities = resolved.context.capabilities;
    } catch (error) {
      if (error instanceof MembershipNotResolvedError) {
        throw refused('agent:sponsor_not_active', 'This AI employee has no active sponsor.');
      }
      throw error;
    }

    const effective = aiEffectiveCapabilities(
      new Set(context.capabilities),
      new Set(sponsorCapabilities),
    );
    return {
      stamp: Object.freeze({
        aiEmployeeId: row.id,
        sponsorMembershipId: row.sponsorMembershipId,
        allowedTaskTypes: readAllowedTaskTypes(row.allowedTaskTypesJson),
      }),
      capabilities: Object.freeze(CAPABILITIES.filter((capability) => effective.has(capability))),
      overrides: overridesHolding(effective),
      excludedProjectIds: Object.freeze([...read.excluded]),
      row,
    };
  }
}
