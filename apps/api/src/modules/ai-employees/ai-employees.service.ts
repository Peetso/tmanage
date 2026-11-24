import {
  aiAdminCapabilitiesIn,
  aiEmployeeEmail,
  aiEmployeeStateMachine,
  aiRoleDecision,
  AI_EMPLOYEES_PER_WORKSPACE,
  AI_EMPLOYEE_MAX_LIVE_CREDENTIALS,
  customRoleKey,
  effectiveCapabilitySet,
  isPlatformSupportRole,
  readStoredAiEmployeeLimits,
  uuidv7,
  type AiEmployeeLimits,
  type AiEmployeeStatus,
  type Capability,
  type Principal,
  type PrincipalRole,
  type WorkingWindow,
} from '@tmanage/domain';
import type {
  AiEmployeeHireScope,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { aiEmployeesOff } from './ai-employees.switch.js';
import {
  parseAgentKeyRequest,
  type AgentKeysService,
  type AgentKeyView,
  type CreatedAgentKeyView,
} from '../personal-access-tokens/agent-keys.js';
import { AiConnectorsService } from '../oauth/ai-connectors.js';
import { connectionSummaries, mayBindAiEmployee, NOT_CONNECTED } from './connections.js';
import type { ConnectionSummary } from './connections.js';
import { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import {
  AiEmployeeSettingsRepository,
  type AiEmployeeSettings,
} from './ai-employee-settings.repository.js';
import type { InviteeAccountsRepository } from '../tenancy/invitee-accounts.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import {
  capabilitiesOfStoredRole,
  exceedsCaller,
  requireMayGrantRole,
} from '../tenancy/role-grant-ceiling.js';
import {
  parseHire,
  parseSponsorChange,
  parseUpdate,
  parseVersionOnly,
  parseWindows,
  type AiEmployeeRoleInput,
  type HireInput,
} from './ai-employees.input.js';
import type {
  AiEmployeeChange,
  AiEmployeeRecord,
  AiEmployeesRepository,
  AiProjectFacts,
  ExcludedProjectRecord,
} from './ai-employees.repository.js';

/** 60-07: connectors are read through the OAuth module's service (it owns `oauth_grants`). */
const DEFAULT_CONNECTORS = new AiConnectorsService();

/**
 * 60-03 (plan 60 v2 §2.1, §4.1, §4.5) — hire, list, read, edit, pause, resume, change the sponsor
 * of and retire an AI employee: a member of kind `ai` with a sponsor, a job, limits and hours.
 *
 * Rules applied (ENGINEERING-STANDARD): SE-1 (the route guard chain, then the session-only door
 * below), AR-8 (every decision is the domain's: `aiRoleDecision`, `aiEmployeeStateMachine`, the
 * limit parsers), AR-9 (views carry `can*` decisions), DA-1 (hire: organization row lock against
 * write skew on the cap and the name; edits: conditional UPDATE on `version` against lost update),
 * DA-10 (bound times), DA-11 (one audit row per change in its transaction), DA-12 (tenant-scoped
 * statements only), HT-1 (404 for another workspace's id, 409 for a stale version or a cap),
 * IP-2 (bodies parsed once), IP-4 (expected refusals are `ApiError`s with an audit code).
 *
 * **People only.** Every route here refuses a call that did not come from a person's cookie
 * session (`actorChannel` set = an API key or the connector): an AI principal, an AI employee's
 * own key included, can never hire, change or release an AI employee (§5 test 6 "self-change").
 * The registry lists every route NEVER (`ai_employee_admin`).
 */

export const AI_EMPLOYEE_AUDIT = {
  hired: 'ai_employee.hired',
  updated: 'ai_employee.updated',
  paused: 'ai_employee.paused',
  resumed: 'ai_employee.resumed',
  sponsorChanged: 'ai_employee.sponsor_changed',
  retired: 'ai_employee.retired',
  keyCreated: 'ai_employee.key_created',
  keyRotated: 'ai_employee.key_rotated',
  keyRevoked: 'ai_employee.key_revoked',
  projectExcluded: 'ai_employee.project_excluded',
  projectIncluded: 'ai_employee.project_included',
  projectsChanged: 'ai_employee.projects_changed',
} as const;

/** Project exclusion (plan 60 v2 M5, S8): the projects no AI employee may read. */
export interface ExcludedProjectView {
  readonly projectId: string;
  readonly name: string;
  readonly setByMembershipId: string;
  readonly createdAt: string;
}

export interface ExcludedProjectListView {
  readonly projects: readonly ExcludedProjectView[];
  /** AR-9: whether the caller may add or remove an exclusion. */
  readonly canEdit: boolean;
}

/** 60-05: an AI employee's agent keys as the screens list them. */
export interface AgentKeyListView {
  readonly keys: readonly AgentKeyView[];
  /** The cap on live credentials per AI employee and how many are live now. */
  readonly limit: number;
  readonly live: number;
  /** AR-9: whether the caller may make one more key now. */
  readonly canCreate: boolean;
}

export interface WorkingWindowView {
  readonly day: number;
  readonly start: string;
  readonly end: string;
}

/** One AI employee as the routes answer it. No web client yet (S1–S6 are designed first). */
export interface AiEmployeeView {
  readonly id: string;
  readonly membershipId: string;
  /** 60-07: the AI employee's user id (avatars and people pickers key on it). */
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly jobTitle: string;
  readonly departmentKey: string | null;
  readonly vendorLabel: string | null;
  readonly modelLabel: string | null;
  readonly status: AiEmployeeStatus;
  readonly pausedReason: string | null;
  readonly pausedAt: string | null;
  readonly retiredAt: string | null;
  readonly sponsor: { readonly membershipId: string; readonly displayName: string | null };
  readonly timezone: string;
  readonly workingHours: readonly WorkingWindowView[] | null;
  readonly limits: AiEmployeeLimits;
  readonly discloseToClients: boolean;
  /** 60-07: his projects (his boundary), each with whether it has a client company. */
  readonly projects: readonly AiEmployeeProjectView[];
  /** 60-07: task type keys (empty until the Phase 2 catalogue). */
  readonly taskTypes: readonly string[];
  /** 60-07: live credentials (keys and connectors) and his latest call. */
  readonly connection: AiEmployeeConnectionSummaryView;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** AR-9: what the caller may do now (the route capability and the lifecycle, decided here). */
  readonly canEdit: boolean;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canRetire: boolean;
}

export interface AiEmployeeProjectView {
  readonly id: string;
  readonly name: string;
  readonly isClient: boolean;
}

export interface AiEmployeeConnectionSummaryView {
  readonly live: number;
  readonly lastCalledAt: string | null;
}

export interface AiEmployeeListView {
  readonly aiEmployees: readonly AiEmployeeView[];
  /** The workspace's beta cap and how many are not retired (open question 1). */
  readonly limit: number;
  readonly live: number;
  readonly canHire: boolean;
  /** 60-07: the workspace switch (S8); false = People shows "AI employees are switched off". */
  readonly enabled: boolean;
}

/** What a view adds to the stored row: read in batches for a whole list (never per row). */
interface ViewExtras {
  readonly projects: readonly AiProjectFacts[];
  readonly connection: ConnectionSummary;
}

const NO_EXTRAS: ViewExtras = Object.freeze({ projects: [], connection: NOT_CONNECTED });

const DEFAULT_SETTINGS = new AiEmployeeSettingsRepository();
const DEFAULT_PROJECT_MEMBERS = new ProjectMembershipsRepository();

/** S8 "Who may hire": `owners` narrows `ai_employee.manage` to the workspace owner. */
export function mayHireUnder(
  settings: Pick<AiEmployeeSettings, 'hirePolicy'>,
  principal: Pick<Principal, 'role'>,
): boolean {
  return settings.hirePolicy !== 'owners' || principal.role === 'owner';
}

/** The stored task type keys; unreadable JSON reads as none (deny, never a guess). */
function readTaskTypes(stored: string | null): readonly string[] {
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}

export type AiEmployeesDatabase = Pick<
  TenantDatabase,
  'transaction' | 'read' | 'aiEmployeeHireTransaction'
>;

export interface AiEmployeesServiceOptions {
  readonly database: AiEmployeesDatabase;
  readonly audit: Pick<AuditService, 'record'>;
  readonly repository: AiEmployeesRepository;
  readonly memberships: Pick<
    MembershipsRepository,
    'createAiMember' | 'requireById' | 'transitionStatus' | 'changeAiRole'
  >;
  readonly accounts: Pick<InviteeAccountsRepository, 'insertUser'>;
  /** 60-05: agent keys, through the module that owns `personal_access_tokens` (AR-7). */
  readonly agentKeys: AgentKeysService;
  /**
   * 60-07: connectors that work as an AI employee, through the module that owns `oauth_grants`
   * (AR-7). Counted with the keys against the cap of live credentials. Defaults to the real one.
   */
  readonly aiConnectors?: Pick<AiConnectorsService, 'countLive'>;
  /** 60-07: the workspace's AI-employee rules (S8). Defaults to the real repository. */
  readonly settings?: Pick<AiEmployeeSettingsRepository, 'read'>;
  /**
   * 60-07: his projects are `project_memberships` rows, written through the module that owns
   * them (AR-7). Defaults to the real repository.
   */
  readonly projectMembers?: Pick<
    ProjectMembershipsRepository,
    'add' | 'findByProjectAndUser' | 'remove'
  >;
  /** 60-07: the connection summary of a list. Defaults to {@link connectionSummaries}. */
  readonly connections?: typeof connectionSummaries;
  /**
   * The server switch (`TMANAGE_AI_EMPLOYEES=on`, {@link aiEmployeesEnabled}). Required, so no
   * caller can forget it; while `false` every route is the calm 404 of a feature that does not
   * exist, before any read or write.
   */
  readonly enabled: boolean;
  readonly now?: () => Date;
}

export { AI_EMPLOYEES_SWITCH, aiEmployeesEnabled, aiEmployeesOff } from './ai-employees.switch.js';

const MANAGE: Capability = 'ai_employee.manage';
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function validation(issues: readonly { field: string; message: string }[]): ApiError {
  return new ApiError(400, 'validation_failed', 'The AI employee request is not valid.', [
    ...issues,
  ]);
}

function notFound(cause: string): ApiError {
  return new ApiError(404, 'not_found', 'Not found.', undefined, cause);
}

function conflict(cause: string, message: string): ApiError {
  return new ApiError(409, 'conflict', message, undefined, cause);
}

function minuteText(minute: number): string {
  if (minute === 1440) return '24:00';
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function windowsJson(windows: readonly WorkingWindow[] | null): string | null {
  if (windows === null) return null;
  return JSON.stringify(
    windows.map((w) => ({
      day: w.day,
      start: minuteText(w.startMinute),
      end: minuteText(w.endMinute),
    })),
  );
}

export function readWindows(
  stored: string | null,
  timezone: string,
): readonly WorkingWindowView[] | null {
  if (stored === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return null;
  }
  const parsed = parseWindows(raw, timezone);
  if (!parsed.ok || parsed.value === null) return null;
  return parsed.value.map((w) => ({
    day: w.day,
    start: minuteText(w.startMinute),
    end: minuteText(w.endMinute),
  }));
}

function excludedProjectView(row: ExcludedProjectRecord): ExcludedProjectView {
  return {
    projectId: row.projectId,
    name: row.name,
    setByMembershipId: row.setByMembershipId,
    createdAt: row.createdAt.toISOString(),
  };
}

function ownerOf(row: AiEmployeeRecord): { membershipId: string; userId: string } {
  return { membershipId: row.membershipId, userId: row.userId };
}

function credentialLimit(): ApiError {
  return conflict(
    'ai_employee:credential_limit',
    `An AI employee can have at most ${AI_EMPLOYEE_MAX_LIVE_CREDENTIALS} live keys or connections.`,
  );
}

/**
 * 60-05 "who may bind" (plan 60 v2 §4.5): only the AI employee's sponsor, or a member holding
 * `ai_employee.manage`, may see, make, rotate or revoke its keys.
 */
export function requireMayBind(context: TenantContext, row: AiEmployeeRecord): void {
  if (mayBindAiEmployee(context, row.sponsorMembershipId)) return;
  throw new ApiError(
    403,
    'forbidden',
    'Only the sponsor or someone who manages AI employees can do this.',
    undefined,
    'ai_employee:not_sponsor',
  );
}

export class AiEmployeesService {
  private readonly now: () => Date;

  constructor(private readonly options: AiEmployeesServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async list(context: TenantContext, principal: Principal): Promise<AiEmployeeListView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const at = this.now();
    const manager = context.capabilities.includes(MANAGE);
    const { rows, views, settings } = await this.options.database.read(context, async (db) => {
      const listed = await this.options.repository.list(db, context);
      return {
        rows: listed,
        views: await this.views(db, context, listed, manager, at),
        settings: await this.settings().read(db, context),
      };
    });
    const live = rows.filter((row) => row.status !== 'retired').length;
    return {
      aiEmployees: views,
      limit: AI_EMPLOYEES_PER_WORKSPACE,
      live,
      canHire: manager && live < AI_EMPLOYEES_PER_WORKSPACE && mayHireUnder(settings, principal),
      enabled: settings.enabled,
    };
  }

  async get(context: TenantContext, principal: Principal, id: string): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    return this.readView(context, id, context.capabilities.includes(MANAGE));
  }

  async hire(context: TenantContext, principal: Principal, body: unknown): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseHire(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const input = parsed.value;
    const at = this.now();
    const id = await this.options.database.aiEmployeeHireTransaction(context, (scope) =>
      this.hireIn(scope, context, principal, input, at),
    );
    return this.readView(context, id, true);
  }

  async update(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseUpdate(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const input = parsed.value;
    const at = this.now();
    return this.change(context, id, input.version, at, async (tx, current) => {
      if (current.status === 'retired') {
        throw conflict('ai_employee:retired', 'A retired AI employee cannot be changed.');
      }
      const timezone = input.timezone ?? current.timezone;
      const change: {
        -readonly [K in keyof AiEmployeeChange]: AiEmployeeChange[K];
      } = {};
      if (input.jobTitle !== undefined) change.jobTitle = input.jobTitle;
      if (input.departmentKey !== undefined) change.departmentKey = input.departmentKey;
      if (input.vendorLabel !== undefined) change.vendorLabel = input.vendorLabel;
      if (input.modelLabel !== undefined) change.modelLabel = input.modelLabel;
      if (input.timezone !== undefined) change.timezone = input.timezone;
      if (input.limits !== undefined) change.limitsJson = JSON.stringify(input.limits);
      if (input.discloseToClients !== undefined) change.discloseToClients = input.discloseToClients;
      if (input.workingHours !== undefined) {
        const windows = parseWindows(input.workingHours, timezone);
        if (!windows.ok) throw validation(windows.issues);
        change.workingHoursJson = windowsJson(windows.value);
      }
      if (input.role !== undefined) {
        const role = await this.decideRole(tx, context, principal, input.role);
        if (
          !(await this.options.memberships.changeAiRole(
            tx,
            context,
            current.membershipId,
            role,
            at,
          ))
        ) {
          throw notFound('ai_employee:not_found');
        }
      }
      if (input.projectIds !== undefined) {
        await this.setProjects(tx, context, current, input.projectIds);
      }
      const fields = [
        ...Object.keys(change),
        ...(input.role === undefined ? [] : ['role']),
        ...(input.projectIds === undefined ? [] : ['projects']),
      ];
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.updated,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: { fields: fields.sort().join(',') },
      });
      return change;
    });
  }

  async pause(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseVersionOnly(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const at = this.now();
    return this.change(context, id, parsed.value.version, at, async (tx, current) => {
      const move = aiEmployeeStateMachine.transition(current.status, 'paused', {
        pausedReason: 'manual',
      });
      if (!move.ok)
        throw conflict('ai_employee:not_active', 'Only an active AI employee can be paused.');
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.paused,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: { reason: 'manual' },
      });
      return { status: 'paused', pausedReason: 'manual', pausedAt: at };
    });
  }

  async resume(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseVersionOnly(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const at = this.now();
    return this.change(context, id, parsed.value.version, at, async (tx, current) => {
      const sponsorOk = await this.sponsorIsActivePerson(tx, context, current.sponsorMembershipId);
      const move = aiEmployeeStateMachine.transition(current.status, 'active', {
        activeSponsor: sponsorOk ? true : null,
      });
      if (!move.ok) {
        throw move.reason === 'missing_requirement'
          ? conflict(
              'ai_employee:sponsor_not_active',
              'Choose a sponsor who is an active person before resuming.',
            )
          : conflict('ai_employee:not_paused', 'Only a paused AI employee can be resumed.');
      }
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.resumed,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: { previous_reason: current.pausedReason ?? 'none' },
      });
      return { status: 'active', pausedReason: null, pausedAt: null };
    });
  }

  async changeSponsor(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseSponsorChange(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const { version, sponsorMembershipId } = parsed.value;
    const at = this.now();
    return this.change(context, id, version, at, async (tx, current) => {
      if (current.status === 'retired') {
        throw conflict('ai_employee:retired', 'A retired AI employee cannot be changed.');
      }
      if (!(await this.sponsorIsActivePerson(tx, context, sponsorMembershipId))) {
        throw validation([
          { field: 'sponsorMembershipId', message: 'must be an active person in this workspace' },
        ]);
      }
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.sponsorChanged,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: {
          previous_sponsor_membership_id: current.sponsorMembershipId,
          sponsor_membership_id: sponsorMembershipId,
        },
      });
      return { sponsorMembershipId };
    });
  }

  /**
   * Retire: the companion row becomes `retired` and the membership `offboarded` in one
   * transaction, so every credential bound to the membership stops at the next resolution (the
   * membership resolver admits active members only). Nothing is deleted: the history keeps its
   * author. Open assignments returning to their supervisors is 60-21's sweep.
   */
  async retire(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<AiEmployeeView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseVersionOnly(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const at = this.now();
    return this.change(context, id, parsed.value.version, at, async (tx, current) => {
      const move = aiEmployeeStateMachine.transition(current.status, 'retired', {
        retiredByMembershipId: context.membershipId,
      });
      if (!move.ok) throw conflict('ai_employee:retired', 'This AI employee is already retired.');
      const member = await this.options.memberships.requireById(tx, context, current.membershipId);
      if (member.status !== 'offboarded') {
        await this.options.memberships.transitionStatus(
          tx,
          context,
          current.membershipId,
          member.version,
          'offboarded',
        );
      }
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.retired,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: { membership_id: current.membershipId, previous_status: current.status },
      });
      return { status: 'retired', retiredAt: at, retiredByMembershipId: context.membershipId };
    });
  }

  // ---- project exclusion (plan 60 v2 M5, §4.6 step 6) ----

  /** The projects the workspace keeps away from every AI employee. */
  async listExcludedProjects(
    context: TenantContext,
    principal: Principal,
  ): Promise<ExcludedProjectListView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    return this.options.database.read(context, async (db) => ({
      projects: (await this.options.repository.listExcludedProjects(db, context)).map(
        excludedProjectView,
      ),
      canEdit: context.capabilities.includes(MANAGE),
    }));
  }

  /**
   * Keep one project away from every AI employee. Idempotent: excluding it twice is one row and
   * one audit event. The agent gate removes it from every AI employee's projects on its next call.
   */
  async excludeProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ExcludedProjectListView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const id = projectId.toLowerCase();
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      // DA-1: one writer at a time per workspace, so check-then-insert cannot race (insert-only
      // grant, no upsert).
      await this.options.repository.lockOrganization(tx, context);
      if (!(await this.options.repository.projectExists(tx, context, id))) {
        throw notFound('ai_employee:project_not_found');
      }
      if (!(await this.options.repository.isProjectExcluded(tx, context, id))) {
        await this.options.repository.excludeProject(tx, context, id, context.membershipId, at);
        await this.options.audit.record(tx, context, {
          action: AI_EMPLOYEE_AUDIT.projectExcluded,
          result: 'allowed',
          objectId: id,
          actorUserId: context.userId,
          metadata: {},
        });
      }
      return {
        projects: (await this.options.repository.listExcludedProjects(tx, context)).map(
          excludedProjectView,
        ),
        canEdit: true,
      };
    });
  }

  /** Let AI employees read the project again (their own project memberships still decide). */
  async includeProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const id = projectId.toLowerCase();
    await this.options.database.transaction(context, async (tx) => {
      await this.options.repository.lockOrganization(tx, context);
      if (!(await this.options.repository.includeProject(tx, context, id))) {
        throw notFound('ai_employee:project_not_excluded');
      }
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.projectIncluded,
        result: 'allowed',
        objectId: id,
        actorUserId: context.userId,
        metadata: {},
      });
    });
  }

  // ---- 60-05 · agent keys (plan 60 v2 §4.5) ----

  /** The AI employee's keys. The sponsor or a holder of `ai_employee.manage` only. */
  async listKeys(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<AgentKeyListView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const at = this.now();
    return this.options.database.read(context, async (db) => {
      const row = await this.find(db, context, id);
      requireMayBind(context, row);
      const keys = await this.options.agentKeys.list(db, context, ownerOf(row), at);
      // 60-07: the cap counts live keys and live connectors together.
      const live =
        keys.filter((key) => key.live).length +
        (await (this.options.aiConnectors ?? DEFAULT_CONNECTORS).countLive(
          db,
          context,
          row.membershipId,
        ));
      return {
        keys,
        limit: AI_EMPLOYEE_MAX_LIVE_CREDENTIALS,
        live,
        canCreate: row.status !== 'retired' && live < AI_EMPLOYEE_MAX_LIVE_CREDENTIALS,
      };
    });
  }

  /** Make an agent key (shown once). At most 3 live credentials per AI employee. */
  async createKey(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<CreatedAgentKeyView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseAgentKeyRequest(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const request = parsed.value;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.lockedForKeys(tx, context, id);
      const live = await this.liveCredentials(tx, context, row, at);
      if (live >= AI_EMPLOYEE_MAX_LIVE_CREDENTIALS) throw credentialLimit();
      const created = await this.options.agentKeys.mint(
        tx,
        context,
        ownerOf(row),
        request,
        context.membershipId,
        at,
      );
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.keyCreated,
        result: 'allowed',
        objectId: row.id,
        actorUserId: context.userId,
        metadata: {
          key_id: created.id,
          lifetime_days: request.lifetimeDays,
          network_limited: request.ipAllowlistJson !== null,
        },
      });
      return created;
    });
  }

  /** Rotate: a new key now; the old one ends within 24 hours (never later than it would). */
  async rotateKey(
    context: TenantContext,
    principal: Principal,
    id: string,
    keyId: string,
    body: unknown,
  ): Promise<CreatedAgentKeyView> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const parsed = parseAgentKeyRequest(body);
    if (!parsed.ok) throw validation(parsed.issues);
    const request = parsed.value;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.lockedForKeys(tx, context, id);
      const old = await this.options.agentKeys.find(tx, context, ownerOf(row), keyId);
      const oldLive =
        old !== null && old.revokedAt === null && (old.expiresAt === null || old.expiresAt > at);
      if (!oldLive) throw notFound('ai_employee:key_not_found');
      // The rotated key is being replaced, so it does not count against the cap.
      const live = await this.liveCredentials(tx, context, row, at);
      if (live - 1 >= AI_EMPLOYEE_MAX_LIVE_CREDENTIALS) throw credentialLimit();
      await this.options.agentKeys.endWithinOverlap(tx, context, ownerOf(row), keyId, at);
      const created = await this.options.agentKeys.mint(
        tx,
        context,
        ownerOf(row),
        request,
        context.membershipId,
        at,
      );
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.keyRotated,
        result: 'allowed',
        objectId: row.id,
        actorUserId: context.userId,
        metadata: {
          key_id: created.id,
          replaced_key_id: keyId,
          lifetime_days: request.lifetimeDays,
        },
      });
      return created;
    });
  }

  /** Revoke now. Allowed in every status, a retired AI employee included. */
  async revokeKey(
    context: TenantContext,
    principal: Principal,
    id: string,
    keyId: string,
  ): Promise<void> {
    this.requireEnabled();
    requirePersonSession(context, principal);
    const at = this.now();
    await this.options.database.transaction(context, async (tx) => {
      const row = await this.find(tx, context, id);
      requireMayBind(context, row);
      if (!(await this.options.agentKeys.revoke(tx, context, ownerOf(row), keyId, at))) {
        throw notFound('ai_employee:key_not_found');
      }
      await this.options.audit.record(tx, context, {
        action: AI_EMPLOYEE_AUDIT.keyRevoked,
        result: 'allowed',
        objectId: row.id,
        actorUserId: context.userId,
        metadata: { key_id: keyId },
      });
    });
  }

  /** 60-07: live agent keys plus live connectors (one cap for both, plan §4.5). */
  private async liveCredentials(
    tx: TenantQueryRunner,
    context: TenantContext,
    row: AiEmployeeRecord,
    at: Date,
  ): Promise<number> {
    const keys = await this.options.agentKeys.countLive(tx, context, ownerOf(row), at);
    const connectors = this.options.aiConnectors ?? DEFAULT_CONNECTORS;
    return keys + (await connectors.countLive(tx, context, row.membershipId));
  }

  /** The row locked first (DA-1), the caller allowed to bind, the AI employee not retired. */
  private async lockedForKeys(
    tx: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<AiEmployeeRecord> {
    if (!(await this.options.repository.lockById(tx, context, id.toLowerCase()))) {
      throw notFound('ai_employee:not_found');
    }
    const row = await this.find(tx, context, id);
    requireMayBind(context, row);
    if (row.status === 'retired') {
      throw conflict('ai_employee:retired', 'A retired AI employee cannot get a new key.');
    }
    return row;
  }

  /** Off: 404 before anything else runs, so the surface does not exist for any caller. */
  private requireEnabled(): void {
    if (!this.options.enabled) throw aiEmployeesOff();
  }

  view(row: AiEmployeeRecord, manager: boolean, extras: ViewExtras = NO_EXTRAS): AiEmployeeView {
    const live = row.status !== 'retired';
    return {
      id: row.id,
      membershipId: row.membershipId,
      userId: row.userId,
      displayName: row.displayName,
      role: row.role,
      jobTitle: row.jobTitle,
      departmentKey: row.departmentKey,
      vendorLabel: row.vendorLabel,
      modelLabel: row.modelLabel,
      status: row.status,
      pausedReason: row.pausedReason,
      pausedAt: iso(row.pausedAt),
      retiredAt: iso(row.retiredAt),
      sponsor: { membershipId: row.sponsorMembershipId, displayName: row.sponsorDisplayName },
      timezone: row.timezone,
      workingHours: readWindows(row.workingHoursJson, row.timezone),
      limits: readStoredAiEmployeeLimits(row.limitsJson),
      discloseToClients: row.discloseToClients,
      projects: extras.projects.map((project) => ({
        id: project.id,
        name: project.name,
        isClient: project.isClient,
      })),
      taskTypes: readTaskTypes(row.allowedTaskTypesJson),
      connection: {
        live: extras.connection.live,
        lastCalledAt: iso(extras.connection.lastCalledAt),
      },
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canEdit: manager && live,
      canPause: manager && aiEmployeeStateMachine.allowedFrom(row.status).includes('paused'),
      canResume: manager && aiEmployeeStateMachine.allowedFrom(row.status).includes('active'),
      canRetire: manager && live,
    };
  }

  // ---- internals ----

  private settings(): Pick<AiEmployeeSettingsRepository, 'read'> {
    return this.options.settings ?? DEFAULT_SETTINGS;
  }

  private projectMembers(): Pick<
    ProjectMembershipsRepository,
    'add' | 'findByProjectAndUser' | 'remove'
  > {
    return this.options.projectMembers ?? DEFAULT_PROJECT_MEMBERS;
  }

  /** The views of a list, with their projects and connections read in two batches. */
  private async views(
    runner: TenantQueryRunner,
    context: TenantContext,
    rows: readonly AiEmployeeRecord[],
    manager: boolean,
    at: Date,
  ): Promise<AiEmployeeView[]> {
    if (rows.length === 0) return [];
    const projects = await this.options.repository.projectsOfUsers(
      runner,
      context,
      rows.map((row) => row.userId),
    );
    const connections = await (this.options.connections ?? connectionSummaries)(
      runner,
      context,
      rows.map((row) => row.membershipId),
      at,
    );
    return rows.map((row) =>
      this.view(row, manager, {
        projects: projects.get(row.userId) ?? [],
        connection: connections.get(row.membershipId) ?? NOT_CONNECTED,
      }),
    );
  }

  private async readView(
    context: TenantContext,
    id: string,
    manager: boolean,
  ): Promise<AiEmployeeView> {
    const at = this.now();
    return this.options.database.read(context, async (db) => {
      const row = await this.find(db, context, id);
      const [view] = await this.views(db, context, [row], manager, at);
      if (view === undefined) throw notFound('ai_employee:not_found');
      return view;
    });
  }

  /**
   * 60-07 (plan §4.6 rule 6): the projects an AI employee may work in. Each must be an active
   * project of this workspace, not closed to AI (M5), and, when the workspace keeps AI to internal
   * projects (S8), without a client company. Returns the checked facts in the given order.
   */
  private async checkProjects(
    tx: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
    settings: AiEmployeeSettings,
  ): Promise<readonly AiProjectFacts[]> {
    const facts = await this.options.repository.projectFacts(tx, context, projectIds);
    const byId = new Map(facts.map((fact) => [fact.id, fact] as const));
    const excluded = new Set(await this.options.repository.excludedProjectIds(tx, context));
    const issues: { field: string; message: string }[] = [];
    const checked: AiProjectFacts[] = [];
    for (const projectId of projectIds) {
      const fact = byId.get(projectId);
      if (fact === undefined || fact.status !== 'active') {
        issues.push({ field: 'projectIds', message: `${projectId} is not an open project here` });
      } else if (excluded.has(projectId)) {
        issues.push({ field: 'projectIds', message: `${projectId} is closed to AI employees` });
      } else if (fact.isClient && settings.clientWork === 'internal_only') {
        issues.push({
          field: 'projectIds',
          message: `${projectId} is a client project, and AI works on internal projects only`,
        });
      } else {
        checked.push(fact);
      }
    }
    if (issues.length > 0) throw validation(issues);
    return checked;
  }

  /**
   * 60-07: make the AI employee's project memberships exactly `projectIds` (each checked), adding
   * the new ones as `member` and removing the rest, in the caller's transaction, audited once.
   */
  private async setProjects(
    tx: TenantQueryRunner,
    context: TenantContext,
    row: AiEmployeeRecord,
    projectIds: readonly string[],
  ): Promise<void> {
    const settings = await this.settings().read(tx, context);
    await this.checkProjects(tx, context, projectIds, settings);
    const held = await this.options.repository.projectsOfUsers(tx, context, [row.userId]);
    const current = held.get(row.userId) ?? [];
    const wanted = new Set(projectIds);
    const have = new Set(current.map((project) => project.id));
    const added = projectIds.filter((projectId) => !have.has(projectId));
    const removed = current
      .filter((project) => !wanted.has(project.id))
      .map((project) => project.id);
    const members = this.projectMembers();
    for (const projectId of added) {
      await members.add(tx, context, { projectId, userId: row.userId, role: 'member' });
    }
    for (const projectId of removed) {
      const membership = await members.findByProjectAndUser(tx, context, projectId, row.userId);
      if (membership !== null) await members.remove(tx, context, membership.id);
    }
    if (added.length === 0 && removed.length === 0) return;
    await this.options.audit.record(tx, context, {
      action: AI_EMPLOYEE_AUDIT.projectsChanged,
      result: 'allowed',
      objectId: row.id,
      actorUserId: context.userId,
      metadata: { added: added.join(','), removed: removed.join(',') },
    });
  }

  private async hireIn(
    scope: AiEmployeeHireScope,
    context: TenantContext,
    principal: Principal,
    input: HireInput,
    at: Date,
  ): Promise<string> {
    const tx = scope.tenant;
    const repo = this.options.repository;
    // DA-1: the organization row first, always, so the cap and the name are checked serially.
    await repo.lockOrganization(tx, context);
    const settings = await this.settings().read(tx, context);
    if (!mayHireUnder(settings, principal)) {
      throw new ApiError(
        403,
        'forbidden',
        'In this workspace only an owner can hire an AI employee.',
        undefined,
        'ai_employee.hire:owners_only',
      );
    }
    if ((await repo.countLive(tx, context)) >= AI_EMPLOYEES_PER_WORKSPACE) {
      throw conflict(
        'ai_employee:workspace_limit',
        `A workspace can have ${AI_EMPLOYEES_PER_WORKSPACE} AI employees in the beta.`,
      );
    }
    if (await repo.liveNameTaken(tx, context, input.displayName)) {
      throw conflict('ai_employee:name_taken', 'An AI employee already has this name.');
    }
    const sponsorId = input.sponsorMembershipId ?? context.membershipId;
    if (!(await this.sponsorIsActivePerson(tx, context, sponsorId))) {
      throw validation([
        { field: 'sponsorMembershipId', message: 'must be an active person in this workspace' },
      ]);
    }
    const role = await this.decideRole(tx, context, principal, input.role);
    const projects = await this.checkProjects(tx, context, input.projectIds, settings);

    const userId = uuidv7();
    const membershipId = uuidv7();
    const id = uuidv7();
    await this.options.accounts.insertUser(scope.identity, {
      id: userId,
      email: aiEmployeeEmail(userId),
      displayName: input.displayName,
      locale: 'en',
      timezone: input.timezone,
    });
    await this.options.memberships.createAiMember(tx, context, {
      id: membershipId,
      userId,
      role,
      at,
    });
    await repo.insert(tx, context, {
      id,
      membershipId,
      userId,
      sponsorMembershipId: sponsorId,
      createdByMembershipId: context.membershipId,
      jobTitle: input.jobTitle,
      departmentKey: input.departmentKey,
      vendorLabel: input.vendorLabel,
      modelLabel: input.modelLabel,
      timezone: input.timezone,
      workingHoursJson: windowsJson(input.workingWindows),
      limitsJson: JSON.stringify(input.limits),
      discloseToClients: input.discloseToClients ?? settings.discloseToClients,
      allowedTaskTypesJson: input.taskTypes.length === 0 ? null : JSON.stringify(input.taskTypes),
      at,
    });
    // 60-07: his projects are his boundary (plan §4.6 rule 6), saved in the hire's transaction.
    for (const project of projects) {
      await this.projectMembers().add(tx, context, {
        projectId: project.id,
        userId,
        role: 'member',
      });
    }
    await this.options.audit.record(tx, context, {
      action: AI_EMPLOYEE_AUDIT.hired,
      result: 'allowed',
      objectId: id,
      actorUserId: context.userId,
      metadata: {
        membership_id: membershipId,
        role: typeof input.role === 'string' ? input.role : 'custom',
        sponsor_membership_id: sponsorId,
        department_key: input.departmentKey ?? 'none',
        projects: projects.map((project) => project.id).join(','),
      },
    });
    return id;
  }

  /**
   * The stored role value, after three checks: the AI ceiling (member, guest, or a custom role
   * without an admin capability), and the caller's own ceiling ("a creator cannot grant what
   * they lack", T-5): the built-in subset walk, or the custom role's set against the caller's.
   */
  private async decideRole(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    role: AiEmployeeRoleInput,
  ): Promise<string> {
    const input = { role };
    const stored = typeof input.role === 'string' ? input.role : input.role.customRoleId;
    const capabilities = await capabilitiesOfStoredRole(tx, context, stored);
    if (typeof input.role !== 'string' && capabilities.size === 0) {
      throw validation([{ field: 'role', message: 'is not a role of this workspace' }]);
    }
    const principalRole: PrincipalRole =
      typeof input.role === 'string' ? input.role : customRoleKey(stored, capabilities);
    const decision = aiRoleDecision(principalRole, capabilities);
    if (!decision.allowed) {
      const admin = aiAdminCapabilitiesIn(capabilities);
      throw new ApiError(
        400,
        'validation_failed',
        'An AI employee can only be given a role without administration rights.',
        admin.length > 0
          ? admin.map((capability) => ({ field: 'role', message: capability }))
          : [{ field: 'role', message: 'must be member, guest or a custom role' }],
        `ai_employee:${decision.reason}`,
      );
    }
    if (typeof input.role === 'string') {
      requireMayGrantRole(principal, stored, context.organizationId, 'ai_employee.hire');
    } else if (exceedsCaller(capabilities, effectiveCapabilitySet(principal))) {
      throw new ApiError(
        403,
        'forbidden',
        'You can only give a role whose rights you hold yourself.',
        undefined,
        'ai_employee.hire:role_escalation',
      );
    }
    return stored;
  }

  /** A sponsor is an active person (kind human) of this workspace, never the Support role. */
  private async sponsorIsActivePerson(
    tx: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<boolean> {
    const member = await this.options.repository.findMember(tx, context, membershipId);
    return (
      member !== null &&
      member.kind === 'human' &&
      member.status === 'active' &&
      !isPlatformSupportRole(member.role)
    );
  }

  private async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<AiEmployeeRecord> {
    const row = await this.options.repository.findById(runner, context, id.toLowerCase());
    if (row === null) throw notFound('ai_employee:not_found');
    return row;
  }

  /**
   * Read, decide, write conditionally on `version`, audit — one transaction. A stale version is
   * 409 with no write (the caller re-reads); another workspace's id is 404.
   */
  private async change(
    context: TenantContext,
    id: string,
    version: number,
    at: Date,
    decide: (tx: TenantQueryRunner, current: AiEmployeeRecord) => Promise<AiEmployeeChange>,
  ): Promise<AiEmployeeView> {
    await this.options.database.transaction(context, async (tx) => {
      const current = await this.find(tx, context, id);
      if (current.version !== version) {
        throw conflict('ai_employee:stale_version', 'Someone changed this AI employee; reload it.');
      }
      const change = await decide(tx, current);
      const written = await this.options.repository.update(
        tx,
        context,
        current.id,
        version,
        change,
        at,
      );
      if (!written) {
        throw conflict('ai_employee:stale_version', 'Someone changed this AI employee; reload it.');
      }
    });
    return this.readView(context, id, true);
  }
}

/**
 * The people-only door: a person's cookie session in this workspace. An API key or the connector
 * (`actorChannel` set), a client principal, or a service context is refused with 403.
 */
export function requirePersonSession(context: TenantContext, principal: Principal): void {
  if (
    context.actorChannel !== undefined ||
    context.principalKind !== 'internal' ||
    principal.kind !== 'internal'
  ) {
    throw new ApiError(
      403,
      'forbidden',
      'Only a person signed in to TManage can manage AI employees.',
      undefined,
      'ai_employee:person_session_only',
    );
  }
}
