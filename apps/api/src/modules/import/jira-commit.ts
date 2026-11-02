/**
 * R21-e (54-27) — the Jira commit, I/O half. `ImportService.commit` hands a `jira_issues` batch
 * here after the shared job checks; this writes exactly what `jiraCommitPlan` decided, inside the
 * caller's transaction:
 *
 * 1. the target project, resolved tenant-scoped (missing / foreign → 404);
 * 2. `work.create` on that project, once (a denial fails every row, as a manual create would);
 * 3. keeping keys: `project.manage` on the project (the capability 54-10's own prefix route uses —
 *    the plan's `project.update` is not a capability here), then the prefix — unset → set; this
 *    project's → fine; another project's → 409 `prefix_taken` naming it; this project with a
 *    different prefix → 409 `prefix_mismatch`. All refused **before** any insert;
 * 4. one iteration per sprint the project does not already have by name;
 * 5. one label per epic (found by name or created), assigned to the epic's children;
 * 6. per item: create, walk the state machine to the mapped state, join its sprint, keep its key;
 * 7. `work_key_next` moved past the highest kept number, so the next native item is `WEB-<max+1>`.
 *
 * A key that already exists in the project is a `failed` row ("already imported"), so re-running
 * the same export does not duplicate. Worklogs are never read.
 */

import { authorize } from '@tmanage/domain';
import type { Principal, WorkItemState } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { WORK_LABEL_COLORS } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { WorkKeysRepository } from '../work/work-keys.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { WorkLabelsRepository } from '../work/work-labels.repository.js';
import type { IterationsRepository } from '../iterations/iterations.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { JiraCommitOptions } from './import-input.js';
import type { SourceMapping, SourceRow } from './import-validation.js';
import { MAX_IMPORT_ROWS } from './import-validation.js';
import { isKeepablePrefix, jiraCommitPlan } from './jira-issues.js';
import type { JiraItemPlan } from './jira-issues.js';

/** The repositories the Jira commit writes through, each constructed statelessly. */
export interface JiraCommitDeps {
  readonly workKeys: Pick<
    WorkKeysRepository,
    'findProject' | 'projectWithPrefix' | 'setPrefix' | 'reserve' | 'setWorkKey' | 'resolveKeys'
  >;
  readonly workItems: Pick<WorkItemsRepository, 'create' | 'transitionState'>;
  readonly iterations: Pick<IterationsRepository, 'listForProject' | 'insert' | 'assignItems'>;
  readonly labels: Pick<
    WorkLabelsRepository,
    'findDefinitionByName' | 'createDefinition' | 'createAssignment'
  >;
  readonly memberships: Pick<MembershipsRepository, 'findByUserId'>;
  readonly now: () => Date;
}

/** One row's outcome; the service writes the `import_rows` receipt from it. */
export type JiraRowResult =
  | { readonly index: number; readonly createdEntityId: string }
  | { readonly index: number; readonly error: string };

/** The receipt summary the commit view carries for a Jira batch. */
export interface JiraCommitSummary {
  readonly projectId: string;
  readonly prefix: string | null;
  readonly sprintsCreated: number;
  readonly itemsKeyed: number;
  readonly epicsSkipped: number;
  readonly notes: readonly string[];
  /** R22-e: unknown ADF node / wiki macro names met in descriptions (receipt `jira_unknown_markup`). */
  readonly descriptionNotes: readonly string[];
}

/** Iterations read per project to match sprint names; a project with more is an outlier. */
const MAX_ITERATIONS_READ = 1000;

/** The forward path from `backlog` to each importable state (the §5 machine's main line). */
const PATH_TO: Readonly<Record<string, readonly WorkItemState[]>> = {
  backlog: [],
  ready: ['ready'],
  in_progress: ['ready', 'in_progress'],
  internal_review: ['ready', 'in_progress', 'internal_review'],
  done: ['ready', 'in_progress', 'internal_review', 'done'],
};

function notFound(code: string): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, code);
}

/**
 * Commit the valid rows of a `jira_issues` batch. `invalidRows` are the indexes the re-validation
 * refused; they come back as `failed` results with `invalidDetail(index)`.
 */
export async function commitJiraBatch(
  tx: TenantQueryRunner,
  context: TenantContext,
  principal: Principal,
  input: {
    readonly mapping: SourceMapping;
    readonly rows: readonly SourceRow[];
    readonly options: JiraCommitOptions;
    readonly invalidDetail: (index: number) => string | null;
  },
  projects: Pick<ProjectsRepository, 'findById'>,
  deps: JiraCommitDeps,
): Promise<{ readonly results: readonly JiraRowResult[]; readonly summary: JiraCommitSummary }> {
  const { mapping, rows, options } = input;
  const at = deps.now();

  // 1. The project, tenant-scoped. A foreign or unknown id is a 404 before anything else.
  const project = await projects.findById(tx, context, options.projectId);
  if (!project) throw notFound('import_project_not_visible');
  const resource = {
    organizationId: context.organizationId,
    projectId: project.id,
    audience: 'internal' as const,
    lifecycle: project.archivedAt === null ? ('active' as const) : ('archived' as const),
  };

  const valid = rows.flatMap((row, rowIndex) =>
    input.invalidDetail(rowIndex) === null ? [{ rowIndex, row }] : [],
  );
  const plan = jiraCommitPlan(mapping, valid, {
    statusMap: options.statusMap,
    today: at.toISOString().slice(0, 10),
    rowCap: MAX_IMPORT_ROWS,
  });

  // 3. Keys — every refusal here precedes the first insert.
  const prefix = options.keepKeys ? plan.prefix : null;
  if (prefix !== null) {
    const verdict = authorize({ principal, capability: 'project.manage', resource });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
    if (!isKeepablePrefix(prefix)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: 'options.keepKeys',
          message: `'${prefix}' cannot be a TManage key prefix (2-10 letters or digits); import with keepKeys false`,
        },
      ]);
    }
    const keyState = await deps.workKeys.findProject(tx, context, project.id, true);
    if (!keyState) throw notFound('import_project_not_visible');
    if (keyState.workKeyPrefix !== null && keyState.workKeyPrefix !== prefix) {
      throw new ApiError(
        409,
        'conflict',
        `This project already uses the prefix ${keyState.workKeyPrefix}`,
        [{ field: 'options.projectId', message: `keys ${prefix}-n need a project without one` }],
        'prefix_mismatch',
      );
    }
    if (keyState.workKeyPrefix === null) {
      const holder = await deps.workKeys.projectWithPrefix(tx, context, prefix);
      if (holder !== null && holder !== project.id) {
        const other = await projects.findById(tx, context, holder);
        throw new ApiError(
          409,
          'conflict',
          `The prefix ${prefix} is used by the project "${other?.name ?? holder}"`,
          [
            {
              field: 'options.keepKeys',
              message: 'rename that prefix first, or import without keys',
            },
          ],
          'prefix_taken',
        );
      }
      await deps.workKeys.setPrefix(tx, context, project.id, prefix);
    }
  }

  const results = new Map<number, JiraRowResult>();
  for (let index = 0; index < rows.length; index += 1) {
    const detail = input.invalidDetail(index);
    if (detail !== null) results.set(index, { index, error: detail });
  }

  // 2. The create gate, once for the project.
  const createVerdict = authorize({ principal, capability: 'work.create', resource });
  if (!createVerdict.allowed) {
    for (const { rowIndex } of valid)
      results.set(rowIndex, { index: rowIndex, error: createVerdict.detail });
    return {
      results: [...results.values()].sort((a, b) => a.index - b.index),
      summary: summaryOf(
        project.id,
        prefix,
        0,
        0,
        plan.epics.length,
        plan.notes,
        plan.descriptionNotes,
      ),
    };
  }

  // 4. Sprints → iterations, matched by name inside the project.
  const existing = await deps.iterations.listForProject(
    tx,
    context,
    project.id,
    MAX_ITERATIONS_READ,
  );
  const iterationByName = new Map(existing.map((it) => [it.name, it.id] as const));
  let sprintsCreated = 0;
  for (const sprint of plan.sprints) {
    if (iterationByName.has(sprint.name)) continue;
    const id = await deps.iterations.insert(
      tx,
      context,
      {
        projectId: project.id,
        name: sprint.name,
        goal: null,
        startsOn: sprint.startsOn,
        endsOn: sprint.endsOn,
      },
      at,
    );
    iterationByName.set(sprint.name, id);
    sprintsCreated += 1;
  }

  // 5. Epics → labels (no item). The epic row's receipt cites the label it became.
  const labelByEpic = new Map<string, string>();
  for (const epic of plan.epics) {
    const found = await deps.labels.findDefinitionByName(tx, context, epic.labelName);
    const label =
      found ??
      (await deps.labels.createDefinition(tx, context, {
        name: epic.labelName,
        color: WORK_LABEL_COLORS[0],
      }));
    labelByEpic.set(epic.key, label.id);
    results.set(epic.rowIndex, { index: epic.rowIndex, createdEntityId: label.id });
  }

  // Keys already present in the project: those rows were imported before.
  const taken =
    prefix === null
      ? new Map<string, string>()
      : await deps.workKeys.resolveKeys(
          tx,
          context,
          plan.items.map((item) => item.key),
          [project.id],
        );

  const owners = await resolveOwners(tx, context, plan.items, options.userMap, deps);
  const notes = new Set(plan.notes);
  if (!options.keepKeys) notes.add('keys_not_kept');

  // 6. Items.
  let itemsKeyed = 0;
  let maxKept = 0;
  for (const item of plan.items) {
    if (taken.has(item.key)) {
      results.set(item.rowIndex, {
        index: item.rowIndex,
        error: `issueKey: ${item.key} already exists in this project`,
      });
      continue;
    }
    const owner = item.assigneeEmail === null ? null : (owners.get(item.assigneeEmail) ?? null);
    if (item.assigneeEmail !== null && owner === null) notes.add('assignee_unmatched');
    const created = await deps.workItems.create(tx, context, {
      projectId: project.id,
      title: item.title,
      description: item.description,
      type: item.type,
      ownerUserId: owner,
      dueAt: item.dueOn === null ? null : new Date(`${item.dueOn}T00:00:00.000Z`),
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

    const iterationId = item.sprint === null ? undefined : iterationByName.get(item.sprint);
    if (iterationId !== undefined) {
      await deps.iterations.assignItems(tx, context, [created.id], iterationId, at);
    }
    const labelId = item.epicKey === null ? undefined : labelByEpic.get(item.epicKey);
    if (labelId !== undefined) await deps.labels.createAssignment(tx, context, created.id, labelId);
    if (prefix !== null) {
      await deps.workKeys.setWorkKey(tx, context, created.id, item.key);
      itemsKeyed += 1;
      maxKept = Math.max(maxKept, item.number);
    }
    results.set(item.rowIndex, { index: item.rowIndex, createdEntityId: created.id });
  }

  // 7. The counter moves past the highest kept number.
  if (prefix !== null && maxKept > 0) {
    const keyState = await deps.workKeys.findProject(tx, context, project.id, true);
    const next = keyState?.workKeyNext ?? 1;
    if (next <= maxKept) await deps.workKeys.reserve(tx, context, project.id, maxKept + 1 - next);
  }

  return {
    results: [...results.values()].sort((a, b) => a.index - b.index),
    summary: summaryOf(
      project.id,
      prefix,
      sprintsCreated,
      itemsKeyed,
      plan.epics.length,
      [...notes],
      plan.descriptionNotes,
    ),
  };
}

function summaryOf(
  projectId: string,
  prefix: string | null,
  sprintsCreated: number,
  itemsKeyed: number,
  epicsSkipped: number,
  notes: readonly string[],
  descriptionNotes: readonly string[],
): JiraCommitSummary {
  return { projectId, prefix, sprintsCreated, itemsKeyed, epicsSkipped, notes, descriptionNotes };
}

/** Assignee email → user id, kept only for an active member of this organization. */
async function resolveOwners(
  tx: TenantQueryRunner,
  context: TenantContext,
  items: readonly JiraItemPlan[],
  userMap: Readonly<Record<string, string>>,
  deps: JiraCommitDeps,
): Promise<ReadonlyMap<string, string>> {
  const owners = new Map<string, string>();
  const emails = new Set(items.flatMap((i) => (i.assigneeEmail === null ? [] : [i.assigneeEmail])));
  for (const email of emails) {
    const userId = userMap[email];
    if (userId === undefined) continue;
    const membership = await deps.memberships.findByUserId(tx, context, userId);
    if (membership?.status === 'active') owners.set(email, userId);
  }
  return owners;
}

/**
 * Walk a fresh `backlog` item along the §5 main line to `target`; the repository runs every step
 * through the state machine, so a changed machine refuses here rather than writing a bad state.
 */
async function walkTo(
  tx: TenantQueryRunner,
  context: TenantContext,
  deps: JiraCommitDeps,
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
