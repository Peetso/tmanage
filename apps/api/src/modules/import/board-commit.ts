/**
 * 54-26 — the I/O half of the monday.com / ClickUp importers. `ImportService.commit` hands a
 * `monday_board` or `clickup_tasks` batch here after the shared job checks; this writes what
 * `board-export.ts` decided, inside the caller's transaction, as `commitNotionBatch` does:
 *
 * - the target project is resolved tenant-scoped first (missing / foreign → 404), and the
 *   object-layer `work.create` `authorize()` the manual route needs gates every row;
 * - a person is matched by e-mail (an active member with exactly that sign-in address, the
 *   Trello / Asana rule) or, for a display name, by the caller's `userMap` then a **unique**
 *   active member of that name; anything else imports unassigned and is counted;
 * - groups and tags become work labels (found by name or created);
 * - a sub-item / subtask becomes a step (`work_item_checklist_items`, 0414) of its root item (done when its status
 *   maps to done); its receipt row is typed `subtask`, which the undo leaves to the parent's
 *   soft delete;
 * - comments are written as the importing member, each headed by the source author and date.
 */

import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { WORK_LABEL_COLORS } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { WorkCommentsRepository } from '../work/work-comments.repository.js';
import type { WorkChecklistRepository } from '../work/work-checklist.repository.js';
import type { PmImportRepository } from './pm-import.repository.js';
import type { SourceMapping, SourceRow } from './import-validation.js';
import { boardCommitPlan } from './board-export.js';
import { resolvePeople, resolveProject, walkTo } from './basecamp-commit.js';
import type { ImportCommitDeps, ImportRowResult, ImportTargetOptions } from './basecamp-commit.js';

export interface BoardCommitDeps extends ImportCommitDeps {
  /** Work area D3 (0414): a sub-item becomes a step of its root item (the one steps model). */
  readonly steps: Pick<WorkChecklistRepository, 'create' | 'update'>;
  readonly comments: Pick<WorkCommentsRepository, 'create'>;
  readonly emails: Pick<PmImportRepository, 'activeUserIdsByEmail'>;
}

export interface BoardCommitSummary {
  readonly projectId: string;
  readonly itemsCreated: number;
  readonly subtasksCreated: number;
  readonly commentsCreated: number;
  readonly labelsCreated: number;
  /** `board_groups_as_labels`, `board_status_unmapped:<names>`, `board_person_unmatched:<n>`, … */
  readonly notes: readonly string[];
}

/** One row's outcome; a subtask row is typed `subtask` (not an undo target of its own). */
export type BoardRowResult =
  | ImportRowResult
  | { readonly index: number; readonly createdEntityId: string; readonly entityType: 'subtask' };

function day(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

/** Commit the valid rows of a `monday_board` / `clickup_tasks` batch. */
export async function commitBoardBatch(
  tx: TenantQueryRunner,
  context: TenantContext,
  principal: Principal,
  input: {
    readonly mapping: SourceMapping;
    readonly rows: readonly SourceRow[];
    readonly options: ImportTargetOptions;
    readonly invalidDetail: (index: number) => string | null;
  },
  projects: Pick<ProjectsRepository, 'findById'>,
  deps: BoardCommitDeps,
): Promise<{ readonly results: readonly BoardRowResult[]; readonly summary: BoardCommitSummary }> {
  const { mapping, rows, options } = input;
  const at = deps.now();
  const resource = await resolveProject(tx, context, projects, options.projectId);
  const results = new Map<number, BoardRowResult>();
  const valid = rows.flatMap((row, rowIndex) => {
    const detail = input.invalidDetail(rowIndex);
    if (detail !== null) results.set(rowIndex, { index: rowIndex, error: detail });
    return detail === null ? [{ rowIndex, row }] : [];
  });
  const sorted = () => [...results.values()].sort((a, b) => a.index - b.index);
  const empty = {
    projectId: resource.projectId,
    itemsCreated: 0,
    subtasksCreated: 0,
    commentsCreated: 0,
    labelsCreated: 0,
    notes: [],
  };

  const verdict = authorize({ principal, capability: 'work.create', resource });
  if (!verdict.allowed) {
    for (const { rowIndex } of valid)
      results.set(rowIndex, { index: rowIndex, error: verdict.detail });
    return { results: sorted(), summary: empty };
  }

  const plan = boardCommitPlan(mapping, valid, { statusMap: options.statusMap });
  const emails = plan.people.filter((p) => p.includes('@'));
  const names = new Set(plan.people.filter((p) => !p.includes('@')));
  const byEmail = await deps.emails.activeUserIdsByEmail(tx, context, emails);
  const byName = await resolvePeople(tx, context, names, options.userMap, deps);
  const ownerOf = (person: string | null): string | null =>
    person === null ? null : (byEmail.get(person) ?? byName.get(person) ?? null);

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

  const itemIdByRow = new Map<number, string>();
  let personUnmatched = 0;
  let commentsCreated = 0;
  for (const item of plan.items) {
    const owner = ownerOf(item.person);
    if (item.person !== null && owner === null) personUnmatched += 1;
    const created = await deps.workItems.create(tx, context, {
      projectId: resource.projectId,
      title: item.title,
      description: item.description,
      type: 'task',
      ownerUserId: owner,
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
      owner ?? context.userId,
      at,
    );
    for (const label of item.labels) {
      const labelId = labelIds.get(label);
      if (labelId !== undefined)
        await deps.labels.createAssignment(tx, context, created.id, labelId);
    }
    for (const body of item.comments) {
      await deps.comments.create(tx, context, {
        workItemId: created.id,
        authorMembershipId: context.membershipId,
        body,
      });
      commentsCreated += 1;
    }
    itemIdByRow.set(item.rowIndex, created.id);
    results.set(item.rowIndex, {
      index: item.rowIndex,
      createdEntityId: created.id,
      entityType: 'work_item',
    });
  }

  let subtasksCreated = 0;
  for (const sub of plan.subitems) {
    const parentId = itemIdByRow.get(sub.parentRowIndex);
    if (parentId === undefined) {
      results.set(sub.rowIndex, {
        index: sub.rowIndex,
        error: 'parent: the parent item was not imported',
      });
      continue;
    }
    const created = await deps.steps.create(tx, context, {
      workItemId: parentId,
      label: sub.title,
    });
    if (sub.done) await deps.steps.update(tx, context, parentId, created.id, { done: true });
    results.set(sub.rowIndex, {
      index: sub.rowIndex,
      createdEntityId: created.id,
      entityType: 'subtask',
    });
    subtasksCreated += 1;
  }

  const notes = ['board_groups_as_labels', ...plan.notes];
  if (personUnmatched > 0) notes.push(`board_person_unmatched:${personUnmatched}`);
  return {
    results: sorted(),
    summary: {
      projectId: resource.projectId,
      itemsCreated: plan.items.length,
      subtasksCreated,
      commentsCreated,
      labelsCreated,
      notes,
    },
  };
}
