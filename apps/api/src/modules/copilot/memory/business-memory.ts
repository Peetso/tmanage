import type { Capability } from '@tmanage/domain';
import {
  BUSINESS_FACT_AUDIENCES,
  BUSINESS_FACT_ENTITY_TYPES,
  type BUSINESS_FACT_STATUSES,
} from '../../../common/database/schema.js';

/**
 * 62-26 (plan 62 §4.6, §9 row) — Business Memory, the rules without a database.
 *
 * - **What a fact is**: one lasting statement (at most {@link BUSINESS_FACT_MAX_CHARS} characters,
 *   one line) about a client, project, person, process or the company, with a category, an
 *   optional in-app source link, an owner and an audience.
 * - **Nothing is remembered without a person**: the AI only proposes (a confirm-class registry op,
 *   so the member sees a card first); a proposed fact is invisible to the AI recall until a person
 *   with `ai.manage` approves it. Chat text is never stored here on its own.
 * - **Who may read a fact** ({@link mayReadFact}): internal members only; `finance` facts need
 *   `finance.view`, `hr` facts need `people.edit`; a project fact needs the project, a client fact
 *   a project of that client, a person, process or company fact any non-guest member. Org-wide
 *   roles see every entity. The repository applies the same rule in SQL before ranking, and the
 *   service re-checks every row (filter before rank, then re-check).
 * - **Stale**: an approved fact not confirmed for {@link BUSINESS_FACT_STALE_DAYS} days is flagged.
 */

export const BUSINESS_FACT_MAX_CHARS = 500;
export const BUSINESS_FACT_STALE_DAYS = 180;
export const BUSINESS_MEMORY_RECALL_LIMIT = 8;
export const BUSINESS_MEMORY_RECALL_MAX_ENTITIES = 5;
export const BUSINESS_MEMORY_LIST_LIMIT = 200;
export const BUSINESS_FACT_SOURCE_MAX_CHARS = 500;

export const BUSINESS_FACT_CATEGORIES = [
  'preference',
  'policy',
  'contact',
  'billing',
  'delivery',
  'process',
  'other',
] as const;

export type BusinessFactEntityType = (typeof BUSINESS_FACT_ENTITY_TYPES)[number];
export type BusinessFactAudience = (typeof BUSINESS_FACT_AUDIENCES)[number];
export type BusinessFactStatus = (typeof BUSINESS_FACT_STATUSES)[number];
export type BusinessFactCategory = (typeof BUSINESS_FACT_CATEGORIES)[number];

/** Entity types that name a record (`entity_id` required); the others are workspace-level. */
const RECORD_ENTITIES: ReadonlySet<BusinessFactEntityType> = new Set([
  'client',
  'project',
  'person',
]);

export function entityNeedsId(type: BusinessFactEntityType): boolean {
  return RECORD_ENTITIES.has(type);
}

/** One fact as stored (dates as `Date`). */
export interface BusinessFact {
  readonly id: string;
  readonly entityType: BusinessFactEntityType;
  readonly entityId: string | null;
  readonly fact: string;
  readonly category: string;
  readonly sourceHref: string | null;
  readonly audience: BusinessFactAudience;
  readonly status: BusinessFactStatus;
  readonly proposedVia: 'ai' | 'member';
  readonly ownerUserId: string;
  readonly proposedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly approvedAt: Date | null;
  readonly lastConfirmedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What one reader may see, resolved once per request: the audiences their capabilities open and
 * the entities their scope reaches. `clientIds` are the clients of the reader's projects.
 */
export interface FactReadScope {
  readonly internal: boolean;
  readonly orgWide: boolean;
  readonly orgLevel: boolean;
  readonly projectIds: ReadonlySet<string>;
  readonly clientIds: ReadonlySet<string>;
  readonly audiences: readonly BusinessFactAudience[];
}

/** The audiences a reader's capabilities open (internal and client-visible for every member). */
export function readableAudiences(capabilities: readonly Capability[]): BusinessFactAudience[] {
  return [
    'internal',
    'client_visible',
    ...(capabilities.includes('finance.view') ? (['finance'] as const) : []),
    ...(capabilities.includes('people.edit') ? (['hr'] as const) : []),
  ];
}

/** The per-fact read rule (the SQL filter's twin, run again on every row). */
export function mayReadFact(
  scope: FactReadScope,
  fact: Pick<BusinessFact, 'entityType' | 'entityId' | 'audience'>,
): boolean {
  if (!scope.internal) return false;
  if (!scope.audiences.includes(fact.audience)) return false;
  if (scope.orgWide) return true;
  switch (fact.entityType) {
    case 'project':
      return fact.entityId !== null && scope.projectIds.has(fact.entityId);
    case 'client':
      return fact.entityId !== null && scope.clientIds.has(fact.entityId);
    default:
      return scope.orgLevel;
  }
}

export function isStale(
  fact: Pick<BusinessFact, 'status' | 'lastConfirmedAt'>,
  now: Date,
): boolean {
  if (fact.status !== 'approved' || fact.lastConfirmedAt === null) return false;
  return now.getTime() - fact.lastConfirmedAt.getTime() >= BUSINESS_FACT_STALE_DAYS * 86_400_000;
}

/** The cut-off: an approved fact last confirmed at or before this instant is stale. */
export function staleCutoff(now: Date): Date {
  return new Date(now.getTime() - BUSINESS_FACT_STALE_DAYS * 86_400_000);
}

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An in-app record path, the same kinds the chat may link (`packs/knowledge.ts`). */
const SOURCE_PATH =
  /^\/(?:work|projects|docs|files|quotes|finance\/invoices|calendar\/meetings)\/[A-Za-z0-9_%-]+$/;
// C0 and C1 controls, and the bidi overrides that can disguise text.
const CONTROL = new RegExp(
  '[' +
    String.fromCodePoint(0) +
    '-' +
    String.fromCodePoint(0x1f) +
    String.fromCodePoint(0x7f) +
    '-' +
    String.fromCodePoint(0x9f) +
    String.fromCodePoint(0x202a) +
    '-' +
    String.fromCodePoint(0x202e) +
    String.fromCodePoint(0x2066) +
    '-' +
    String.fromCodePoint(0x2069) +
    ']',
  'u',
);

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** One line, trimmed; `null` when empty, too long or holding control characters. */
export function normaliseFactText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text === '' || CONTROL.test(text)) return null;
  return [...text].length <= BUSINESS_FACT_MAX_CHARS ? text : null;
}

export interface FactFields {
  readonly entityType: BusinessFactEntityType;
  readonly entityId: string | null;
  readonly fact: string;
  readonly category: BusinessFactCategory;
  readonly sourceHref: string | null;
  readonly audience: BusinessFactAudience;
  readonly ownerUserId: string | null;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

const PROPOSE_KEYS = new Set([
  'entityType',
  'entityId',
  'fact',
  'category',
  'sourceHref',
  'audience',
  'ownerUserId',
]);
const EDIT_KEYS = new Set(['fact', 'category', 'sourceHref', 'audience', 'ownerUserId']);

type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: FieldIssue[] };

function bodyRecord(body: unknown, keys: ReadonlySet<string>, issues: FieldIssue[]) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    issues.push({ field: 'body', message: 'must be an object' });
    return null;
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) issues.push({ field: key, message: 'is not a known field' });
  }
  return record;
}

function sourceOf(value: unknown, issues: FieldIssue[]): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    value.length > BUSINESS_FACT_SOURCE_MAX_CHARS ||
    !SOURCE_PATH.test(value)
  ) {
    issues.push({ field: 'sourceHref', message: 'must be an in-app record path' });
    return null;
  }
  return value;
}

/** `POST …/business-memory/facts`: a new proposal. */
export function parseProposal(body: unknown): Parsed<FactFields> {
  const issues: FieldIssue[] = [];
  const record = bodyRecord(body, PROPOSE_KEYS, issues);
  if (record === null) return { ok: false, issues };
  const entityType = record['entityType'];
  if (!oneOf(BUSINESS_FACT_ENTITY_TYPES, entityType)) {
    issues.push({
      field: 'entityType',
      message: 'must be client, project, person, process or company',
    });
  }
  const rawId = record['entityId'];
  let entityId: string | null = null;
  if (oneOf(BUSINESS_FACT_ENTITY_TYPES, entityType)) {
    if (entityNeedsId(entityType)) {
      if (isUuid(rawId)) entityId = rawId.toLowerCase();
      else issues.push({ field: 'entityId', message: 'must be the id of the record' });
    } else if (rawId !== undefined && rawId !== null) {
      issues.push({ field: 'entityId', message: 'must be empty for a process or company fact' });
    }
  }
  const fact = normaliseFactText(record['fact']);
  if (fact === null) {
    issues.push({
      field: 'fact',
      message: `must be one line of 1 to ${String(BUSINESS_FACT_MAX_CHARS)} characters`,
    });
  }
  const category = record['category'];
  if (!oneOf(BUSINESS_FACT_CATEGORIES, category)) {
    issues.push({
      field: 'category',
      message: `must be one of ${BUSINESS_FACT_CATEGORIES.join(', ')}`,
    });
  }
  const audience = record['audience'] ?? 'internal';
  if (!oneOf(BUSINESS_FACT_AUDIENCES, audience)) {
    issues.push({ field: 'audience', message: 'must be internal, client_visible, finance or hr' });
  }
  const sourceHref = sourceOf(record['sourceHref'], issues);
  const owner = record['ownerUserId'];
  if (owner !== undefined && owner !== null && !isUuid(owner)) {
    issues.push({ field: 'ownerUserId', message: 'must be a member id' });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      entityType: entityType as BusinessFactEntityType,
      entityId,
      fact: fact!,
      category: category as BusinessFactCategory,
      sourceHref,
      audience: audience as BusinessFactAudience,
      ownerUserId: isUuid(owner) ? owner.toLowerCase() : null,
    },
  };
}

export interface FactEdit {
  readonly fact?: string;
  readonly category?: BusinessFactCategory;
  readonly sourceHref?: string | null;
  readonly audience?: BusinessFactAudience;
  readonly ownerUserId?: string;
}

/** `PATCH …/business-memory/facts/:factId`: the listed fields only, at least one. */
export function parseEdit(body: unknown): Parsed<FactEdit> {
  const issues: FieldIssue[] = [];
  const record = bodyRecord(body, EDIT_KEYS, issues);
  if (record === null) return { ok: false, issues };
  const edit: {
    fact?: string;
    category?: BusinessFactCategory;
    sourceHref?: string | null;
    audience?: BusinessFactAudience;
    ownerUserId?: string;
  } = {};
  if ('fact' in record) {
    const fact = normaliseFactText(record['fact']);
    if (fact === null) {
      issues.push({
        field: 'fact',
        message: `must be one line of 1 to ${String(BUSINESS_FACT_MAX_CHARS)} characters`,
      });
    } else edit.fact = fact;
  }
  if ('category' in record) {
    if (oneOf(BUSINESS_FACT_CATEGORIES, record['category'])) edit.category = record['category'];
    else
      issues.push({
        field: 'category',
        message: `must be one of ${BUSINESS_FACT_CATEGORIES.join(', ')}`,
      });
  }
  if ('audience' in record) {
    if (oneOf(BUSINESS_FACT_AUDIENCES, record['audience'])) edit.audience = record['audience'];
    else
      issues.push({
        field: 'audience',
        message: 'must be internal, client_visible, finance or hr',
      });
  }
  if ('sourceHref' in record) edit.sourceHref = sourceOf(record['sourceHref'], issues);
  if ('ownerUserId' in record) {
    if (isUuid(record['ownerUserId'])) edit.ownerUserId = record['ownerUserId'].toLowerCase();
    else issues.push({ field: 'ownerUserId', message: 'must be a member id' });
  }
  if (issues.length === 0 && Object.keys(edit).length === 0) {
    issues.push({ field: 'body', message: 'must change at least one field' });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: edit };
}

export interface EntityRef {
  readonly type: BusinessFactEntityType;
  readonly id: string | null;
}

/**
 * The recall route's `entities` parameter: `type:id` or a bare `process` / `company`, comma
 * separated, at most {@link BUSINESS_MEMORY_RECALL_MAX_ENTITIES}, duplicates dropped.
 */
export function parseEntityRefs(value: unknown): Parsed<readonly EntityRef[]> {
  const issue = {
    field: 'entities',
    message:
      `must list 1 to ${String(BUSINESS_MEMORY_RECALL_MAX_ENTITIES)} entities as type:id ` +
      '(client, project, person) or process / company',
  };
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, issues: [issue] };
  const parts = value.split(',').map((part) => part.trim());
  const refs = new Map<string, EntityRef>();
  for (const part of parts) {
    const [type, id, extra] = part.split(':');
    if (extra !== undefined || !oneOf(BUSINESS_FACT_ENTITY_TYPES, type)) {
      return { ok: false, issues: [issue] };
    }
    if (entityNeedsId(type)) {
      if (!isUuid(id)) return { ok: false, issues: [issue] };
      refs.set(`${type}:${id.toLowerCase()}`, { type, id: id.toLowerCase() });
    } else {
      if (id !== undefined) return { ok: false, issues: [issue] };
      refs.set(type, { type, id: null });
    }
  }
  if (refs.size === 0 || refs.size > BUSINESS_MEMORY_RECALL_MAX_ENTITIES) {
    return { ok: false, issues: [issue] };
  }
  return { ok: true, value: [...refs.values()] };
}
