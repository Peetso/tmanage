/**
 * R22-f (54-28) — the I/O half of the two new import kinds. `ImportService.commit` hands a
 * `notion_database` or `basecamp_messages` batch here after the shared job checks; this writes
 * what the pure halves (`notion-database.ts`, `basecamp-html.ts`) decided, inside the caller's
 * transaction, exactly as `jira-commit.ts` does for Jira:
 *
 * - the target project is resolved tenant-scoped first (missing / foreign → 404);
 * - each write passes the object-layer `authorize()` the manual route would: `work.create` for a
 *   work item; `doc.write` (the capability `documents.controller.ts` `@Post()` requires) **and**
 *   `work.create` (what `DocumentsService.create` checks) for a document; `project.manage` (the
 *   phases controller's) for a Basecamp to-do list → project phase (`ProjectPhasesRepository`
 *   exposes `createDefinition`, so a list is a phase, not a `list:<name>` label);
 * - a person is matched by display name: the caller's `userMap` (keys lower-cased) first, then a
 *   **unique** active member with that exact name; anything else imports unassigned and is
 *   counted (Privacy: no account linking by guess). The author of a message stays text.
 *
 * Basecamp message comments go into the document body under `## Comments` (author + time); the
 * document-comments repository is not touched. Skipped kinds (Campfire, Hill Charts, schedule,
 * files) write no entity and no receipt row; they are counted in `basecampSkipped`.
 */

import { authorize } from '@tmanage/domain';
import type { Capability, Principal, WorkItemState } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { WORK_LABEL_COLORS } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { DocumentsRepository } from '../docs/documents.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { WorkLabelsRepository } from '../work/work-labels.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { ProjectPhasesRepository } from '../projects/phases.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { SourceMapping, SourceRow } from './import-validation.js';
import { notionCommitPlan } from './notion-database.js';
import {
  BASECAMP_SKIPPED_KINDS,
  basecampHtmlToMarkdown,
  basecampMessageToDocument,
} from './basecamp-html.js';
import type { BasecampComment } from './basecamp-html.js';

/** The options both kinds take (R21-e's option shape; `keepKeys` is not read here). */
export interface ImportTargetOptions {
  readonly projectId: string;
  readonly statusMap: Readonly<Record<string, string>>;
  readonly userMap: Readonly<Record<string, string>>;
}

export interface ImportCommitDeps {
  readonly documents: Pick<DocumentsRepository, 'create'>;
  readonly workItems: Pick<WorkItemsRepository, 'create' | 'transitionState'>;
  readonly phases: Pick<ProjectPhasesRepository, 'listDefinitions' | 'createDefinition'>;
  readonly labels: Pick<
    WorkLabelsRepository,
    'findDefinitionByName' | 'createDefinition' | 'createAssignment'
  >;
  readonly memberships: Pick<MembershipsRepository, 'findByUserId' | 'listWithNames'>;
  readonly now: () => Date;
}

export type ImportedEntityType = 'document' | 'work_item' | 'phase';

/** One row's outcome; the service writes the `import_rows` receipt from it. */
export type ImportRowResult =
  | {
      readonly index: number;
      readonly createdEntityId: string;
      readonly entityType: ImportedEntityType;
    }
  | { readonly index: number; readonly error: string };

export interface NotionCommitSummary {
  readonly projectId: string;
  readonly itemsCreated: number;
  readonly labelsCreated: number;
  /** `notion_status_unmapped:<names>`, `notion_person_unmatched:<n>`. */
  readonly notes: readonly string[];
}

export interface BasecampCommitSummary {
  readonly projectId: string;
  readonly documentsCreated: number;
  readonly itemsCreated: number;
  readonly phasesCreated: number;
  /** Rows not imported, by kind: `{ campfire: n, hillchart: n, … }`. */
  readonly basecampSkipped: Readonly<Record<string, number>>;
  /** `basecamp_schedule_skipped`, `basecamp_html_stripped:<names>`, `basecamp_person_unmatched:<n>`. */
  readonly notes: readonly string[];
}

interface BatchInput {
  readonly mapping: SourceMapping;
  readonly rows: readonly SourceRow[];
  readonly options: ImportTargetOptions;
  readonly invalidDetail: (index: number) => string | null;
}

const MAX_DESCRIPTION = 20_000;
/** Members read per name lookup; a roster with more namesakes than this is not a unique match. */
const MEMBER_LOOKUP_LIMIT = 200;

/** The forward path from `backlog` (copied from `jira-commit.ts`, where it is not exported). */
const PATH_TO: Readonly<Record<string, readonly WorkItemState[]>> = {
  backlog: [],
  ready: ['ready'],
  in_progress: ['ready', 'in_progress'],
  internal_review: ['ready', 'in_progress', 'internal_review'],
  done: ['ready', 'in_progress', 'internal_review', 'done'],
};

function sortedResults(results: Map<number, ImportRowResult>): readonly ImportRowResult[] {
  return [...results.values()].sort((a, b) => a.index - b.index);
}

async function resolveProject(
  tx: TenantQueryRunner,
  context: TenantContext,
  projects: Pick<ProjectsRepository, 'findById'>,
  projectId: string,
) {
  const project = await projects.findById(tx, context, projectId);
  if (!project) {
    throw new ApiError(
      404,
      'not_found',
      MESSAGES.notFound,
      undefined,
      'import_project_not_visible',
    );
  }
  return {
    organizationId: context.organizationId,
    projectId: project.id,
    audience: 'internal' as const,
    lifecycle: project.archivedAt === null ? ('active' as const) : ('archived' as const),
  };
}

/**
 * Display names → user ids. `userMap` (lower-cased keys) first, kept only for an active member;
 * then exactly one active member whose display name equals the name (case-insensitive).
 */
async function resolvePeople(
  tx: TenantQueryRunner,
  context: TenantContext,
  names: ReadonlySet<string>,
  userMap: Readonly<Record<string, string>>,
  deps: ImportCommitDeps,
): Promise<ReadonlyMap<string, string>> {
  const resolved = new Map<string, string>();
  for (const name of names) {
    const key = name.trim().toLowerCase();
    const mapped = userMap[key];
    if (mapped !== undefined) {
      const membership = await deps.memberships.findByUserId(tx, context, mapped);
      if (membership?.status === 'active') resolved.set(name, mapped);
      continue;
    }
    const candidates = await deps.memberships.listWithNames(tx, context, {
      q: name.trim(),
      limit: MEMBER_LOOKUP_LIMIT,
    });
    const exact = candidates.filter((m) => m.displayName.trim().toLowerCase() === key);
    if (exact.length === 1 && exact[0]) resolved.set(name, exact[0].userId);
  }
  return resolved;
}

/** Walk a fresh `backlog` item along the §5 main line to `target` through the state machine. */
async function walkTo(
  tx: TenantQueryRunner,
  context: TenantContext,
  deps: ImportCommitDeps,
  id: string,
  version: number,
  target: WorkItemState,
  completedBy: string,
  at: Date,
): Promise<void> {
  let current = version;
  for (const to of PATH_TO[target] ?? []) {
    const done = to === 'done';
    const row = await deps.workItems.transitionState(
      tx,
      context,
      id,
      current,
      to,
      done ? { ownerId: completedBy, completedAt: at.toISOString() } : {},
      done ? { ownerUserId: completedBy, completedAt: at } : undefined,
    );
    current = row.version;
  }
}

function day(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

function failAll(
  results: Map<number, ImportRowResult>,
  indexes: readonly number[],
  error: string,
): void {
  for (const index of indexes) results.set(index, { index, error });
}

/** Commit the valid rows of a `notion_database` batch. */
export async function commitNotionBatch(
  tx: TenantQueryRunner,
  context: TenantContext,
  principal: Principal,
  input: BatchInput,
  projects: Pick<ProjectsRepository, 'findById'>,
  deps: ImportCommitDeps,
): Promise<{
  readonly results: readonly ImportRowResult[];
  readonly summary: NotionCommitSummary;
}> {
  const { mapping, rows, options } = input;
  const at = deps.now();
  const resource = await resolveProject(tx, context, projects, options.projectId);
  const results = new Map<number, ImportRowResult>();
  const valid = rows.flatMap((row, rowIndex) => {
    const detail = input.invalidDetail(rowIndex);
    if (detail !== null) results.set(rowIndex, { index: rowIndex, error: detail });
    return detail === null ? [{ rowIndex, row }] : [];
  });

  const verdict = authorize({ principal, capability: 'work.create', resource });
  if (!verdict.allowed) {
    failAll(
      results,
      valid.map((v) => v.rowIndex),
      verdict.detail,
    );
    return {
      results: sortedResults(results),
      summary: { projectId: resource.projectId, itemsCreated: 0, labelsCreated: 0, notes: [] },
    };
  }

  // A first pass collects the person names; they are resolved once, then the real plan runs.
  const names = new Set<string>();
  notionCommitPlan(mapping, valid, {
    resolvePerson: (name) => {
      names.add(name);
      return null;
    },
  });
  const people = await resolvePeople(tx, context, names, options.userMap, deps);
  const plan = notionCommitPlan(mapping, valid, {
    statusMap: options.statusMap,
    resolvePerson: (name) => people.get(name) ?? null,
  });

  const labelIds = new Map<string, string>();
  let labelsCreated = 0;
  for (const name of plan.labels) {
    const found = await deps.labels.findDefinitionByName(tx, context, name);
    if (found) labelIds.set(name, found.id);
    else {
      const created = await deps.labels.createDefinition(tx, context, {
        name,
        color: WORK_LABEL_COLORS[0],
      });
      labelIds.set(name, created.id);
      labelsCreated += 1;
    }
  }

  let itemsCreated = 0;
  for (const item of plan.items) {
    const created = await deps.workItems.create(tx, context, {
      projectId: resource.projectId,
      title: item.title,
      description: item.description,
      type: 'task',
      ownerUserId: item.ownerUserId,
      startAt: day(item.startOn),
      dueAt: day(item.dueOn),
    });
    await walkTo(
      tx,
      context,
      deps,
      created.id,
      created.version,
      item.state,
      item.ownerUserId ?? context.userId,
      at,
    );
    for (const label of item.labels) {
      const labelId = labelIds.get(label);
      if (labelId !== undefined)
        await deps.labels.createAssignment(tx, context, created.id, labelId);
    }
    results.set(item.rowIndex, {
      index: item.rowIndex,
      createdEntityId: created.id,
      entityType: 'work_item',
    });
    itemsCreated += 1;
  }

  return {
    results: sortedResults(results),
    summary: { projectId: resource.projectId, itemsCreated, labelsCreated, notes: plan.notes },
  };
}

function str(row: SourceRow, field: string): string | undefined {
  const value = row[field];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Commit the valid rows of a `basecamp_messages` batch. */
export async function commitBasecampBatch(
  tx: TenantQueryRunner,
  context: TenantContext,
  principal: Principal,
  input: BatchInput,
  projects: Pick<ProjectsRepository, 'findById'>,
  deps: ImportCommitDeps,
): Promise<{
  readonly results: readonly ImportRowResult[];
  readonly summary: BasecampCommitSummary;
}> {
  const { rows, options } = input;
  const at = deps.now();
  const resource = await resolveProject(tx, context, projects, options.projectId);
  const results = new Map<number, ImportRowResult>();
  const skipped: Record<string, number> = {};
  const stripped = new Set<string>();
  const valid: { rowIndex: number; row: SourceRow; kind: string }[] = [];
  rows.forEach((row, rowIndex) => {
    const detail = input.invalidDetail(rowIndex);
    if (detail !== null) {
      results.set(rowIndex, { index: rowIndex, error: detail });
      return;
    }
    const kind = String(row['kind']);
    if (BASECAMP_SKIPPED_KINDS.has(kind as never)) skipped[kind] = (skipped[kind] ?? 0) + 1;
    else valid.push({ rowIndex, row, kind });
  });

  const allowed = (capability: Capability): string | null => {
    const verdict = authorize({ principal, capability, resource });
    return verdict.allowed ? null : verdict.detail;
  };
  const workDenied = allowed('work.create');
  const docDenied = allowed('doc.write') ?? workDenied;
  const phaseDenied = allowed('project.manage');

  const names = new Set(
    valid.flatMap((v) => {
      const name = v.kind === 'todo' ? str(v.row, 'assignee') : undefined;
      return name === undefined ? [] : [name];
    }),
  );
  const people =
    workDenied === null
      ? await resolvePeople(tx, context, names, options.userMap, deps)
      : new Map<string, string>();
  let personUnmatched = 0;

  const phaseNames = new Set<string>();
  let phasePosition = 0;
  if (phaseDenied === null && valid.some((v) => v.kind === 'todolist')) {
    const existing = await deps.phases.listDefinitions(tx, context, resource.projectId);
    existing.forEach((phase) => phaseNames.add((phase.name ?? '').trim().toLowerCase()));
    phasePosition = existing.reduce((max, phase) => Math.max(max, (phase.position ?? 0) + 1), 0);
  }

  let documentsCreated = 0;
  let itemsCreated = 0;
  let phasesCreated = 0;
  for (const { rowIndex, row, kind } of valid) {
    const title = (str(row, 'title') ?? '').slice(0, 255);
    if (kind === 'message') {
      if (docDenied !== null) {
        results.set(rowIndex, { index: rowIndex, error: docDenied });
        continue;
      }
      const author = str(row, 'author');
      const postedAt = str(row, 'postedAt');
      const document = basecampMessageToDocument({
        path: str(row, 'path') ?? '',
        title,
        ...(author === undefined ? {} : { author }),
        ...(postedAt === undefined ? {} : { postedAt }),
        html: typeof row['html'] === 'string' ? row['html'] : '',
        comments: Array.isArray(row['comments']) ? (row['comments'] as BasecampComment[]) : [],
      });
      document.stripped.forEach((name) => stripped.add(name));
      const created = await deps.documents.create(tx, context, {
        projectId: resource.projectId,
        title: document.title,
        body: document.body,
        createdByUserId: context.userId,
      });
      results.set(rowIndex, {
        index: rowIndex,
        createdEntityId: created.id,
        entityType: 'document',
      });
      documentsCreated += 1;
    } else if (kind === 'todo') {
      if (workDenied !== null) {
        results.set(rowIndex, { index: rowIndex, error: workDenied });
        continue;
      }
      const converted = basecampHtmlToMarkdown(typeof row['html'] === 'string' ? row['html'] : '');
      converted.stripped.forEach((name) => stripped.add(name));
      const list = str(row, 'list');
      const description = [list === undefined ? '' : `List: ${list}`, converted.markdown]
        .filter((part) => part !== '')
        .join('\n\n')
        .slice(0, MAX_DESCRIPTION);
      const assignee = str(row, 'assignee');
      const owner = assignee === undefined ? null : (people.get(assignee) ?? null);
      if (assignee !== undefined && owner === null) personUnmatched += 1;
      const dueAt = str(row, 'dueAt');
      const created = await deps.workItems.create(tx, context, {
        projectId: resource.projectId,
        title,
        description: description === '' ? null : description,
        type: 'task',
        ownerUserId: owner,
        dueAt: dueAt === undefined ? null : new Date(`${dueAt}T00:00:00.000Z`),
      });
      if (row['completed'] === true) {
        await walkTo(
          tx,
          context,
          deps,
          created.id,
          created.version,
          'done',
          owner ?? context.userId,
          at,
        );
      }
      results.set(rowIndex, {
        index: rowIndex,
        createdEntityId: created.id,
        entityType: 'work_item',
      });
      itemsCreated += 1;
    } else {
      // `todolist` → a project phase definition.
      if (phaseDenied !== null) {
        results.set(rowIndex, { index: rowIndex, error: phaseDenied });
        continue;
      }
      const key = title.trim().toLowerCase();
      if (phaseNames.has(key)) {
        results.set(rowIndex, {
          index: rowIndex,
          error: `title: the phase ${title} already exists in this project`,
        });
        continue;
      }
      const phase = await deps.phases.createDefinition(tx, context, {
        projectId: resource.projectId,
        name: title.slice(0, 120),
        position: phasePosition,
      });
      phaseNames.add(key);
      phasePosition += 1;
      results.set(rowIndex, { index: rowIndex, createdEntityId: phase.id, entityType: 'phase' });
      phasesCreated += 1;
    }
  }

  const notes: string[] = [];
  if ((skipped['schedule'] ?? 0) > 0) notes.push('basecamp_schedule_skipped');
  if (stripped.size > 0) notes.push(`basecamp_html_stripped:${[...stripped].sort().join(', ')}`);
  if (personUnmatched > 0) notes.push(`basecamp_person_unmatched:${personUnmatched}`);
  return {
    results: sortedResults(results),
    summary: {
      projectId: resource.projectId,
      documentsCreated,
      itemsCreated,
      phasesCreated,
      basecampSkipped: skipped,
      notes,
    },
  };
}

/**
 * The undo half for these kinds: delete what one batch created, by `created_entity_id` and the
 * entity type the commit reported. There is no undo route yet (the import service has no
 * rollback, `import_rows` has no entity-type column, and `DocumentsRepository` has no delete), so
 * the document deleter is injected; work items go through `softDelete` (PA-03's restore window).
 */
export interface UndoDeps {
  readonly documents: {
    remove(tx: TenantQueryRunner, context: TenantContext, documentId: string): Promise<void>;
  };
  readonly workItems: Pick<WorkItemsRepository, 'softDelete'>;
  readonly phases: Pick<ProjectPhasesRepository, 'deleteDefinition'>;
}

export async function undoImportedEntities(
  tx: TenantQueryRunner,
  context: TenantContext,
  entities: readonly { readonly type: ImportedEntityType; readonly id: string }[],
  deps: UndoDeps,
): Promise<{ readonly deleted: number }> {
  let deleted = 0;
  for (const entity of entities) {
    if (entity.type === 'document') await deps.documents.remove(tx, context, entity.id);
    else if (entity.type === 'work_item') {
      await deps.workItems.softDelete(tx, context, entity.id, 'import_undo');
    } else await deps.phases.deleteDefinition(tx, context, entity.id);
    deleted += 1;
  }
  return { deleted };
}
