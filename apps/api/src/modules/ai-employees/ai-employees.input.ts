import {
  isCustomRoleId,
  isKnownTimeZone,
  isUuid,
  parseAiEmployeeLimits,
  parseWorkingHours,
  type AiEmployeeLimits,
  type WorkingWindow,
} from '@tmanage/domain';
import type { ApiErrorDetail } from '../../common/http/errors.js';

/**
 * 60-03 (plan 60 v2 §4.1, §4.2 M2) — the request bodies of the AI-employee routes, parsed once at
 * the boundary into exact types (IP-2). Pure: no I/O, no clock.
 *
 * Free text a person types (name, job title, vendor and model labels) is trimmed, length-capped,
 * and refused when it carries control, zero-width or bidirectional-override characters: these
 * strings reach other people's screens and, later, an outside agent (§5 "hidden text").
 */

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ApiErrorDetail[] };

export const AI_EMPLOYEE_NAME_MAX = 80;
export const AI_EMPLOYEE_JOB_TITLE_MAX = 120;
export const AI_EMPLOYEE_LABEL_MAX = 80;

/** C0/C1 controls, zero-width characters and bidirectional controls (Unicode TR 9, TR 36). */
const HIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const DEPARTMENT_KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** A task type key (the Phase 2 catalogue's keys, 60-13): lower case, digits, `_`, `-`, `.`. */
const TASK_TYPE_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;
/** 60-07: an AI employee works in at least one project, and at most this many at once. */
export const AI_EMPLOYEE_PROJECTS_MAX = 50;
export const AI_EMPLOYEE_TASK_TYPES_MAX = 50;

/** The role an AI employee is given: a built-in `member` / `guest`, or a custom role id. */
export type AiEmployeeRoleInput = 'member' | 'guest' | { readonly customRoleId: string };

export interface HireInput {
  readonly displayName: string;
  readonly jobTitle: string;
  readonly role: AiEmployeeRoleInput;
  /** NULL = the hiring person sponsors it. */
  readonly sponsorMembershipId: string | null;
  readonly departmentKey: string | null;
  readonly vendorLabel: string | null;
  readonly modelLabel: string | null;
  readonly timezone: string;
  readonly workingWindows: readonly WorkingWindow[] | null;
  readonly limits: AiEmployeeLimits;
  /** Null = the workspace's default (S8 "Tell clients when AI helped"). */
  readonly discloseToClients: boolean | null;
  /** 60-07: his projects, his boundary (plan §4.6 rule 6). At least one, distinct, lower case. */
  readonly projectIds: readonly string[];
  /** 60-07: task type keys; saved now, offered in the wizard once the catalogue exists (Phase 2). */
  readonly taskTypes: readonly string[];
}

export interface UpdateInput {
  readonly version: number;
  readonly jobTitle?: string;
  readonly departmentKey?: string | null;
  readonly vendorLabel?: string | null;
  readonly modelLabel?: string | null;
  readonly timezone?: string;
  /** Present only together with a time zone it is read in (the stored or the new one). */
  readonly workingHours?: unknown;
  readonly limits?: AiEmployeeLimits;
  readonly discloseToClients?: boolean;
  /** 60-07: a new role (the same checks as at hire). */
  readonly role?: AiEmployeeRoleInput;
  /** 60-07: the whole new project list (at least one); the service adds and removes the rest. */
  readonly projectIds?: readonly string[];
}

export interface SponsorChangeInput {
  readonly version: number;
  readonly sponsorMembershipId: string;
}

type Body = Readonly<Record<string, unknown>>;

function asBody(input: unknown): Body | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Body)
    : null;
}

class Issues {
  readonly list: ApiErrorDetail[] = [];
  add(field: string, message: string): void {
    this.list.push({ field, message });
  }
}

function text(
  body: Body,
  field: string,
  max: number,
  issues: Issues,
  required: boolean,
): string | null | undefined {
  const value = body[field];
  if (value === undefined) {
    if (required) issues.add(field, 'is required');
    return undefined;
  }
  if (value === null && !required) return null;
  if (typeof value !== 'string') {
    issues.add(field, 'must be text');
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) issues.add(field, 'is required');
    return required ? undefined : null;
  }
  if ([...trimmed].length > max) {
    issues.add(field, `must be at most ${max} characters`);
    return undefined;
  }
  if (HIDDEN.test(trimmed)) {
    issues.add(field, 'must not contain hidden or control characters');
    return undefined;
  }
  return trimmed;
}

function departmentKey(body: Body, issues: Issues): string | null | undefined {
  const value = body['departmentKey'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !DEPARTMENT_KEY.test(value)) {
    issues.add('departmentKey', 'must be a department key');
    return undefined;
  }
  return value;
}

function timezoneOf(body: Body, issues: Issues): string | undefined {
  const value = body['timezone'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isKnownTimeZone(value)) {
    issues.add('timezone', 'must be a known time zone');
    return undefined;
  }
  return value;
}

function limitsOf(body: Body, issues: Issues): AiEmployeeLimits | undefined {
  if (body['limits'] === undefined) return undefined;
  const parsed = parseAiEmployeeLimits(body['limits']);
  if (parsed.ok) return parsed.limits;
  issues.add(parsed.field === '' ? 'limits' : `limits.${parsed.field}`, parsed.reason);
  return undefined;
}

/** Parse `workingHours` (the windows list or null) in a time zone. */
export function parseWindows(
  value: unknown,
  timezone: string,
): Parsed<readonly WorkingWindow[] | null> {
  const parsed = parseWorkingHours({ timezone, windows: value ?? null });
  if (!parsed.ok) {
    return {
      ok: false,
      issues: [
        {
          field: parsed.reason === 'timezone' ? 'timezone' : 'workingHours',
          message:
            parsed.reason === 'timezone'
              ? 'must be a known time zone'
              : 'must be a list of day, start and end (HH:MM, end after start)',
        },
      ],
    };
  }
  return { ok: true, value: parsed.hours.windows };
}

function parseVersion(body: Body | null, issues: Issues): number | undefined {
  const value = body?.['version'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    issues.add('version', 'must be the version you read');
    return undefined;
  }
  return value;
}

function sponsorOf(body: Body, issues: Issues, required: boolean): string | null | undefined {
  const value = body['sponsorMembershipId'];
  if (value === undefined || value === null) {
    if (required) issues.add('sponsorMembershipId', 'is required');
    return required ? undefined : null;
  }
  if (typeof value !== 'string' || !isUuid(value)) {
    issues.add('sponsorMembershipId', 'must be a membership id');
    return undefined;
  }
  return value.toLowerCase();
}

function roleOf(body: Body, issues: Issues): AiEmployeeRoleInput | undefined {
  const value = body['role'];
  if (value === undefined || value === 'member') return 'member';
  if (value === 'guest') return 'guest';
  if (typeof value === 'string' && isCustomRoleId(value)) return { customRoleId: value };
  issues.add('role', 'must be member, guest or a custom role');
  return undefined;
}

function projectIdsOf(body: Body, issues: Issues, required: boolean): string[] | undefined {
  const value = body['projectIds'];
  if (value === undefined) {
    if (required) issues.add('projectIds', 'must name at least one project');
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > AI_EMPLOYEE_PROJECTS_MAX ||
    !value.every((id) => typeof id === 'string' && isUuid(id))
  ) {
    issues.add('projectIds', `must be a list of 1 to ${AI_EMPLOYEE_PROJECTS_MAX} project ids`);
    return undefined;
  }
  return [...new Set(value.map((id: string) => id.toLowerCase()))];
}

function taskTypesOf(body: Body, issues: Issues): string[] | undefined {
  const value = body['taskTypes'];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > AI_EMPLOYEE_TASK_TYPES_MAX ||
    !value.every((key) => typeof key === 'string' && TASK_TYPE_KEY.test(key))
  ) {
    issues.add(
      'taskTypes',
      `must be a list of at most ${AI_EMPLOYEE_TASK_TYPES_MAX} task type keys`,
    );
    return undefined;
  }
  return [...new Set(value as string[])];
}

function booleanOf(body: Body, field: string, issues: Issues): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    issues.add(field, 'must be true or false');
    return undefined;
  }
  return value;
}

export function parseHire(input: unknown): Parsed<HireInput> {
  const body = asBody(input);
  if (body === null)
    return { ok: false, issues: [{ field: 'body', message: 'must be an object' }] };
  const issues = new Issues();
  const displayName = text(body, 'displayName', AI_EMPLOYEE_NAME_MAX, issues, true);
  const jobTitle = text(body, 'jobTitle', AI_EMPLOYEE_JOB_TITLE_MAX, issues, true);
  const role = roleOf(body, issues);
  const sponsor = sponsorOf(body, issues, false);
  const department = departmentKey(body, issues);
  const vendorLabel = text(body, 'vendorLabel', AI_EMPLOYEE_LABEL_MAX, issues, false);
  const modelLabel = text(body, 'modelLabel', AI_EMPLOYEE_LABEL_MAX, issues, false);
  const timezone = timezoneOf(body, issues) ?? 'UTC';
  const limits = limitsOf(body, issues);
  const disclose = booleanOf(body, 'discloseToClients', issues);
  const windows = parseWindows(body['workingHours'], timezone);
  if (!windows.ok) issues.list.push(...windows.issues);
  const projectIds = projectIdsOf(body, issues, true);
  const taskTypes = taskTypesOf(body, issues);
  if (
    issues.list.length > 0 ||
    projectIds === undefined ||
    displayName === undefined ||
    displayName === null ||
    jobTitle === undefined ||
    jobTitle === null ||
    role === undefined ||
    sponsor === undefined ||
    !windows.ok
  ) {
    return { ok: false, issues: issues.list };
  }
  return {
    ok: true,
    value: {
      displayName,
      jobTitle,
      role,
      sponsorMembershipId: sponsor,
      departmentKey: department ?? null,
      vendorLabel: vendorLabel ?? null,
      modelLabel: modelLabel ?? null,
      timezone,
      workingWindows: windows.value,
      limits: limits ?? parseAiEmployeeLimitsDefaults(),
      discloseToClients: disclose ?? null,
      projectIds,
      taskTypes: taskTypes ?? [],
    },
  };
}

function parseAiEmployeeLimitsDefaults(): AiEmployeeLimits {
  const parsed = parseAiEmployeeLimits(undefined);
  if (!parsed.ok) throw new Error('the AI-employee limit defaults do not parse');
  return parsed.limits;
}

export function parseUpdate(input: unknown): Parsed<UpdateInput> {
  const body = asBody(input);
  if (body === null)
    return { ok: false, issues: [{ field: 'body', message: 'must be an object' }] };
  const issues = new Issues();
  const version = parseVersion(body, issues);
  const jobTitle = text(body, 'jobTitle', AI_EMPLOYEE_JOB_TITLE_MAX, issues, false);
  if (jobTitle === null) issues.add('jobTitle', 'is required');
  const department = departmentKey(body, issues);
  const vendorLabel = text(body, 'vendorLabel', AI_EMPLOYEE_LABEL_MAX, issues, false);
  const modelLabel = text(body, 'modelLabel', AI_EMPLOYEE_LABEL_MAX, issues, false);
  const timezone = timezoneOf(body, issues);
  const limits = limitsOf(body, issues);
  const disclose = booleanOf(body, 'discloseToClients', issues);
  const role = body['role'] === undefined ? undefined : roleOf(body, issues);
  const projectIds = projectIdsOf(body, issues, false);
  const value: UpdateInput = {
    version: version ?? 0,
    ...(typeof jobTitle === 'string' ? { jobTitle } : {}),
    ...(department === undefined ? {} : { departmentKey: department }),
    ...(vendorLabel === undefined ? {} : { vendorLabel }),
    ...(modelLabel === undefined ? {} : { modelLabel }),
    ...(timezone === undefined ? {} : { timezone }),
    ...(body['workingHours'] === undefined ? {} : { workingHours: body['workingHours'] }),
    ...(limits === undefined ? {} : { limits }),
    ...(disclose === undefined ? {} : { discloseToClients: disclose }),
    ...(role === undefined ? {} : { role }),
    ...(projectIds === undefined ? {} : { projectIds }),
  };
  if (issues.list.length === 0 && Object.keys(value).length === 1) {
    issues.add('body', 'names nothing to change');
  }
  if (issues.list.length > 0 || version === undefined) return { ok: false, issues: issues.list };
  return { ok: true, value };
}

export function parseVersionOnly(input: unknown): Parsed<{ readonly version: number }> {
  const issues = new Issues();
  const version = parseVersion(asBody(input), issues);
  if (version === undefined) return { ok: false, issues: issues.list };
  return { ok: true, value: { version } };
}

export function parseSponsorChange(input: unknown): Parsed<SponsorChangeInput> {
  const body = asBody(input);
  if (body === null)
    return { ok: false, issues: [{ field: 'body', message: 'must be an object' }] };
  const issues = new Issues();
  const version = parseVersion(body, issues);
  const sponsor = sponsorOf(body, issues, true);
  if (version === undefined || sponsor === undefined || sponsor === null) {
    return { ok: false, issues: issues.list };
  }
  return { ok: true, value: { version, sponsorMembershipId: sponsor } };
}
