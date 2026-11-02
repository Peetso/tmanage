import {
  canResolve,
  clockStatus,
  isIncidentSeverity,
  notificationDeadlines,
  SEVERITIES,
} from '@tmanage/domain';
import type { ClockStatus, IncidentSeverity, Jurisdiction } from '@tmanage/domain';
import { INCIDENT_STATUSES } from '../../../common/database/schema.js';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { optionalReason, requireId } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type {
  IncidentInput,
  IncidentRecord,
  IncidentStatus,
  PlatformIncidentsRepository,
} from './incidents.repository.js';

/**
 * Platform admin · 56-13 incident register (one-person edition). The operator records an incident
 * with its severity, when it was detected and contained, which organizations, data categories and
 * customer countries it touches, and whether personal data is involved; the register computes the
 * legal clocks (`@tmanage/domain` incident-clocks) and refuses to resolve while one is open.
 *
 * Publishing is the status post on the public page: ONLY component/status/title/body/started_at/
 * resolved_at are ever public — the public read selects its own columns. The platform audit rows
 * carry ids, severity and timestamps, never organization names.
 */

export const MAX_COMPONENT = 190;
export const MAX_TITLE = 300;
export const MAX_BODY = 20_000;
export const MAX_URL = 512;
export const MAX_LIST = 500;
export const MAX_CATEGORY = 64;

export interface IncidentClockView {
  readonly jurisdiction: Jurisdiction;
  readonly dueAt: string;
  readonly basis: string;
  readonly status: ClockStatus;
}

export interface IncidentClocksView {
  readonly authority: readonly IncidentClockView[];
  readonly customers: { readonly dueAt: string; readonly status: ClockStatus } | null;
  readonly subjectsWithoutUndueDelay: boolean;
}

export interface PlatformIncidentView {
  readonly id: string;
  readonly component: string;
  readonly status: IncidentStatus;
  readonly title: string;
  readonly body: string;
  readonly severity: IncidentSeverity;
  readonly startedAt: string;
  readonly detectedAt: string | null;
  readonly containedAt: string | null;
  readonly resolvedAt: string | null;
  readonly affectedOrgIds: readonly string[];
  readonly dataCategories: readonly string[];
  readonly countries: readonly string[];
  readonly personalData: boolean;
  readonly notifiedAuthorityAt: string | null;
  readonly notifiedCustomersAt: string | null;
  readonly postmortemUrl: string | null;
  readonly published: boolean;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly clocks: IncidentClocksView;
}

type Body = Readonly<Record<string, unknown>>;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The clocks an incident runs, each with where it stands at `now`. Pure. */
export function incidentClocks(record: IncidentRecord, now: Date): IncidentClocksView {
  const deadlines = notificationDeadlines({
    detectedAt: record.detectedAt ?? record.startedAt,
    countries: record.countries,
    personalData: record.personalData,
    severity: record.severity,
  });
  return {
    authority: deadlines.authority.map((clock) => ({
      jurisdiction: clock.jurisdiction,
      dueAt: clock.dueAt.toISOString(),
      basis: clock.basis,
      status: clockStatus(clock.dueAt, now, record.notifiedAuthorityAt),
    })),
    customers:
      deadlines.customersDueAt === null
        ? null
        : {
            dueAt: deadlines.customersDueAt.toISOString(),
            status: clockStatus(deadlines.customersDueAt, now, record.notifiedCustomersAt),
          },
    subjectsWithoutUndueDelay: deadlines.subjectsWithoutUndueDelay,
  };
}

export function toIncidentView(record: IncidentRecord, now: Date): PlatformIncidentView {
  return {
    id: record.id,
    component: record.component,
    status: record.status,
    title: record.title,
    body: record.body,
    severity: record.severity,
    startedAt: record.startedAt.toISOString(),
    detectedAt: iso(record.detectedAt),
    containedAt: iso(record.containedAt),
    resolvedAt: iso(record.resolvedAt),
    affectedOrgIds: record.affectedOrgIds,
    dataCategories: record.dataCategories,
    countries: record.countries,
    personalData: record.personalData,
    notifiedAuthorityAt: iso(record.notifiedAuthorityAt),
    notifiedCustomersAt: iso(record.notifiedCustomersAt),
    postmortemUrl: record.postmortemUrl,
    published: record.published,
    createdAt: record.createdAt.toISOString(),
    updatedAt: iso(record.updatedAt),
    clocks: incidentClocks(record, now),
  };
}

function field(message: string, name: string, detail: string): ApiError {
  return new ApiError(400, 'validation_failed', message, [{ field: name, message: detail }]);
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max) {
    throw field('Fill in this field.', name, `required, 1–${max} characters`);
  }
  return value.trim();
}

function instant(value: unknown, name: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw field('The date is invalid.', name, 'ISO-8601 instant');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw field('The date is invalid.', name, 'ISO-8601 instant');
  return parsed;
}

function stringList(
  value: unknown,
  name: string,
  each: (item: unknown) => string | null,
): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST) {
    throw field('The list is invalid.', name, `a list of at most ${MAX_LIST} entries`);
  }
  const out = value.map((item: unknown) => {
    const parsed = each(item);
    if (parsed === null) throw field('The list is invalid.', name, 'an entry is invalid');
    return parsed;
  });
  return [...new Set(out)];
}

const orgId = (item: unknown): string | null => {
  try {
    return requireId(item);
  } catch {
    return null;
  }
};

const country = (item: unknown): string | null =>
  typeof item === 'string' && /^[A-Za-z]{2}$/u.test(item.trim()) ? item.trim().toUpperCase() : null;

const category = (item: unknown): string | null =>
  typeof item === 'string' && item.trim() !== '' && item.trim().length <= MAX_CATEGORY
    ? item.trim()
    : null;

function postmortem(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_URL) {
    throw field('The link is not a web address.', 'postmortemUrl', 'an https address');
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') throw new Error('scheme');
    return url.toString();
  } catch {
    throw field('The link is not a web address.', 'postmortemUrl', 'an https address');
  }
}

/**
 * The editable fields from a POST/PUT body (PUT merges over `base`). `created_by` is never read
 * from a body. On create, `startedAt` and `detectedAt` default to `now`. Pure.
 */
export function parseIncidentBody(body: Body, now: Date, base?: IncidentInput): IncidentInput {
  const has = (key: string) => body?.[key] !== undefined;
  const pick = <T>(key: string, parse: (v: unknown) => T, fallback: T): T =>
    has(key) ? parse(body[key]) : fallback;

  const severity = has('severity') ? body['severity'] : (base?.severity ?? 'SEV3');
  if (!isIncidentSeverity(severity)) {
    throw field('Choose a severity.', 'severity', SEVERITIES.join(', '));
  }
  const status = has('status') ? body['status'] : (base?.status ?? 'investigating');
  if (!(INCIDENT_STATUSES as readonly unknown[]).includes(status)) {
    throw field('Choose a status.', 'status', INCIDENT_STATUSES.join(', '));
  }
  const personalData = has('personalData') ? body['personalData'] : (base?.personalData ?? false);
  if (typeof personalData !== 'boolean') {
    throw field('Say whether personal data is involved.', 'personalData', 'must be a boolean');
  }
  const startedAt = pick('startedAt', (v) => instant(v, 'startedAt'), base?.startedAt ?? now);
  if (startedAt === null) throw field('Fill in when it started.', 'startedAt', 'required');

  return {
    component: has('component')
      ? requiredText(body['component'], 'component', MAX_COMPONENT)
      : requiredText(base?.component, 'component', MAX_COMPONENT),
    status: status as IncidentStatus,
    title: has('title')
      ? requiredText(body['title'], 'title', MAX_TITLE)
      : requiredText(base?.title, 'title', MAX_TITLE),
    body: has('body')
      ? requiredText(body['body'], 'body', MAX_BODY)
      : requiredText(base?.body, 'body', MAX_BODY),
    severity,
    startedAt,
    detectedAt: pick(
      'detectedAt',
      (v) => instant(v, 'detectedAt'),
      base === undefined ? now : base.detectedAt,
    ),
    containedAt: pick('containedAt', (v) => instant(v, 'containedAt'), base?.containedAt ?? null),
    resolvedAt: pick('resolvedAt', (v) => instant(v, 'resolvedAt'), base?.resolvedAt ?? null),
    affectedOrgIds: pick(
      'affectedOrgIds',
      (v) => stringList(v, 'affectedOrgIds', orgId),
      base?.affectedOrgIds ?? [],
    ),
    dataCategories: pick(
      'dataCategories',
      (v) => stringList(v, 'dataCategories', category),
      base?.dataCategories ?? [],
    ),
    countries: pick('countries', (v) => stringList(v, 'countries', country), base?.countries ?? []),
    personalData,
    notifiedAuthorityAt: pick(
      'notifiedAuthorityAt',
      (v) => instant(v, 'notifiedAuthorityAt'),
      base?.notifiedAuthorityAt ?? null,
    ),
    notifiedCustomersAt: pick(
      'notifiedCustomersAt',
      (v) => instant(v, 'notifiedCustomersAt'),
      base?.notifiedCustomersAt ?? null,
    ),
    postmortemUrl: pick('postmortemUrl', postmortem, base?.postmortemUrl ?? null),
  };
}

/** What the platform audit keeps: ids, severity, timestamps — never organization names or the text. */
export function incidentAuditShape(input: IncidentInput | IncidentRecord) {
  return {
    severity: input.severity,
    status: input.status,
    personalData: input.personalData,
    affectedOrgIds: input.affectedOrgIds,
    countries: input.countries,
    dataCategories: input.dataCategories,
    startedAt: iso(input.startedAt),
    detectedAt: iso(input.detectedAt),
    containedAt: iso(input.containedAt),
    resolvedAt: iso(input.resolvedAt),
    notifiedAuthorityAt: iso(input.notifiedAuthorityAt),
    notifiedCustomersAt: iso(input.notifiedCustomersAt),
  };
}

function reasonText(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim().slice(0, 1000);
}

/** Refuse with 422 `clock_open` when `canResolve` says a notice is still owed. */
function assertResolvable(
  incident: IncidentInput | IncidentRecord,
  authorityNotRequiredReason: string | null,
): void {
  const check = canResolve(incident, authorityNotRequiredReason);
  if (!check.ok) {
    throw new ApiError(
      422,
      'clock_open',
      'Send the required notices before resolving this incident.',
      check.missing.map((missing) => ({
        field: missing === 'customers_not_notified' ? 'notifiedCustomersAt' : 'notifiedAuthorityAt',
        message: missing,
      })),
    );
  }
}

export class PlatformIncidentsService {
  constructor(
    private readonly repository: PlatformIncidentsRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(context: RequestContext): Promise<{ readonly incidents: PlatformIncidentView[] }> {
    const now = this.clock();
    const rows = await this.repository.list(context.correlationId);
    return { incidents: rows.map((row) => toIncidentView(row, now)) };
  }

  async create(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformIncidentView> {
    const input = parseIncidentBody(body, this.clock());
    if (input.status === 'resolved') {
      assertResolvable(input, reasonText(body?.['authorityNotRequiredReason']));
    }
    const reason = optionalReason(body?.['reason']);
    const id = await this.repository.create(input, actor.account.userId, (newId) =>
      platformAuditFor(actor, context, {
        action: 'platform.incident_created',
        targetType: 'platform',
        targetId: newId,
        targetLabel: input.severity,
        reason,
        beforeJson: null,
        afterJson: JSON.stringify(incidentAuditShape(input)),
      }),
    );
    return this.view(id, context);
  }

  async update(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformIncidentView> {
    const id = requireId(rawId);
    const existing = await this.repository.find(id, context.correlationId);
    if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const input = parseIncidentBody(body, this.clock(), existing);
    const excuse = reasonText(body?.['authorityNotRequiredReason']);
    const found = await this.repository.update(
      id,
      input,
      (current) => {
        // Moving to resolved through PUT is held to the same clocks as POST …/resolve.
        if (input.status === 'resolved' && current.status !== 'resolved') {
          assertResolvable(input, excuse);
        }
      },
      platformAuditFor(actor, context, {
        action: 'platform.incident_updated',
        targetType: 'platform',
        targetId: id,
        targetLabel: input.severity,
        reason: optionalReason(body?.['reason']),
        beforeJson: JSON.stringify(incidentAuditShape(existing)),
        afterJson: JSON.stringify({
          ...incidentAuditShape(input),
          authorityNotRequiredReason: excuse,
        }),
      }),
    );
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return this.view(id, context);
  }

  async setPublished(
    actor: PlatformAdminActor,
    rawId: string,
    published: boolean,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformIncidentView> {
    const id = requireId(rawId);
    const found = await this.repository.setPublished(
      id,
      published,
      platformAuditFor(actor, context, {
        action: published ? 'platform.incident_published' : 'platform.incident_unpublished',
        targetType: 'platform',
        targetId: id,
        targetLabel: null,
        reason: optionalReason(body?.['reason']),
      }),
    );
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return this.view(id, context);
  }

  async resolve(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformIncidentView> {
    const id = requireId(rawId);
    const resolvedAt = instant(body?.['resolvedAt'], 'resolvedAt') ?? this.clock();
    const excuse = reasonText(body?.['authorityNotRequiredReason']);
    const existing = await this.repository.find(id, context.correlationId);
    if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    // Checked here for a clear answer, and again on the locked row inside the transaction.
    assertResolvable(existing, excuse);
    const found = await this.repository.resolve(
      id,
      resolvedAt,
      (current) => assertResolvable(current, excuse),
      platformAuditFor(actor, context, {
        action: 'platform.incident_resolved',
        targetType: 'platform',
        targetId: id,
        targetLabel: existing.severity,
        reason: optionalReason(body?.['reason']),
        beforeJson: JSON.stringify(incidentAuditShape(existing)),
        afterJson: JSON.stringify({
          severity: existing.severity,
          resolvedAt: resolvedAt.toISOString(),
          authorityNotRequiredReason: excuse,
        }),
      }),
    );
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return this.view(id, context);
  }

  private async view(id: string, context: RequestContext): Promise<PlatformIncidentView> {
    const record = await this.repository.find(id, context.correlationId);
    if (!record) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return toIncidentView(record, this.clock());
  }
}
