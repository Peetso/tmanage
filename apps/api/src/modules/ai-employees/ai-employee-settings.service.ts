import { AI_EMPLOYEES_PER_WORKSPACE, type Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  AiEmployeeSettingsRepository,
  type AiAssignPolicy,
  type AiClientWork,
  type AiEmployeeSettings,
  type AiHirePolicy,
} from './ai-employee-settings.repository.js';
import type { AiEmployeesRepository } from './ai-employees.repository.js';
import { aiEmployeesOff } from './ai-employees.switch.js';
import { requirePersonSession } from './ai-employees.service.js';

/**
 * 60-07 (plan 60 v2 §4.10 S8) — the workspace's rules for AI employees: the switch, who may hire
 * and give work to AI, client work, the disclosure default and the second approver.
 *
 * Rules applied (ENGINEERING-STANDARD): SE-1 (route guard `ai_employee.manage`, then the
 * person-session door), IP-2 (the body parsed once into exact types), DA-1 (conditional write on
 * `version`, 409 when stale), DA-10 (bound time), DA-11 (one audit row in the write's
 * transaction), AR-9 (`canEdit` decided here). Switching AI off deletes nothing: the agent gate
 * refuses every call while it is off, and revoking a key or a connector still works.
 */

export interface AiEmployeeSettingsView {
  readonly enabled: boolean;
  readonly hirePolicy: AiHirePolicy;
  readonly assignPolicy: AiAssignPolicy;
  readonly clientWork: AiClientWork;
  readonly discloseToClients: boolean;
  readonly secondApprover: boolean;
  readonly version: number;
  /** The beta cap and how many AI employees are not retired ("3 of 5 used in the beta"). */
  readonly limit: number;
  readonly live: number;
  readonly canEdit: boolean;
}

export const AI_SETTINGS_AUDIT = 'ai_employee.settings_changed';

const HIRE: readonly AiHirePolicy[] = ['owners_and_admins', 'owners'];
const ASSIGN: readonly AiAssignPolicy[] = ['managers', 'owners_and_admins'];
const CLIENT_WORK: readonly AiClientWork[] = ['allowed', 'internal_only'];
const BOOLEAN_FIELDS = ['enabled', 'discloseToClients', 'secondApprover'] as const;

type Change = {
  -readonly [K in keyof Omit<AiEmployeeSettings, 'version'>]?: AiEmployeeSettings[K];
};

export interface ParsedSettingsChange {
  readonly version: number;
  readonly change: Change;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** The PUT body, parsed once (IP-2). `version` 0 = no row was saved yet. */
export function parseSettingsChange(
  input: unknown,
):
  | { ok: true; value: ParsedSettingsChange }
  | { ok: false; issues: { field: string; message: string }[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ field: 'body', message: 'must be an object' }] };
  }
  const body = input as Readonly<Record<string, unknown>>;
  const issues: { field: string; message: string }[] = [];
  const version = body['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    issues.push({ field: 'version', message: 'must be the version you read' });
  }
  const change: Change = {};
  for (const field of BOOLEAN_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') issues.push({ field, message: 'must be true or false' });
    else change[field] = value;
  }
  const pick = <T extends string>(
    field: 'hirePolicy' | 'assignPolicy' | 'clientWork',
    allowed: readonly T[],
  ) => {
    const value = body[field];
    if (value === undefined) return undefined;
    if (!oneOf(value, allowed)) {
      issues.push({ field, message: `must be one of ${allowed.join(', ')}` });
      return undefined;
    }
    return value;
  };
  const hire = pick('hirePolicy', HIRE);
  if (hire !== undefined) change.hirePolicy = hire;
  const assign = pick('assignPolicy', ASSIGN);
  if (assign !== undefined) change.assignPolicy = assign;
  const clientWork = pick('clientWork', CLIENT_WORK);
  if (clientWork !== undefined) change.clientWork = clientWork;
  if (issues.length === 0 && Object.keys(change).length === 0) {
    issues.push({ field: 'body', message: 'names nothing to change' });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { version: version as number, change } };
}

export interface AiEmployeeSettingsServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly settings?: Pick<AiEmployeeSettingsRepository, 'read' | 'save'>;
  readonly repository: Pick<AiEmployeesRepository, 'countLive'>;
  /** The server switch; while off the routes are the calm 404 of a feature that does not exist. */
  readonly enabled: boolean;
  readonly now?: () => Date;
}

export class AiEmployeeSettingsService {
  private readonly now: () => Date;
  private readonly settings: Pick<AiEmployeeSettingsRepository, 'read' | 'save'>;

  constructor(private readonly options: AiEmployeeSettingsServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.settings = options.settings ?? new AiEmployeeSettingsRepository();
  }

  async get(context: TenantContext, principal: Principal): Promise<AiEmployeeSettingsView> {
    this.guard(context, principal);
    return this.options.database.read(context, async (db) =>
      this.view(
        await this.settings.read(db, context),
        await this.options.repository.countLive(db, context),
      ),
    );
  }

  async update(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<AiEmployeeSettingsView> {
    this.guard(context, principal);
    const parsed = parseSettingsChange(body);
    if (!parsed.ok) {
      throw new ApiError(400, 'validation_failed', 'The AI-employee settings are not valid.', [
        ...parsed.issues,
      ]);
    }
    const { version, change } = parsed.value;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const current = await this.settings.read(tx, context);
      const stale = () =>
        new ApiError(
          409,
          'conflict',
          'Someone changed these settings; reload them.',
          undefined,
          'ai_employee_settings:stale_version',
        );
      if (current.version !== version) throw stale();
      const { version: _read, ...stored } = current;
      const next = { ...stored, ...change };
      if (!(await this.settings.save(tx, context, version, next, at))) throw stale();
      await this.options.audit.record(tx, context, {
        action: AI_SETTINGS_AUDIT,
        result: 'allowed',
        objectId: context.organizationId,
        actorUserId: context.userId,
        metadata: {
          // An array: the audit refuses comma-joined values (60-10).
          fields: Object.keys(change).sort(),
          enabled: next.enabled,
          client_work: next.clientWork,
        },
      });
      return this.view(
        { ...next, version: version + 1 },
        await this.options.repository.countLive(tx, context),
      );
    });
  }

  private view(settings: AiEmployeeSettings, live: number): AiEmployeeSettingsView {
    return {
      enabled: settings.enabled,
      hirePolicy: settings.hirePolicy,
      assignPolicy: settings.assignPolicy,
      clientWork: settings.clientWork,
      discloseToClients: settings.discloseToClients,
      secondApprover: settings.secondApprover,
      version: settings.version,
      limit: AI_EMPLOYEES_PER_WORKSPACE,
      live,
      // The route already asks `ai_employee.manage`; the view says so for the screen (AR-9).
      canEdit: true,
    };
  }

  private guard(context: TenantContext, principal: Principal): void {
    if (!this.options.enabled) throw aiEmployeesOff();
    requirePersonSession(context, principal);
  }
}
