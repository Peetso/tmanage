'use client';

import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { workItemStateMachine } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { CurrentTaskButton } from '../time/AutoTimerStatus';
import { WorkItemTimerButton } from '../time/TimerControls';
import { AppShell } from '../shell/AppShell';
import { MemberSelect } from '../MemberSelect';
import './work-core.css';
import { WorkCommentsPanel } from './WorkCommentsPanel';
import { WorkItemCodeLinks } from './WorkItemCodeLinks';
import { FigmaLinksPanel } from '../viewer/FigmaLinks';
import { NotScannedDownload } from './NotScannedDownload';
import { SendForApprovalDialog } from './SendForApprovalDialog';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import {
  deleteWorkItem,
  detachWorkItemFile,
  duplicateWorkItem,
  getWorkItem,
  getWorkItemClientAudience,
  getWorkItemPeople,
  listWorkComments,
  listWorkItemFiles,
  transitionWorkItem,
  updateWorkItem,
} from '../../lib/api/work-items';
import { transitionOrQueue } from '../../lib/offline/write-or-queue';
import type {
  ItemFile,
  UpdateWorkItemInput,
  WorkItemAudience,
  WorkItemSummary,
} from '../../lib/api/work-items';
import { listProjects } from '../../lib/api/projects';
import { listWorkActivity } from '../../lib/api/work-activity';
import {
  addDeliverableVersion,
  getDeliverable,
  listApprovers,
  listDeliverables,
} from '../../lib/api/deliverables';
import type { DeliverableDetailView, DeliverableVersionView } from '../../lib/api/deliverables';
import { listClientOrganizationOptions } from '../../lib/api/project-client';
import { listProjectShares } from '../../lib/api/clients';
import {
  attachmentProblem,
  uploadProjectFileFor,
  uploadWorkItemAttachment,
} from '../../lib/api/uploads';
import { UploadProgressItem, useUploadQueue } from '../storage/UploadProgress';
import type { UploadRow } from '../../lib/upload-queue';
import {
  getStorageStatus,
  importDriveFileToWorkItem,
  listDriveAttachments,
} from '../../lib/api/google-drive';
import {
  getOneDriveStatus,
  importOneDriveFileToWorkItem,
  listOneDriveAttachments,
} from '../../lib/api/onedrive';
import type { PickedOneDriveItem } from '../../lib/onedrive-picker';
import type { PickedDriveItem } from '../../lib/google-picker';
import { DriveAttachPicker } from '../storage/DriveAttachPicker';
import { CloudFoldersCard } from '../storage/CloudFoldersCard';
import { cloudImportMessageKey } from '../../lib/cloud-import-copy';
import { HelpTip } from '../help/HelpTip';
import { OneDriveAttachPicker, oneDriveStatusKey } from '../storage/OneDriveAttachPicker';
import { NoStorageAttach, useAttachStorageState } from '../storage/NoStorageAttach';
import { addAttachmentVersion, getAttachmentHistory } from '../../lib/api/attachment-versions';
import type { AttachmentVersion } from '../../lib/api/attachment-versions';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { workItemKeys } from '../../lib/query-keys';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { useRecordRecentItem } from '../../lib/use-record-recent-item';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { audienceLabel, formatDay } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import {
  audienceFailureMessage,
  clientPickerMode,
  mayConfirmAudience,
  tickedClientIds,
  widenRequest,
} from '../../lib/work-item-client-audience';
import type { ProjectClientChoice } from '../../lib/work-item-client-audience';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useUndo } from '../../lib/undo/use-undo';
import { undoKey } from '../../lib/undo/undo-queue';
import { AccessExplainer } from '../access/AccessExplainer';
import type { MessageKey } from '../../lib/i18n/t';
import { dayOf, formatShortDay, useA6T, WorkDialogFrame } from '../work/DueDatePicker';
import { useOwnerCandidates } from '../work/OwnerPickerDialog';
import { needsSupervisorApproval, workItemPeopleKey } from '../work/WorkPeopleBlock';
import { WorkDecision } from '../work/detail/WorkDecision';
import { WorkPropertiesPanel } from '../work/detail/WorkPropertiesPanel';
import { WorkSteps } from '../work/detail/WorkSteps';
import { WorkTitle } from '../work/detail/WorkTitle';
import { StageTrail, WorkStageControl } from '../work/stages/WorkStageControl';
import { useWorkStages, type WorkStages } from '../work/stages/use-work-stages';
import '../work/detail/work-detail.css';
import { DeleteWorkItemDialog } from '../work/DeleteWorkItemDialog';
import { WorkItemActionsMenu, type WorkItemAction } from '../work/WorkItemActionsMenu';

export interface WorkItemDetailScreenProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
  /**
   * Where to go once the item is deleted. The page passes the router; without it the screen
   * falls back to a full navigation to the work list.
   */
  onDeleted?: () => void;
  /** Where "Duplicate" goes: the new copy. The page passes the router. */
  onOpenItem?: (workItemId: string) => void;
  /** Injected in tests so the date picker's "today" is fixed. */
  now?: Date;
}

/** The label a person reads for each fact the machine can require. */
const FACT_LABEL: Record<string, string> = {
  blockerReason: 'What is blocking this',
  blockerAsk: 'What you need, and from whom',
  blockerOwnerUserId: 'Who the ask is on',
  blockerResolution: 'How it was resolved',
  ownerId: 'Who owned this to completion',
  completedAt: 'When it was completed',
  reopenReason: 'Why it is being reopened',
};

/** The facts that name a person — D16: asked for with the member picker, never a UUID box. */
const MEMBER_FACTS: readonly string[] = ['ownerId', 'blockerOwnerUserId'];

const STATE_KEY: Record<WorkItemState, MessageKey> = {
  backlog: 'WorkListScreen.stateBacklog',
  ready: 'WorkListScreen.stateReady',
  in_progress: 'WorkListScreen.stateInProgress',
  blocked: 'WorkListScreen.stateBlocked',
  internal_review: 'WorkListScreen.stateInternalReview',
  done: 'WorkListScreen.stateDone',
  archived: 'WorkListScreen.stateArchived',
};

/** Approval states that mean "waiting on the reviewer". */
const OPEN_APPROVAL = new Set(['requested', 'viewed']);

/**
 * The shortest run of moves from `from` to `done` that asks for nothing but what `done` asks
 * for — an owner and a completion time. "Mark done" on an item in progress therefore sends it
 * through internal review and on to done, each step its own audited transition the server
 * re-checks; a state with no such run (blocked, done, archived) has no "Mark done" at all.
 */
export function pathToDone(from: WorkItemState): readonly WorkItemState[] | null {
  const queue: (readonly WorkItemState[])[] = [[from]];
  const seen = new Set<WorkItemState>([from]);
  while (queue.length > 0) {
    const path = queue.shift() as readonly WorkItemState[];
    const at = path[path.length - 1] as WorkItemState;
    for (const next of workItemStateMachine.allowedFrom(at)) {
      const needs = workItemStateMachine.requirementsFor(at, next);
      if (next === 'done') {
        if (needs.every((fact) => fact === 'ownerId' || fact === 'completedAt')) {
          return [...path.slice(1), next];
        }
        continue;
      }
      if (needs.length > 0 || seen.has(next) || next === 'archived') continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

/** A date-and-time control's value for an instant, in the browser's local time. */
function toLocalControlValue(instant: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}

function describe(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('WorkDetail.networkError');
  return t('WorkDetail.genericError');
}

/**
 * How a refused write reads on this page, the same in the body and in the properties panel: a
 * stale version (409 on `version`) is "somebody else changed this first" and reloads the item;
 * any other 409 (an active blocker already exists) is the API's own words; anything else is
 * described. Nothing is retried.
 */
type WriteFailure =
  { readonly conflict: true } | { readonly conflict: false; readonly message: string };

function writeFailure(error: unknown, t: (key: string) => string): WriteFailure {
  if (error instanceof ApiRequestError && error.status === 409) {
    return error.fieldErrors().has('version')
      ? { conflict: true }
      : { conflict: false, message: error.message };
  }
  return { conflict: false, message: describe(error, t) };
}

function WriteAlerts({ conflict, failure }: { conflict: boolean; failure: string | undefined }) {
  const t = useT();
  return (
    <>
      {conflict ? (
        <InlineAlert tone="warning" title={t('WorkItemDetailScreen.conflictTitle')} live>
          {t('WorkItemDetailScreen.conflictBody')}
        </InlineAlert>
      ) : null}
      {failure ? (
        <InlineAlert tone="danger" title={t('WorkItemDetailScreen.failureTitle')} live>
          {failure}
        </InlineAlert>
      ) : null}
    </>
  );
}

function fileKind(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0
    ? 'FILE'
    : name
        .slice(dot + 1)
        .toUpperCase()
        .slice(0, 5);
}

/**
 * **TM-13 Work item detail — A6 (Figma fq7-work-item-detail).**
 *
 * The header reads "<Project> / Work", the title, and Delete · Edit · Mark done. Under it the
 * state and audience pills, then the facts as chips — Owner (the owner picker), Start and Due
 * (the date picker), and Reviewer when a file of this item is a deliverable version: the open
 * approval's reviewer, and the chip opens "Send for approval". Three tabs follow: Details (the
 * description and checklist beside the Files card), Files (n) and Activity (n).
 *
 * Every write carries the version this screen read. A version `409` says somebody else changed
 * the item, reloads it and never retries — a retry with a fresh version is the lost update the
 * token exists to prevent. Field refusals stay on the field that caused them.
 *
 * The Files card's "Version history" block shows a deliverable file's versions
 * (`lib/api/deliverables.ts`) and, since C7, a plain attachment's (`lib/api/attachment-versions`):
 * every file offers "Upload new version", and the block is drawn once a file has more than one
 * version rather than drawn empty. A previous plain version downloads by its own file id, so the
 * scan policy decides exactly as for the current one.
 */
export function WorkItemDetailScreen({
  organizationSlug,
  organizationName,
  workItemId,
  client,
  onDeleted,
  onOpenItem,
  now,
}: WorkItemDetailScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const ta = useA6T();
  const itemKey = ['work-item', organizationSlug, workItemId] as const;

  const item = useQuery({
    queryKey: itemKey,
    queryFn: () => getWorkItem(api, organizationSlug, workItemId),
  });

  useRecordRecentItem({
    organizationSlug,
    objectType: 'work',
    objectId: workItemId,
    enabled: item.isSuccess,
    client,
  });

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const projectName =
    projects.data?.find((project) => project.id === item.data?.projectId)?.name ?? '';
  const stages = useWorkStages(
    api,
    organizationSlug,
    item.data ?? { projectId: '', stageId: null, state: 'backlog' },
  );
  const [headerFailure, setHeaderFailure] = useState<string | undefined>(undefined);

  function changed(next: WorkItemSummary) {
    queries.setQueryData(itemKey, next);
    void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
  }

  const rename = useMutation({
    mutationFn: (title: string) =>
      updateWorkItem(api, organizationSlug, workItemId, {
        title,
        version: item.data?.version ?? 0,
      }),
    onSuccess: changed,
    onError: (error) => {
      setHeaderFailure(describe(error, ta));
      void item.refetch();
    },
  });

  const dispatch = (action: HeaderAction) =>
    window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: action }));

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={
        <span className="tm-wk-crumbs">
          {item.data && projectName !== '' ? (
            <>
              <Link href={`/${organizationSlug}/projects/${item.data.projectId}`}>
                {projectName}
              </Link>
              <span aria-hidden="true"> › </span>
            </>
          ) : null}
          <Link href={`/${organizationSlug}/work`}>{ta('WorkDetail.work')}</Link>
        </span>
      }
      title={item.data?.title ?? t('WorkItemDetailScreen.fallbackTitle')}
      {...(item.data
        ? {
            titleContent: (
              <WorkTitle
                api={api}
                organizationSlug={organizationSlug}
                title={item.data.title}
                saving={rename.isPending}
                onRename={(title) => rename.mutate(title)}
              />
            ),
          }
        : {})}
      actions={
        item.data ? (
          <div className="tm-wk-head-actions">
            <WorkStageControl
              api={api}
              organizationSlug={organizationSlug}
              item={item.data}
              stages={stages}
              onChanged={changed}
            />
            <WorkDecision
              api={api}
              organizationSlug={organizationSlug}
              item={item.data}
              canFinish={pathToDone(item.data.state) !== null}
              onDone={() => dispatch('done')}
              onChanged={changed}
              onError={setHeaderFailure}
            />
            {/* 52-01: the start/stop timer (Figma 574:32611). */}
            <WorkItemTimerButton
              organizationSlug={organizationSlug}
              workItemId={workItemId}
              workItemTitle={item.data.title}
              client={api}
            />
            {/* FIX-2026-11-10: "Work on this now" for the automatic timer. */}
            <CurrentTaskButton
              organizationSlug={organizationSlug}
              workItemId={workItemId}
              client={api}
            />
            <WorkItemActionsMenu itemTitle={item.data.title} onAction={dispatch} />
          </div>
        ) : undefined
      }
      {...(item.data
        ? {
            lens: (
              <WorkLens
                api={api}
                organizationSlug={organizationSlug}
                item={item.data}
                projects={projects.data ?? []}
                projectName={projectName}
                stages={stages}
                {...(now === undefined ? {} : { now })}
                onChanged={changed}
                onConflict={() => void item.refetch()}
              />
            ),
          }
        : {})}
    >
      {item.isPending ? (
        <LoadingRegion label={t('WorkItemDetailScreen.loading')}>
          <Skeleton height="var(--app-row)" />
          <Skeleton height="var(--app-row)" />
        </LoadingRegion>
      ) : null}

      {item.isError ? (
        <InlineAlert tone="danger" title={t('WorkItemDetailScreen.loadError')} live>
          {item.error instanceof NetworkError
            ? t('WorkItemDetailScreen.networkError')
            : t('WorkItemDetailScreen.genericError')}
        </InlineAlert>
      ) : null}

      {headerFailure ? (
        <InlineAlert tone="danger" title={t('WorkItemDetailScreen.failureTitle')} live>
          {headerFailure}
        </InlineAlert>
      ) : null}

      {item.data ? (
        <>
          <StageTrail stages={stages} />
          <WorkItemBody
            item={item.data}
            api={api}
            organizationSlug={organizationSlug}
            projectName={projectName}
            onChanged={changed}
            onConflict={() => {
              void item.refetch();
            }}
            onDeleted={() => {
              void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
              if (onDeleted) onDeleted();
              else window.location.assign(`/${organizationSlug}/work`);
            }}
            onOpenItem={(id) => {
              void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
              if (onOpenItem) onOpenItem(id);
              else window.location.assign(`/${organizationSlug}/work/${id}`);
            }}
          />
        </>
      ) : null}
    </AppShell>
  );
}

/**
 * The header's buttons live in the shell's action slot, the body owns the dialogs they open;
 * a window event carries the press across without lifting every dialog into the shell.
 */
const ACTION_EVENT = 'tm:work-item-action';
type HeaderAction = WorkItemAction | 'done';

/**
 * The properties panel in the shell's lens (Work area v2, Figma `933:95423`): the client and
 * audience reads, the in-place edits of project and dates, and the two editors the page owns —
 * who sees it (widening is confirmed) and the status move (a blocker needs a reason and an ask).
 */
function WorkLens({
  api,
  organizationSlug,
  item,
  projects,
  projectName,
  stages,
  now,
  onChanged,
  onConflict,
}: {
  api: ApiClient;
  organizationSlug: string;
  item: WorkItemSummary;
  projects: readonly { readonly id: string; readonly name: string }[];
  projectName: string;
  stages: WorkStages;
  now?: Date;
  onChanged: (next: WorkItemSummary) => void;
  onConflict: () => void;
}) {
  const ta = useA6T();
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const shares = useQuery({
    queryKey: ['project-shares', organizationSlug, item.projectId],
    queryFn: () => listProjectShares(api, organizationSlug, item.projectId),
  });
  const clientOptions = useQuery({
    queryKey: ['client-organization-options', organizationSlug],
    queryFn: () => listClientOrganizationOptions(api, organizationSlug),
    enabled: (shares.data?.length ?? 0) > 0,
  });
  const projectClients: readonly ProjectClientChoice[] = (shares.data ?? []).map((share) => ({
    id: share.clientOrganizationId,
    name:
      clientOptions.data?.find((option) => option.id === share.clientOrganizationId)?.name ?? '',
  }));
  const clientAudience = useQuery({
    queryKey: ['work-item-client-audience', organizationSlug, item.id],
    queryFn: () => getWorkItemClientAudience(api, organizationSlug, item.id),
    enabled: item.audience !== 'internal' && projectClients.length > 0,
  });
  const tickedClients = tickedClientIds(projectClients, clientAudience.data ?? []);
  const clientNames = projectClients
    .filter((choice) => tickedClients.includes(choice.id) && choice.name !== '')
    .map((choice) => choice.name);

  function handleError(error: unknown) {
    const outcome = writeFailure(error, ta);
    setConflict(outcome.conflict);
    setFailure(outcome.conflict ? undefined : outcome.message);
    if (outcome.conflict) onConflict();
  }

  const edit = useMutation({
    mutationFn: (input: Omit<UpdateWorkItemInput, 'version'>) =>
      updateWorkItem(api, organizationSlug, item.id, { ...input, version: item.version }),
    onSuccess: (next) => {
      setFailure(undefined);
      setConflict(false);
      onChanged(next);
    },
    onError: handleError,
  });

  return (
    <>
      <WorkPropertiesPanel
        api={api}
        organizationSlug={organizationSlug}
        item={item}
        projects={projects}
        projectName={projectName}
        stages={stages}
        clientNames={clientNames}
        {...(now === undefined ? {} : { now })}
        saving={edit.isPending}
        onEdit={(changes) => edit.mutate(changes)}
        onChanged={onChanged}
        audienceEditor={() => (
          <AudiencePanel
            item={item}
            api={api}
            organizationSlug={organizationSlug}
            projectClients={projectClients}
            clientsLoaded={shares.isSuccess}
            tickedClients={tickedClients}
            onChanged={onChanged}
            onError={handleError}
          />
        )}
        statusEditor={(close) => (
          <MovePanel
            item={item}
            api={api}
            organizationSlug={organizationSlug}
            onMoved={(next) => {
              onChanged(next);
              close();
            }}
            onError={handleError}
          />
        )}
      />
      <WriteAlerts conflict={conflict} failure={failure} />
    </>
  );
}

interface WorkItemBodyProps {
  item: WorkItemSummary;
  api: ApiClient;
  organizationSlug: string;
  projectName: string;
  onChanged: (next: WorkItemSummary) => void;
  onConflict: () => void;
  onDeleted: () => void;
  onOpenItem: (workItemId: string) => void;
}

type Overlay = { kind: 'delete' } | { kind: 'approval' } | { kind: 'why' } | null;

type Tab = 'comments' | 'activity';

/**
 * The work page's one scroll (Work area v2, Figma `933:95423`; plan §4.3): description, steps,
 * files, then comments and activity under two tabs that are the heading. Every property lives in
 * the panel beside it and is edited in place; there is no "Edit details" form any more.
 */
function WorkItemBody({
  item,
  api,
  organizationSlug,
  projectName,
  onChanged,
  onConflict,
  onDeleted,
  onOpenItem,
}: WorkItemBodyProps) {
  const ta = useA6T();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const queries = useQueryClient();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [tab, setTab] = useState<Tab>('comments');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const [copied, setCopied] = useState(false);

  const directory = useMembers(api, organizationSlug);
  const owners = useOwnerCandidates(api, organizationSlug, item.projectId);

  const files = useQuery({
    queryKey: ['work-item-files', organizationSlug, item.id],
    queryFn: () => listWorkItemFiles(api, organizationSlug, item.id),
  });
  const activity = useQuery({
    queryKey: ['work-activity', organizationSlug, item.id],
    queryFn: () => listWorkActivity(api, organizationSlug, item.id),
  });
  const comments = useQuery({
    queryKey: ['work-item-comments', organizationSlug, item.id],
    queryFn: () => listWorkComments(api, organizationSlug, item.id),
  });

  // The client of this project, named in the delete note.
  const shares = useQuery({
    queryKey: ['project-shares', organizationSlug, item.projectId],
    queryFn: () => listProjectShares(api, organizationSlug, item.projectId),
  });
  const clientOptions = useQuery({
    queryKey: ['client-organization-options', organizationSlug],
    queryFn: () => listClientOrganizationOptions(api, organizationSlug),
    enabled: (shares.data?.length ?? 0) > 0,
  });
  const clientId = shares.data?.[0]?.clientOrganizationId;
  const clientName = clientOptions.data?.find((option) => option.id === clientId)?.name;

  // Deliverable-backed files: a file of this item that is a version of one of the project's
  // deliverables. Only those carry a version history, a reviewer and "Upload new version".
  const attached = files.data ?? [];
  const deliverables = useQuery({
    queryKey: ['deliverables', organizationSlug, item.projectId],
    queryFn: () => listDeliverables(api, organizationSlug, item.projectId),
    enabled: attached.length > 0,
  });
  const details = useQueries({
    queries: (deliverables.data ?? []).slice(0, 20).map((deliverable) => ({
      queryKey: ['deliverable', organizationSlug, deliverable.id],
      queryFn: () => getDeliverable(api, organizationSlug, deliverable.id),
    })),
  });
  const backed = details
    .map((query) => query.data)
    .filter((detail): detail is DeliverableDetailView => detail !== undefined);
  const backingOf = (file: ItemFile) =>
    backed.find((detail) =>
      detail.versions.some((version) => version.fileAssetId === file.fileAssetId),
    );
  const firstBacking = attached.map(backingOf).find((detail) => detail !== undefined);
  const latestOf = (detail: DeliverableDetailView) =>
    [...detail.versions].sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))[0];
  const reviewVersion = firstBacking ? latestOf(firstBacking) : undefined;
  const openApproval =
    reviewVersion?.approval && OPEN_APPROVAL.has(reviewVersion.approval.state)
      ? reviewVersion.approval
      : null;
  const approvers = useQuery({
    queryKey: ['deliverable-approvers', organizationSlug, firstBacking?.id ?? ''],
    queryFn: () => listApprovers(api, organizationSlug, firstBacking?.id ?? ''),
    enabled: openApproval !== null && firstBacking !== undefined,
  });
  const reviewerId = openApproval?.reviewerIds[0];
  const reviewerName =
    approvers.data?.find((approver) => approver.userId === reviewerId)?.displayName ??
    (reviewerId === undefined ? undefined : ta('WorkDetail.clientReviewer'));

  function handleWriteError(error: unknown) {
    const outcome = writeFailure(error, ta);
    setConflict(outcome.conflict);
    setFailure(outcome.conflict ? undefined : outcome.message);
    if (outcome.conflict) {
      setOverlay(null);
      onConflict();
    }
  }

  /** The description is edited in place; one PATCH with the version this screen read. */
  const edit = useMutation({
    mutationFn: (input: Omit<UpdateWorkItemInput, 'version'>) =>
      updateWorkItem(api, organizationSlug, item.id, {
        ...input,
        version: item.version,
      } satisfies UpdateWorkItemInput),
    onSuccess: (next) => {
      onChanged(next);
      setFailure(undefined);
      setConflict(false);
    },
    onError: handleWriteError,
  });

  // C27: the same read the panel makes (shared cache). A task with supervisors is done by one of
  // them: anyone else's "Mark done" stops in internal review and waits for approval.
  const people = useQuery({
    queryKey: workItemPeopleKey(organizationSlug, item.id),
    queryFn: () => getWorkItemPeople(api, organizationSlug, item.id),
  });

  const finish = useMutation({
    mutationFn: async () => {
      const full = pathToDone(item.state) ?? [];
      const path = needsSupervisorApproval(people.data) ? full.filter((to) => to !== 'done') : full;
      let current = item;
      for (const to of path) {
        current = await transitionWorkItem(api, organizationSlug, item.id, {
          version: current.version,
          to,
          facts:
            to === 'done' && current.ownerUserId !== null
              ? { ownerId: current.ownerUserId, completedAt: new Date().toISOString() }
              : {},
        });
        onChanged(current);
      }
      return current;
    },
    onSuccess: () => {
      setFailure(undefined);
      setConflict(false);
    },
    onError: handleWriteError,
  });

  const duplicate = useMutation({
    mutationFn: () =>
      duplicateWorkItem(
        api,
        organizationSlug,
        item,
        ta('WorkDetail.copyOf', { title: item.title }),
      ),
    onSuccess: (copy) => onOpenItem(copy.id),
    onError: (error) => setFailure(describe(error, ta)),
  });

  // 55-23: the delete is held behind an Undo toast for a few seconds; the item leaves at once
  // and Undo brings the person straight back to it. Nothing reaches the server until the hold ends.
  const undo = useUndo();
  function confirmDelete() {
    setOverlay(null);
    undo.schedule({
      key: undoKey('work', item.id),
      message: tOr('Undo.workDeleted', 'Item deleted'),
      commit: () => deleteWorkItem(api, organizationSlug, item.id),
      onCommitted: () => {
        void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
      },
      onFailed: () => {
        void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
      },
      onUndo: () => onOpenItem(item.id),
    });
    onDeleted();
  }

  function act(action: HeaderAction) {
    if (action === 'duplicate') duplicate.mutate();
    else if (action === 'delete') setOverlay({ kind: 'delete' });
    else if (action === 'why') setOverlay({ kind: 'why' });
    else if (action === 'copyLink') {
      void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true));
    } else if (action === 'done') {
      if (item.ownerUserId === null) {
        setFailure(ta('WorkPage.doerFirst'));
      } else {
        // 55-23: "Mark done" is held behind an Undo toast like a delete.
        undo.schedule({
          key: `${undoKey('work', item.id)}:done`,
          message: tOr('Undo.workCompleted', 'Marked done'),
          commit: () => finish.mutateAsync(),
        });
      }
    }
  }

  // The header's buttons are rendered by the shell; their presses arrive as a window event.
  useWindowEvent(ACTION_EVENT, (event) => act((event as CustomEvent<HeaderAction>).detail));

  const fileCount = attached.length;
  const commentCount = comments.data?.length ?? 0;

  return (
    <div className="tm-wk-page" data-testid="work-item-page">
      <WriteAlerts conflict={conflict} failure={failure} />
      {copied ? (
        <p className="tm-wk-section__meta" role="status">
          {ta('WorkPage.linkCopied')}
        </p>
      ) : null}

      <DescriptionSection
        item={item}
        saving={edit.isPending}
        onSave={(description) => edit.mutate({ description })}
      />

      <WorkSteps
        api={api}
        organizationSlug={organizationSlug}
        workItemId={item.id}
        people={owners.candidates}
        onOpenItem={onOpenItem}
      />

      <section className="tm-wk-section tm-wk-files" aria-labelledby="tm-wk-files-title">
        <div className="tm-wk-section__head">
          <h2 id="tm-wk-files-title" className="tm-wk-section__title">
            {ta('WorkDetail.tabFiles')}
          </h2>
          {fileCount > 0 ? <span className="tm-wk-section__meta">{fileCount}</span> : null}
          {firstBacking && reviewVersion ? (
            <Button
              tone="text"
              size="header"
              flush
              onClick={() => setOverlay({ kind: 'approval' })}
            >
              {reviewerName
                ? `${ta('WorkDetail.reviewer')}: ${reviewerName}`
                : ta('WorkDetail.sendForApproval')}
            </Button>
          ) : null}
        </div>
        <FilesCard
          api={api}
          organizationSlug={organizationSlug}
          item={item}
          files={attached}
          loading={files.isPending}
          failed={files.isError}
          backingOf={backingOf}
          latestOf={latestOf}
          members={directory}
          locale={locale}
        />
        <CloudFoldersCard
          organizationSlug={organizationSlug}
          client={api}
          workItemId={item.id}
          projectId={item.projectId}
        />
        <FigmaLinksPanel
          organizationSlug={organizationSlug}
          projectId={item.projectId}
          target={{ type: 'work_item', id: item.id }}
          canAttach
          client={api}
        />
        <WorkItemCodeLinks organizationSlug={organizationSlug} workItemId={item.id} api={api} />
      </section>

      <section className="tm-wk-section tm-wk-talk" aria-label={ta('WorkPage.talkLabel')}>
        <div className="tm-wk-segment" role="tablist" aria-label={ta('WorkPage.talkLabel')}>
          {(
            [
              ['comments', ta('WorkPage.comments'), commentCount],
              ['activity', ta('WorkDetail.tabActivity'), undefined],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`tm-wk-panel-${id}`}
              id={`tm-wk-tab-${id}`}
              onClick={() => setTab(id)}
            >
              {label}
              {count === undefined || count === 0 ? null : (
                <span className="tm-wk-count">{count}</span>
              )}
            </button>
          ))}
        </div>
        {tab === 'comments' ? (
          <div role="tabpanel" id="tm-wk-panel-comments" aria-labelledby="tm-wk-tab-comments">
            <WorkCommentsPanel organizationSlug={organizationSlug} workItemId={item.id} api={api} />
          </div>
        ) : (
          <div role="tabpanel" id="tm-wk-panel-activity" aria-labelledby="tm-wk-tab-activity">
            {activity.isPending ? <Skeleton height="var(--app-row)" /> : null}
            {activity.isError ? (
              <p className="tm-wk-section__empty">{ta('WorkDetail.activityError')}</p>
            ) : null}
            <ol className="tm-wk-activity">
              {(activity.data ?? []).map((entry) => (
                <li key={entry.id}>
                  <span>{entry.summary}</span>
                  <time dateTime={entry.occurredAt}>
                    {formatShortDay(dayOf(entry.occurredAt), locale)}
                  </time>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      {overlay?.kind === 'delete' ? (
        <DeleteWorkItemDialog
          title={item.title}
          fileCount={fileCount}
          clientVisible={item.audience !== 'internal'}
          {...(clientName === undefined ? {} : { clientName })}
          deleting={false}
          onConfirm={confirmDelete}
          onClose={() => setOverlay(null)}
        />
      ) : null}

      {overlay?.kind === 'why' ? (
        <WhyDialog
          api={api}
          organizationSlug={organizationSlug}
          item={item}
          projectName={projectName}
          onClose={() => setOverlay(null)}
        />
      ) : null}

      {overlay?.kind === 'approval' && firstBacking && reviewVersion ? (
        <SendForApprovalDialog
          api={api}
          organizationSlug={organizationSlug}
          deliverableId={firstBacking.id}
          deliverableTitle={firstBacking.title}
          version={reviewVersion}
          onClose={() => setOverlay(null)}
          onSent={() => {
            setOverlay(null);
            void queries.invalidateQueries({
              queryKey: ['deliverable', organizationSlug, firstBacking.id],
            });
          }}
        />
      ) : null}
    </div>
  );
}

/** "Why can I see this?" from the More menu: the reasons, in a small dialog. */
function WhyDialog({
  api,
  organizationSlug,
  item,
  projectName,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  item: WorkItemSummary;
  projectName: string;
  onClose: () => void;
}) {
  const ta = useA6T();
  const titleId = useId();
  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <h2 id={titleId} className="tm-wk-dialog__title">
        {ta('WorkActions.why')}
      </h2>
      <AccessExplainer
        api={api}
        organizationSlug={organizationSlug}
        audience={item.audience}
        projectName={projectName}
        ownerUserId={item.ownerUserId}
        editCapability="work.update"
        variant="inline"
      />
      <div className="tm-wk-dialog__actions">
        <Button tone="outline" size="large" onClick={onClose}>
          {ta('WorkPage.close')}
        </Button>
      </div>
    </WorkDialogFrame>
  );
}

/** A window event, handled by the latest `handler` without re-subscribing on every render. */
function useWindowEvent(name: string, handler: (event: Event) => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const listener = (event: Event) => latest.current(event);
    window.addEventListener(name, listener);
    return () => window.removeEventListener(name, listener);
  }, [name]);
}

/** The description, edited in place: a press on it opens the box; leaving the box saves. */
function DescriptionSection({
  item,
  saving,
  onSave,
}: {
  item: WorkItemSummary;
  saving: boolean;
  onSave: (description: string | null) => void;
}) {
  const ta = useA6T();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.description ?? '');
  const boxId = useId();
  useEffect(() => {
    if (!editing) setDraft(item.description ?? '');
  }, [item.description, editing]);

  function save() {
    setEditing(false);
    const next = draft.trim();
    if (next !== (item.description ?? '').trim()) onSave(next === '' ? null : next);
  }

  return (
    <section className="tm-wk-section tm-wk-description" aria-labelledby="tm-wk-description">
      <h2 id="tm-wk-description" className="tm-wk-section__title">
        {editing ? (
          <label htmlFor={boxId}>{ta('WorkDetail.description')}</label>
        ) : (
          ta('WorkDetail.description')
        )}
      </h2>
      {editing ? (
        <textarea
          id={boxId}
          className="tm-wk-textarea tm-wk-description__box"
          value={draft}
          dir="auto"
          rows={4}
          maxLength={20000}
          // Opened by the person's press on the description, so the box takes focus.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(item.description ?? '');
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="tm-wk-description__text"
          data-empty={!item.description || undefined}
          aria-busy={saving || undefined}
          aria-label={ta('WorkPage.editDescription')}
          onClick={() => setEditing(true)}
        >
          <span dir="auto">
            {item.description ? item.description : ta('WorkPage.addDescription')}
          </span>
        </button>
      )}
    </section>
  );
}

interface FilesCardProps {
  api: ApiClient;
  organizationSlug: string;
  item: WorkItemSummary;
  files: readonly ItemFile[];
  loading: boolean;
  failed: boolean;
  backingOf: (file: ItemFile) => DeliverableDetailView | undefined;
  latestOf: (detail: DeliverableDetailView) => DeliverableVersionView | undefined;
  members: ReturnType<typeof useMembers>;
  locale: string;
}

/** Which chain "Upload new version" adds to: a deliverable's, or a plain attachment's (C7). */
type VersionTarget =
  | { readonly kind: 'deliverable'; readonly id: string }
  | { readonly kind: 'plain'; readonly id: string };

function attachmentHistoryKey(organizationSlug: string, fileAssetId: string) {
  return ['attachment-history', organizationSlug, fileAssetId] as const;
}

/** The Files card: attachments, "Attach file", and a version history for every file. */
function FilesCard({
  api,
  organizationSlug,
  item,
  files,
  loading,
  failed,
  backingOf,
  latestOf,
  members,
  locale,
}: FilesCardProps) {
  const ta = useA6T();
  const queries = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const versionPicker = useRef<HTMLInputElement>(null);
  const [versionTarget, setVersionTarget] = useState<VersionTarget | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const base = apiBaseUrl();
  const href = (fileAssetId: string) =>
    `${base}/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(fileAssetId)}/content`;

  // C7. The version history of each plain (not deliverable-backed) attachment.
  const plainFiles = files.filter((file) => backingOf(file) === undefined).slice(0, 20);
  const plainHistories = useQueries({
    queries: plainFiles.map((file) => ({
      queryKey: attachmentHistoryKey(organizationSlug, file.fileAssetId),
      queryFn: () => getAttachmentHistory(api, organizationSlug, file.fileAssetId),
    })),
  });
  const plainHistoryOf = (file: ItemFile): readonly AttachmentVersion[] => {
    const index = plainFiles.findIndex((entry) => entry.id === file.id);
    return index < 0 ? [] : (plainHistories[index]?.data?.versions ?? []);
  };

  const addPlainVersion = useMutation({
    mutationFn: (input: { rootFileAssetId: string; fileAssetId: string }) =>
      addAttachmentVersion(api, organizationSlug, input.rootFileAssetId, {
        fileAssetId: input.fileAssetId,
      }),
    onSuccess: (_history, input) => {
      setProblem(undefined);
      void queries.invalidateQueries({
        queryKey: attachmentHistoryKey(organizationSlug, input.rootFileAssetId),
      });
    },
    onError: (error) => setProblem(describe(error, ta)),
  });

  // B (wave 17). Files attached from Google Drive are listed below the TManage ones in the same
  // rows; the storage status decides whether the Drive picker is offered.
  const storageQuery = {
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(api, organizationSlug),
    staleTime: 60_000,
  };
  const storage = useQuery(storageQuery);
  // 419:23811 / 419:23844: with neither Google Drive nor OneDrive chosen, nothing can be attached;
  // files attached before stay listed.
  const attachState = useAttachStorageState(organizationSlug, api);
  const noStorage = attachState === 'connect' || attachState === 'ask';
  const driveKey = ['drive-attachments', organizationSlug, item.id] as const;
  const driveFiles = useQuery({
    queryKey: driveKey,
    queryFn: () => listDriveAttachments(api, organizationSlug, item.id),
    enabled: storage.data?.configured === true,
  });
  const driveRows = driveFiles.data ?? [];

  // 0236. The same for OneDrive: its files below Drive's, and "Attach from OneDrive" in the head.
  const oneDriveQuery = {
    queryKey: oneDriveStatusKey(organizationSlug),
    queryFn: () => getOneDriveStatus(api, organizationSlug),
    staleTime: 60_000,
  };
  const oneDrive = useQuery(oneDriveQuery);
  const oneDriveKey = ['onedrive-attachments', organizationSlug, item.id] as const;
  const oneDriveFiles = useQuery({
    queryKey: oneDriveKey,
    queryFn: () => listOneDriveAttachments(api, organizationSlug, item.id),
    enabled: oneDrive.data?.configured === true,
  });
  const oneDriveRows = oneDriveFiles.data ?? [];
  // FIX6 C1. A picked drive file becomes a checked TManage copy in this item's files (the server
  // fetches it), so the client can open it in the portal without connecting anything.
  const filesKey = ['work-item-files', organizationSlug, item.id] as const;
  const cloudProblem = (error: unknown) => {
    const key = cloudImportMessageKey(error);
    return key ? ta(key) : describe(error, ta);
  };
  const attachFromOneDrive = useMutation({
    mutationFn: async (picked: readonly PickedOneDriveItem[]) => {
      for (const file of picked) {
        await importOneDriveFileToWorkItem(api, organizationSlug, item.id, file);
      }
    },
    onSuccess: () => setProblem(undefined),
    onError: (error) => setProblem(cloudProblem(error)),
    onSettled: () => void queries.invalidateQueries({ queryKey: filesKey }),
  });
  const attachFromDrive = useMutation({
    mutationFn: async (picked: readonly PickedDriveItem[]) => {
      for (const file of picked) {
        await importDriveFileToWorkItem(api, organizationSlug, item.id, file.id);
      }
    },
    onSuccess: () => setProblem(undefined),
    onError: (error) => setProblem(cloudProblem(error)),
    onSettled: () => void queries.invalidateQueries({ queryKey: filesKey }),
  });

  // 409:6602. Each new file is a progress row (bar, Cancel, Retry) until it is attached; a dropped
  // connection reads "Upload stopped at N %", any other refusal in the API's words.
  const uploads = useUploadQueue((error) =>
    error instanceof NetworkError ? null : describe(error, ta),
  );
  // UX-1 (live UX test 69836a13, O-P1-2): several files at once. A file the checks refuse before
  // sending (empty, too large, a blocked type) is named with its reason instead of being dropped;
  // the others go up, each with its own progress row and Retry.
  const attachFiles = (picked: readonly File[]) => {
    const refused = picked.flatMap((file) => {
      const reason = attachmentProblem(file);
      return reason === null ? [] : [reason];
    });
    setProblem(refused.length > 0 ? refused.join(' ') : undefined);
    for (const file of picked) {
      if (attachmentProblem(file) === null) void attachFile(file);
    }
  };
  const attachFile = async (file: File) => {
    // FIX6 item 2: the same road as chat and Files — uploaded to TManage, attached as an item file.
    await uploads.start(file, async (sent, deps) => {
      const attached = await uploadWorkItemAttachment(
        api,
        organizationSlug,
        { workItemId: item.id, projectId: item.projectId, file: sent },
        deps,
      );
      void queries.invalidateQueries({ queryKey: filesKey });
      return attached.id;
    });
  };
  // A finished row stands in for its attachment, so the list below does not show it twice.
  const justUploaded = new Set(
    uploads.rows.flatMap((row) => (row.state === 'done' && row.resultId ? [row.resultId] : [])),
  );
  const removeUpload = async (row: UploadRow) => {
    if (row.state === 'done' && row.resultId) {
      try {
        await detachWorkItemFile(api, organizationSlug, item.id, row.resultId);
      } catch (error) {
        setProblem(describe(error, ta));
        return;
      }
      void queries.invalidateQueries({ queryKey: filesKey });
    }
    uploads.remove(row.id);
  };

  const addVersion = useMutation({
    mutationFn: async (input: {
      deliverableId: string;
      fileAssetId: string;
      note: string | null;
    }) =>
      addDeliverableVersion(api, organizationSlug, input.deliverableId, {
        fileAssetId: input.fileAssetId,
        note: input.note,
      }),
    onSuccess: (_version, input) => {
      setProblem(undefined);
      void queries.invalidateQueries({
        queryKey: ['deliverable', organizationSlug, input.deliverableId],
      });
    },
    onError: (error) => setProblem(describe(error, ta)),
  });

  async function uploadVersion(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || versionTarget === null) return;
    const target = versionTarget;
    try {
      // FIX6 item 1: the file is used once its checks pass, and removed again if refused.
      await uploadProjectFileFor(
        api,
        organizationSlug,
        { projectId: item.projectId, file },
        async (fileAssetId) => {
          if (target.kind === 'deliverable') {
            await addVersion.mutateAsync({ deliverableId: target.id, fileAssetId, note: null });
          } else {
            await addPlainVersion.mutateAsync({ rootFileAssetId: target.id, fileAssetId });
          }
        },
      );
    } catch (error) {
      setProblem(describe(error, ta));
    }
  }

  const nameOf = (userId: string) => memberDisplayName(userId, members.members, members.isPending);

  return (
    // The page's Files section owns the heading; this is its body (no second "Files" landmark).
    <div
      className="tm-wk-card"
      onDragOver={(event) => {
        if (!noStorage && event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (noStorage || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        attachFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="tm-wk-card__head">
        {noStorage ? null : (
          <>
            <button
              type="button"
              className="tm-wk-pill-button"
              data-tone="outline"
              onClick={() => picker.current?.click()}
            >
              {ta('WorkDetail.attachFile')}
            </button>
            <HelpTip tip={ta('CloudImport.tip')}>
              <span className="tm-row tm-row--wrap">
                <DriveAttachPicker
                  organizationSlug={organizationSlug}
                  client={api}
                  picked={[]}
                  onPick={(picked) => attachFromDrive.mutate(picked)}
                  onRemove={() => undefined}
                  projectId={item.projectId}
                  disabled={attachFromDrive.isPending}
                />
                <OneDriveAttachPicker
                  organizationSlug={organizationSlug}
                  client={api}
                  picked={[]}
                  onPick={(picked) => attachFromOneDrive.mutate(picked)}
                  onRemove={() => undefined}
                  projectId={item.projectId}
                  disabled={attachFromOneDrive.isPending}
                  showList={false}
                />
              </span>
            </HelpTip>
          </>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            event.target.value = '';
            attachFiles(picked);
          }}
        />
        <input
          ref={versionPicker}
          type="file"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => void uploadVersion(event)}
        />
      </div>

      {noStorage ? (
        <NoStorageAttach organizationSlug={organizationSlug} client={api} state={attachState} />
      ) : null}
      {problem ? (
        <InlineAlert tone="danger" title={ta('WorkDetail.fileProblem')} live>
          {problem}
        </InlineAlert>
      ) : null}
      {loading ? <Skeleton height="var(--row)" /> : null}
      {failed ? <p className="tm-field__hint">{ta('WorkDetail.filesError')}</p> : null}
      {!loading &&
      !failed &&
      !noStorage &&
      files.length === 0 &&
      uploads.rows.length === 0 &&
      driveRows.length === 0 &&
      oneDriveRows.length === 0 ? (
        <p className="tm-field__hint">{ta('WorkDetail.noFiles')}</p>
      ) : null}

      <ul className="tm-wk-files">
        {uploads.rows.map((row) => (
          <UploadProgressItem
            key={row.id}
            row={row}
            onCancel={uploads.cancel}
            onRetry={uploads.retry}
            onRemove={(done) => void removeUpload(done)}
            removableWhenDone
          />
        ))}
        {files
          .filter((file) => !justUploaded.has(file.id))
          .map((file) => {
            const backing = backingOf(file);
            const latest = backing ? latestOf(backing) : undefined;
            const plain = backing ? [] : plainHistoryOf(file);
            const plainLatest = plain.length > 1 ? plain[0] : undefined;
            const servedAsset = latest?.fileAssetId ?? plainLatest?.fileAssetId ?? file.fileAssetId;
            const availability = plainLatest?.availability ?? file.availability;
            const history = backing
              ? [...backing.versions].sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))
              : [];
            return (
              <li key={file.id} className="tm-wk-file" data-backed={backing !== undefined}>
                <div
                  className={
                    availability === 'scanning' ? 'tm-wk-file__row tm-scan-row' : 'tm-wk-file__row'
                  }
                >
                  <span className="tm-wk-badge">{fileKind(file.fileName)}</span>
                  <span className="tm-wk-file__text">
                    <span className="tm-wk-file__name">{file.fileName}</span>
                    <span className="tm-wk-file__meta">
                      {latest
                        ? ta('WorkDetail.versionUpdated', {
                            n: latest.versionNo ?? 1,
                            day: formatShortDay(dayOf(latest.createdAt), locale),
                            name: nameOf(latest.createdByUserId),
                          })
                        : plainLatest
                          ? ta('WorkDetail.versionUpdated', {
                              n: plainLatest.versionNo,
                              day: formatShortDay(dayOf(plainLatest.createdAt), locale),
                              name: nameOf(plainLatest.createdByUserId),
                            })
                          : ta('WorkDetail.versionOn', {
                              n: 1,
                              day: formatShortDay(dayOf(file.createdAt), locale),
                            })}
                    </span>
                  </span>
                  {availability !== 'unavailable' ? (
                    // V-54: the work item's Files tab opens the viewer with "Review".
                    <Link
                      className="tm-wk-text-button"
                      href={`/${organizationSlug}/files/${encodeURIComponent(servedAsset)}`}
                      aria-label={`${file.fileName} · ${ta('WorkDetail.review')}`}
                    >
                      {ta('WorkDetail.review')}
                    </Link>
                  ) : null}
                  {availability === 'ready' ? (
                    <a
                      className="tm-wk-text-button"
                      href={href(servedAsset)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {ta('WorkDetail.download')}
                    </a>
                  ) : availability === 'scanning' ? (
                    <NotScannedDownload href={href(servedAsset)} fileName={file.fileName} />
                  ) : (
                    <span className="tm-wk-file__meta" role="status">
                      {ta('WorkDetail.unavailable')}
                    </span>
                  )}
                </div>

                {backing ? (
                  <>
                    <div className="tm-wk-history">
                      <p className="tm-wk-history__title">{ta('WorkDetail.versionHistory')}</p>
                      <ul>
                        {history.map((version, index) => (
                          <li key={version.id} data-current={index === 0}>
                            <span>
                              {index === 0
                                ? ta('WorkDetail.versionCurrent', { n: version.versionNo ?? 1 })
                                : ta('WorkDetail.versionBy', {
                                    n: version.versionNo ?? 1,
                                    name: nameOf(version.createdByUserId),
                                  })}
                            </span>
                            {index === 0 ? (
                              <span>{formatShortDay(dayOf(version.createdAt), locale)}</span>
                            ) : version.fileAssetId !== null ? (
                              <button
                                type="button"
                                className="tm-wk-text-button"
                                disabled={addVersion.isPending}
                                onClick={() =>
                                  addVersion.mutate({
                                    deliverableId: backing.id,
                                    fileAssetId: version.fileAssetId as string,
                                    note: ta('WorkDetail.restoredNote', {
                                      n: version.versionNo ?? 1,
                                    }),
                                  })
                                }
                              >
                                {ta('WorkDetail.restore')}
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <button
                      type="button"
                      className="tm-wk-pill-button"
                      data-tone="outline"
                      disabled={addVersion.isPending}
                      onClick={() => {
                        setVersionTarget({ kind: 'deliverable', id: backing.id });
                        versionPicker.current?.click();
                      }}
                    >
                      {ta('WorkDetail.uploadVersion')}
                    </button>
                  </>
                ) : (
                  <>
                    {plain.length > 1 ? (
                      <div className="tm-wk-history">
                        <p className="tm-wk-history__title">{ta('WorkDetail.versionHistory')}</p>
                        <ul>
                          {plain.map((version) => (
                            <li key={version.fileAssetId} data-current={version.current}>
                              <span>
                                {version.current
                                  ? ta('WorkDetail.versionCurrent', { n: version.versionNo })
                                  : ta('WorkDetail.versionBy', {
                                      n: version.versionNo,
                                      name: nameOf(version.createdByUserId),
                                    })}
                              </span>
                              {version.current ? (
                                <span>{formatShortDay(dayOf(version.createdAt), locale)}</span>
                              ) : version.availability === 'ready' ? (
                                <a
                                  className="tm-wk-text-button"
                                  href={href(version.fileAssetId)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {ta('WorkDetail.download')}
                                </a>
                              ) : version.availability === 'scanning' ? (
                                <NotScannedDownload
                                  href={href(version.fileAssetId)}
                                  fileName={version.fileName}
                                />
                              ) : (
                                <span role="status">{ta('WorkDetail.unavailable')}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="tm-wk-pill-button"
                      data-tone="outline"
                      disabled={addPlainVersion.isPending}
                      onClick={() => {
                        setVersionTarget({ kind: 'plain', id: file.fileAssetId });
                        versionPicker.current?.click();
                      }}
                    >
                      {ta('WorkDetail.uploadVersion')}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        {driveRows
          .filter((drive) => !justUploaded.has(drive.id))
          .map((drive) => (
            <li key={drive.id} className="tm-wk-file" data-backed={false}>
              <div className="tm-wk-file__row">
                <span className="tm-wk-badge">{fileKind(drive.name)}</span>
                <span className="tm-wk-file__text">
                  <span className="tm-wk-file__name">{drive.name}</span>
                  <span className="tm-wk-file__meta">
                    {ta('WorkDetail.versionOn', {
                      n: 1,
                      day: formatShortDay(dayOf(drive.createdAt), locale),
                    })}
                  </span>
                </span>
                {drive.webViewLink ? (
                  <a
                    className="tm-wk-text-button"
                    href={drive.webViewLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {ta('WorkDetail.download')}
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        {oneDriveRows
          .filter((file) => !justUploaded.has(file.id))
          .map((file) => (
            <li key={file.id} className="tm-wk-file" data-backed={false}>
              <div className="tm-wk-file__row">
                <span className="tm-wk-badge">{fileKind(file.name)}</span>
                <span className="tm-wk-file__text">
                  <span className="tm-wk-file__name">{file.name}</span>
                  <span className="tm-wk-file__meta">
                    {ta('WorkDetail.versionOn', {
                      n: 1,
                      day: formatShortDay(dayOf(file.createdAt), locale),
                    })}
                  </span>
                </span>
                {file.webUrl ? (
                  <a
                    className="tm-wk-text-button"
                    href={file.webUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {ta('WorkDetail.download')}
                  </a>
                ) : null}
              </div>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * The rest of the lifecycle — block, review, reopen, archive — for the moves "Mark done" does
 * not make. It asks `workItemStateMachine` which states are reachable and what this move
 * requires, and renders exactly that; the server validates the same facts.
 */
function MovePanel({
  item,
  api,
  organizationSlug,
  onMoved,
  onError,
}: {
  item: WorkItemSummary;
  api: ApiClient;
  organizationSlug: string;
  onMoved: (next: WorkItemSummary) => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const [target, setTarget] = useState<WorkItemState | ''>('');
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [memberSearch, setMemberSearch] = useState('');
  const directory = useMembers(api, organizationSlug, memberSearch);
  const reachable = workItemStateMachine.allowedFrom(item.state);
  const required = target === '' ? [] : workItemStateMachine.requirementsFor(item.state, target);
  const optional = target === '' ? [] : workItemStateMachine.optionalFor(item.state, target);

  const move = useMutation({
    mutationFn: (to: WorkItemState) => {
      const wire: Record<string, string> = {};
      for (const [key, value] of Object.entries(facts)) {
        if (optional.includes(key) && value.trim() === '') continue;
        wire[key] =
          key === 'completedAt' && !Number.isNaN(new Date(value).getTime())
            ? new Date(value).toISOString()
            : value;
      }
      // 53-16: offline the status change is queued against this version and replayed later.
      return transitionOrQueue(api, organizationSlug, item, { to, facts: wire });
    },
    onSuccess: (next) => {
      onMoved(next);
      setTarget('');
      setFacts({});
    },
    onError,
  });

  function renderFact(fact: string, isRequired: boolean) {
    if (MEMBER_FACTS.includes(fact)) {
      return (
        <MemberSelect
          key={fact}
          label={FACT_LABEL[fact] ?? fact}
          name={fact}
          members={directory.members}
          value={facts[fact] ?? ''}
          onChange={(userId) => setFacts({ ...facts, [fact]: userId })}
          onSearchChange={setMemberSearch}
          loading={directory.isPending}
          failed={directory.isError}
          {...(isRequired ? { required: true } : {})}
        />
      );
    }
    return (
      <Field
        key={fact}
        label={FACT_LABEL[fact] ?? fact}
        name={fact}
        type={fact === 'completedAt' ? 'datetime-local' : 'text'}
        value={facts[fact] ?? ''}
        onChange={(event) => setFacts({ ...facts, [fact]: event.target.value })}
        {...(isRequired ? { required: true } : {})}
      />
    );
  }

  const completed =
    item.completedAt === null ? null : (
      <dl className="tm-wk-facts-line">
        <dt>{t('WorkItemDetailScreen.completed')}</dt>
        <dd>{formatDay(item.completedAt)}</dd>
      </dl>
    );

  if (reachable.length === 0) {
    return (
      <section className="tm-wk-card" aria-labelledby="tm-work-transition">
        <h2 id="tm-work-transition" className="tm-wk-card__title">
          {t('WorkItemDetailScreen.moveThisItem')}
        </h2>
        {completed}
        <p className="tm-wk-card__prose">
          {t(STATE_KEY[item.state])} {t('WorkItemDetailScreen.endOfLifecycle')}
        </p>
      </section>
    );
  }

  return (
    <section className="tm-wk-card" aria-labelledby="tm-work-transition">
      <h2 id="tm-work-transition" className="tm-wk-card__title">
        {t('WorkItemDetailScreen.moveThisItem')}
      </h2>
      {completed}
      <form
        className="tm-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (target !== '') move.mutate(target);
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-work-target">
            {t('WorkItemDetailScreen.moveTo')}
          </label>
          <select
            id="tm-work-target"
            className="tm-field__control"
            value={target}
            onChange={(event) => {
              const next = event.target.value as WorkItemState | '';
              setTarget(next);
              const needs =
                next === '' ? [] : workItemStateMachine.requirementsFor(item.state, next);
              const seeded: Record<string, string> = {};
              if (needs.includes('ownerId') && item.ownerUserId !== null) {
                seeded['ownerId'] = item.ownerUserId;
              }
              if (needs.includes('completedAt')) {
                seeded['completedAt'] = toLocalControlValue(new Date());
              }
              setFacts(seeded);
            }}
          >
            <option value="">{t('WorkItemDetailScreen.chooseState')}</option>
            {reachable.map((state) => (
              <option key={state} value={state}>
                {t(STATE_KEY[state])}
              </option>
            ))}
          </select>
        </div>
        {required.map((fact) => renderFact(fact, true))}
        {optional.map((fact) => renderFact(fact, false))}
        {target !== '' && required.length === 0 && optional.length === 0 ? (
          <p className="tm-wk-card__prose">{t('WorkItemDetailScreen.needsNothing')}</p>
        ) : null}
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={move.isPending}
            loadingLabel={t('WorkItemDetailScreen.moving')}
            disabled={target === ''}
          >
            {t('WorkItemDetailScreen.moveToPrefix')}{' '}
            {target === '' ? t('WorkItemDetailScreen.chosenState') : t(STATE_KEY[target])}
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * Who can see this item. Widening is confirmed and narrowing is not: audience is the control
 * that decides what a client can ever see, and widening is the direction that discloses.
 *
 * R36 F1: the client companies to tag show for every client-facing audience (one company
 * included) and already in the confirm, so the item is published only to the ones ticked. A
 * project with no client says so, with the way to add one, and "Client action needed" — which
 * the API refuses there — is not offered. A refusal is shown in this card, beside the button.
 */
function AudiencePanel({
  item,
  api,
  organizationSlug,
  projectClients,
  clientsLoaded,
  tickedClients,
  onChanged,
  onError,
}: {
  item: WorkItemSummary;
  api: ApiClient;
  organizationSlug: string;
  /** C25: the project's client companies. */
  projectClients: readonly ProjectClientChoice[];
  /** R36 F1: the project's clients have been read, so "no client yet" is the truth. */
  clientsLoaded: boolean;
  tickedClients: readonly string[];
  onChanged: (next: WorkItemSummary) => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<WorkItemAudience | undefined>(undefined);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  function failed(error: unknown) {
    // A version conflict reloads the item, as every other write on this screen does.
    if (error instanceof ApiRequestError && error.status === 409) {
      setFailure(undefined);
      onError(error);
      return;
    }
    setFailure(audienceFailureMessage(error, t('WorkItemDetailScreen.audienceFailed')));
  }

  const change = useMutation({
    mutationFn: (audience: WorkItemAudience) =>
      updateWorkItem(
        api,
        organizationSlug,
        item.id,
        widenRequest(item.version, audience, chosen, projectClients.length),
      ),
    onSuccess: (next) => {
      onChanged(next);
      setPending(undefined);
      setFailure(undefined);
      void queryClient.invalidateQueries({
        queryKey: ['work-item-client-audience', organizationSlug, item.id],
      });
    },
    onError: failed,
  });
  const clients = useMutation({
    mutationFn: (clientOrganizationIds: readonly string[]) =>
      updateWorkItem(api, organizationSlug, item.id, {
        version: item.version,
        clientOrganizationIds,
      }),
    onSuccess: (next) => {
      onChanged(next);
      setFailure(undefined);
      void queryClient.invalidateQueries({
        queryKey: ['work-item-client-audience', organizationSlug, item.id],
      });
    },
    onError: failed,
  });

  const mode = clientPickerMode(item.audience, pending, clientsLoaded, projectClients.length);
  // In the confirm the boxes are a draft sent with the audience; otherwise each tick saves.
  const ticked = pending !== undefined ? chosen : tickedClients;
  const mayConfirm =
    pending !== undefined && mayConfirmAudience(pending, projectClients.length, chosen.length);

  return (
    <section className="tm-wk-card" aria-labelledby="tm-work-audience">
      <h2 id="tm-work-audience" className="tm-wk-card__title">
        {t('WorkItemDetailScreen.whoCanSee')}
      </h2>
      <div className="tm-row tm-row--wrap">
        {(['internal', 'client_visible', 'client_action_required'] as const).map((audience) => (
          <Button
            key={audience}
            tone={audience === item.audience ? 'ink' : 'outline'}
            size="accessible"
            disabled={audience === item.audience || change.isPending}
            onClick={() => {
              setFailure(undefined);
              if (audience === 'internal') {
                setPending(undefined);
                change.mutate(audience);
              } else {
                // Default: every client the item can already reach (all of them when internal).
                setChosen(
                  item.audience === 'internal'
                    ? projectClients.map((client) => client.id)
                    : tickedClients,
                );
                setPending(audience);
              }
            }}
          >
            {audienceLabel(audience)}
          </Button>
        ))}
      </div>
      {mode === 'picker' ? (
        <fieldset className="tm-wk-clients" data-testid="work-item-client-picker">
          <legend className="tm-wk-clients__label">{t('WorkItemDetailScreen.whichClients')}</legend>
          {projectClients.map((client) => {
            const checked = ticked.includes(client.id);
            const next = checked ? ticked.filter((id) => id !== client.id) : [...ticked, client.id];
            return (
              <Checkbox
                key={client.id}
                label={client.name}
                checked={checked}
                disabled={clients.isPending || change.isPending || (checked && ticked.length === 1)}
                onChange={() => {
                  if (pending !== undefined) setChosen(next);
                  else clients.mutate(next);
                }}
              />
            );
          })}
          <p className="tm-wk-facts__note">{t('WorkItemDetailScreen.atLeastOneClient')}</p>
        </fieldset>
      ) : null}
      {mode === 'no-client' ? (
        <p className="tm-wk-facts__note" data-testid="work-item-no-client">
          {pending === 'client_action_required'
            ? t('WorkItemDetailScreen.noClientForAction')
            : t('WorkItemDetailScreen.noClientYet')}{' '}
          <Link href={`/${organizationSlug}/projects/${item.projectId}/members`}>
            {t('WorkItemDetailScreen.addClientToProject')}
          </Link>
        </p>
      ) : null}
      {pending !== undefined ? (
        <InlineAlert tone="client" title={t('WorkItemDetailScreen.showToClientTitle')} live>
          <p className="tm-prose">
            “{item.title}” {t('WorkItemDetailScreen.becomes')}{' '}
            {audienceLabel(pending).toLowerCase()} {t('WorkItemDetailScreen.inClientPortal')}
          </p>
          <div className="tm-row">
            {mayConfirm ? (
              <Button
                tone="ink"
                size="accessible"
                loading={change.isPending}
                loadingLabel={t('WorkItemDetailScreen.publishing')}
                onClick={() => {
                  setFailure(undefined);
                  change.mutate(pending);
                }}
              >
                {t('WorkItemDetailScreen.showToClient')}
              </Button>
            ) : null}
            <Button
              tone="outline"
              size="accessible"
              onClick={() => {
                setPending(undefined);
                setFailure(undefined);
              }}
            >
              {t('WorkItemDetailScreen.keepInternal')}
            </Button>
          </div>
        </InlineAlert>
      ) : null}
      {failure !== undefined ? (
        <InlineAlert tone="danger" title={t('WorkItemDetailScreen.failureTitle')} live>
          {failure}
        </InlineAlert>
      ) : null}
    </section>
  );
}
