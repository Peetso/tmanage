import type { CreateWorkItemInput, WorkItemAudience } from '../../../lib/api/work-items';
import type { StageSetView, StageView } from '../../../lib/api/work-stages';
import { dayToInstant } from '../../../lib/work-item-presentation';
import { parseQuickDate, quickDateInstant } from '../../../lib/quick-date';
import { orderedStages } from '../stages/stage-model';

/**
 * **New work: the pure half** (Work area v2, W-WEB-3; Figma `WV2-03` quick, `WV2-04` full).
 *
 * Quick and full create are one form with the same fields, order and words as the work page's
 * properties panel. Everything a create sends is decided here, without a render, so the request
 * is proven directly: the create body, the share-target prefill and the stage a new work starts on.
 */

/** The prefilled values a share-target payload (or an empty open) produces. */
export interface CaptureDraft {
  readonly title: string;
  readonly note: string;
}

/**
 * Derive the title and the description from the share-target query (`?title=`, `?text=`,
 * `?url=`). A page's `title` seeds the name; a separate `text` and the `url` go to the
 * description. A share that carries only `text` uses it as the name and does not repeat it.
 */
export function buildCaptureDraft(query: {
  readonly title?: string | null;
  readonly text?: string | null;
  readonly url?: string | null;
}): CaptureDraft {
  const rawTitle = (query.title ?? '').trim();
  const text = (query.text ?? '').trim();
  const url = (query.url ?? '').trim();
  const title = rawTitle !== '' ? rawTitle : text;
  const noteParts: string[] = [];
  if (rawTitle !== '' && text !== '' && text !== title) noteParts.push(text);
  if (url !== '') noteParts.push(url);
  return { title, note: noteParts.join('\n\n') };
}

/**
 * The project create opens on (CQ-07 / WRK-09): the one the caller was handed when it is one of
 * theirs, otherwise none, so the destination is a choice and never the first project standing in.
 */
export function initialCaptureProjectId(
  available: readonly { readonly id: string }[],
  initialProjectId?: string,
): string {
  return available.some((project) => project.id === initialProjectId)
    ? (initialProjectId ?? '')
    : '';
}

/** What the form holds when Create is pressed. */
export interface NewWorkDraft {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly doerUserIds?: readonly string[];
  readonly supervisorUserIds?: readonly string[];
  readonly watcherUserIds?: readonly string[];
  /** The project's client companies that may follow the work; none = internal. */
  readonly clientOrganizationIds?: readonly string[];
  /** Follow (`client_visible`) or act (`client_action_required`), when a client is chosen. */
  readonly clientAudience?: Exclude<WorkItemAudience, 'internal'>;
  readonly steps?: readonly string[];
  /** `YYYY-MM-DD`, or blank. */
  readonly dueDay?: string;
  readonly startDay?: string;
  /** The clock "tomorrow 3pm" in the title is read against (FIX-QUEUE B1). */
  readonly now?: Date;
}

/**
 * The `POST work-items` body. A date written in the name ("tomorrow 3pm") leaves the name and
 * becomes the due date unless a day was picked: the pick wins. Empty lists are left out, so a
 * create with nothing chosen sends exactly the project and the name. A client makes the work
 * visible to that client (spec 5.3: who sees it follows from the client choice).
 */
export function buildNewWorkPayload(draft: NewWorkDraft): CreateWorkItemInput {
  const picked = (draft.dueDay ?? '') !== '';
  const parsed = parseQuickDate(draft.title, draft.now);
  const dueAt = picked
    ? dayToInstant(draft.dueDay ?? '')
    : parsed === null
      ? null
      : quickDateInstant(parsed);
  const startAt = dayToInstant(draft.startDay ?? '');
  const description = (draft.description ?? '').trim();
  const steps = (draft.steps ?? []).map((label) => label.trim()).filter((label) => label !== '');
  const clients = draft.clientOrganizationIds ?? [];
  const list = (key: string, ids: readonly string[] | undefined) =>
    ids && ids.length > 0 ? { [key]: [...ids] } : {};
  return {
    projectId: draft.projectId,
    title: (parsed?.title ?? draft.title).trim(),
    ...(description === '' ? {} : { description }),
    ...(startAt === null ? {} : { startAt }),
    ...(dueAt === null ? {} : { dueAt }),
    ...list('doerUserIds', draft.doerUserIds),
    ...list('supervisorUserIds', draft.supervisorUserIds),
    ...list('watcherUserIds', draft.watcherUserIds),
    ...(clients.length > 0
      ? { audience: draft.clientAudience ?? 'client_visible', clientOrganizationIds: [...clients] }
      : {}),
    ...(steps.length > 0 ? { steps: steps.map((label) => ({ label })) } : {}),
  };
}

/** The set a new work uses before anything is picked: its project's, else the workspace default. */
export function defaultSetForProject(
  sets: readonly StageSetView[],
  projectSet: StageSetView | null,
): StageSetView | null {
  return projectSet ?? sets.find((set) => set.isDefault) ?? sets[0] ?? null;
}

/** The stage a new work starts on: the first stage of the set (Figma: "Empathize"). */
export function firstStage(set: StageSetView | null): StageView | null {
  if (!set) return null;
  return orderedStages(set.stages)[0] ?? null;
}

/**
 * The stage writes a create needs after the item exists. The API files a new work on its
 * project's set and its first state, so a different set is written first, then a stage other
 * than the one the work landed on is moved to.
 */
export function stageFollowUp(input: {
  readonly chosenSet: StageSetView | null;
  /** The set the API files the work on: {@link defaultSetForProject}. */
  readonly baseSet: StageSetView | null;
  readonly chosenStage: StageView | null;
  readonly landedStageId: string | null;
}): { readonly stageSetId: string | null; readonly stage: StageView | null } {
  const ownSet =
    input.chosenSet !== null && input.chosenSet.id !== (input.baseSet?.id ?? null)
      ? input.chosenSet.id
      : null;
  const stage =
    input.chosenStage !== null && input.chosenStage.id !== input.landedStageId
      ? input.chosenStage
      : null;
  return { stageSetId: ownSet, stage };
}
