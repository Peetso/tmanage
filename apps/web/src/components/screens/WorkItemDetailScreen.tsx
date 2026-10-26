'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { workItemStateMachine } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { MemberSelect } from '../MemberSelect';
import './work-core.css';
import { WorkCommentsPanel } from './WorkCommentsPanel';
import { NotScannedDownload } from './NotScannedDownload';
import { WorkChecklistPanel } from './WorkChecklistPanel';
import { SendForApprovalDialog } from './SendForApprovalDialog';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import {
  deleteWorkItem,
  detachWorkItemFile,
  duplicateWorkItem,
  getWorkItem,
  listWorkItemFiles,
  transitionWorkItem,
  updateWorkItem,
} from '../../lib/api/work-items';
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
  uploadDestination,
  uploadProjectFile,
  uploadWorkItemAttachment,
} from '../../lib/api/uploads';
import { UploadProgressItem, useUploadQueue } from '../storage/UploadProgress';
import type { UploadRow } from '../../lib/upload-queue';
import { getStorageStatus, listDriveAttachments } from '../../lib/api/google-drive';
import {
  attachOneDriveFile,
  getOneDriveStatus,
  listOneDriveAttachments,
} from '../../lib/api/onedrive';
import type { PickedOneDriveItem } from '../../lib/onedrive-picker';
import { OneDriveAttachPicker, oneDriveStatusKey } from '../storage/OneDriveAttachPicker';
import { addAttachmentVersion, getAttachmentHistory } from '../../lib/api/attachment-versions';
import type { AttachmentVersion } from '../../lib/api/attachment-versions';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { workItemKeys } from '../../lib/query-keys';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { useRecordRecentItem } from '../../lib/use-record-recent-item';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import {
  audienceLabel,
  dayToInstant,
  formatDay,
  stateCapsule,
} from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { dayOf, DueDatePicker, formatChipDay, formatShortDay, useA6T } from '../work/DueDatePicker';
import { initialsOf, OwnerPickerDialog, useOwnerCandidates } from '../work/OwnerPickerDialog';
import { EditWorkItemDialog, type WorkItemChanges } from '../work/EditWorkItemDialog';
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

  const item = useQuery({
    queryKey: ['work-item', organizationSlug, workItemId],
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
              <span aria-hidden="true"> / </span>
            </>
          ) : null}
          <Link href={`/${organizationSlug}/work`}>{ta('WorkDetail.work')}</Link>
        </span>
      }
      title={item.data?.title ?? t('WorkItemDetailScreen.fallbackTitle')}
      actions={
        item.data ? (
          <HeaderActions
            item={item.data}
            onAction={(action) =>
              window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: action }))
            }
          />
        ) : undefined
      }
    >
      {item.isPending ? (
        <LoadingRegion label={t('WorkItemDetailScreen.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {item.isError ? (
        <InlineAlert tone="danger" title={t('WorkItemDetailScreen.loadError')} live>
          {item.error instanceof ApiRequestError
            ? item.error.message
            : item.error instanceof NetworkError
              ? t('WorkItemDetailScreen.networkError')
              : t('WorkItemDetailScreen.genericError')}
        </InlineAlert>
      ) : null}

      {item.data ? (
        <WorkItemBody
          item={item.data}
          api={api}
          organizationSlug={organizationSlug}
          projects={projects.data ?? []}
          projectName={projectName}
          {...(now === undefined ? {} : { now })}
          onChanged={(next) => {
            queries.setQueryData(['work-item', organizationSlug, workItemId], next);
            void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
          }}
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

function HeaderActions({
  item,
  onAction,
}: {
  item: WorkItemSummary;
  onAction: (action: HeaderAction) => void;
}) {
  const ta = useA6T();
  const canFinish = pathToDone(item.state) !== null;
  return (
    <div className="tm-wk-head-actions">
      <WorkItemActionsMenu itemTitle={item.title} onAction={onAction} />
      <button type="button" className="tm-wk-text-button" onClick={() => onAction('delete')}>
        {ta('WorkDetail.delete')}
      </button>
      <button
        type="button"
        className="tm-wk-pill-button"
        data-tone="outline"
        onClick={() => onAction('edit')}
      >
        {ta('WorkDetail.edit')}
      </button>
      {canFinish ? (
        <button
          type="button"
          className="tm-wk-pill-button"
          data-tone="ink"
          onClick={() => onAction('done')}
        >
          {ta('WorkDetail.markDone')}
        </button>
      ) : null}
    </div>
  );
}

interface WorkItemBodyProps {
  item: WorkItemSummary;
  api: ApiClient;
  organizationSlug: string;
  projects: readonly { readonly id: string; readonly name: string }[];
  projectName: string;
  now?: Date;
  onChanged: (next: WorkItemSummary) => void;
  onConflict: () => void;
  onDeleted: () => void;
  onOpenItem: (workItemId: string) => void;
}

type Overlay =
  | { kind: 'edit'; focusProject: boolean }
  | { kind: 'owner' }
  | { kind: 'due' }
  | { kind: 'start' }
  | { kind: 'delete' }
  | { kind: 'approval' }
  | null;

type Tab = 'details' | 'files' | 'activity';

function WorkItemBody({
  item,
  api,
  organizationSlug,
  projects,
  projectName,
  now,
  onChanged,
  onConflict,
  onDeleted,
  onOpenItem,
}: WorkItemBodyProps) {
  const t = useT();
  const ta = useA6T();
  const locale = useActiveLocale();
  const queries = useQueryClient();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);

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

  // The client of this project, for "<Client> can see this item" and the delete note.
  const shares = useQuery({
    queryKey: ['project-shares', organizationSlug, item.projectId],
    queryFn: () => listProjectShares(api, organizationSlug, item.projectId),
    enabled: item.audience !== 'internal' || overlay?.kind === 'edit',
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
    if (error instanceof ApiRequestError && error.status === 409) {
      if (error.fieldErrors().has('version')) {
        setConflict(true);
        setFailure(undefined);
        setOverlay(null);
        onConflict();
        return;
      }
      setConflict(false);
      setFailure(error.message);
      return;
    }
    setFailure(describe(error, ta));
  }

  /** Every edit is one PATCH with the version this screen read. */
  const edit = useMutation({
    mutationFn: (input: WorkItemChanges) =>
      updateWorkItem(api, organizationSlug, item.id, {
        ...input,
        version: item.version,
      } satisfies UpdateWorkItemInput),
    onSuccess: (next) => {
      onChanged(next);
      setOverlay(null);
      setFieldErrors(new Map());
      setFailure(undefined);
      setConflict(false);
    },
    onError: (error) => {
      if (
        error instanceof ApiRequestError &&
        (error.status === 400 || error.status === 422) &&
        error.fieldErrors().size > 0
      ) {
        setFieldErrors(error.fieldErrors());
        setFailure(overlay?.kind === 'edit' ? undefined : error.message);
        return;
      }
      setOverlay(null);
      handleWriteError(error);
    },
  });

  const finish = useMutation({
    mutationFn: async () => {
      const path = pathToDone(item.state) ?? [];
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

  const remove = useMutation({
    mutationFn: () => deleteWorkItem(api, organizationSlug, item.id),
    onSuccess: () => onDeleted(),
    onError: (error) => {
      setOverlay(null);
      setFailure(describe(error, ta));
    },
  });

  function act(action: HeaderAction) {
    setFieldErrors(new Map());
    if (action === 'edit') setOverlay({ kind: 'edit', focusProject: false });
    else if (action === 'move') setOverlay({ kind: 'edit', focusProject: true });
    else if (action === 'owner') setOverlay({ kind: 'owner' });
    else if (action === 'dates') setOverlay({ kind: 'due' });
    else if (action === 'duplicate') duplicate.mutate();
    else if (action === 'delete') setOverlay({ kind: 'delete' });
    else if (action === 'done') {
      if (item.ownerUserId === null) {
        setFailure(ta('WorkDetail.ownerFirst'));
        setOverlay({ kind: 'owner' });
      } else {
        finish.mutate();
      }
    }
  }

  // The header's buttons are rendered by the shell; their presses arrive as a window event.
  useWindowEvent(ACTION_EVENT, (event) => act((event as CustomEvent<HeaderAction>).detail));

  // "Unassigned" when nobody owns it — the directory's own word (D16).
  const ownerName = memberDisplayName(item.ownerUserId, directory.members, directory.isPending);
  const fileCount = attached.length;
  const activityCount = activity.data?.length ?? 0;

  return (
    <div className="tm-wk-detail">
      <div className="tm-wk-detail__pills" data-testid="work-item-status">
        <span className="tm-wk-pill" data-state={stateCapsule(item.state)}>
          <span className="tm-wk-pill__dot" aria-hidden="true" />
          {t(STATE_KEY[item.state])}
        </span>
        {item.audience !== 'internal' ? (
          <span className="tm-wk-pill" data-tone="client">
            {item.audience === 'client_action_required'
              ? ta('WorkDetail.clientAction')
              : ta('WorkDetail.clientCanSee')}
          </span>
        ) : null}
      </div>

      <div className="tm-wk-fact-chips" role="group" aria-label={ta('WorkDetail.factsLabel')}>
        <button
          type="button"
          className="tm-wk-fact"
          aria-haspopup="dialog"
          onClick={() => act('owner')}
        >
          {item.ownerUserId !== null ? (
            <span className="tm-wk-orb" aria-hidden="true">
              {initialsOf(ownerName)}
            </span>
          ) : null}
          <span className="tm-wk-fact__text">
            <span className="tm-wk-fact__label">{ta('WorkDetail.owner')}</span>
            <span className="tm-wk-fact__value">{ownerName}</span>
          </span>
          <span className="tm-wk-fact__caret" aria-hidden="true">
            ▾
          </span>
        </button>

        <DateChip
          label={ta('WorkDetail.start')}
          heading={ta('DueDatePicker.startHeading')}
          value={dayOf(item.startAt)}
          open={overlay?.kind === 'start'}
          {...(now === undefined ? {} : { now })}
          onOpen={() => setOverlay(overlay?.kind === 'start' ? null : { kind: 'start' })}
          onClose={() => setOverlay(null)}
          onSet={(day) => edit.mutate({ startAt: day === null ? null : dayToInstant(day) })}
        />
        <DateChip
          label={ta('WorkDetail.due')}
          heading={ta('DueDatePicker.dueHeading')}
          value={dayOf(item.dueAt)}
          min={dayOf(item.startAt)}
          open={overlay?.kind === 'due'}
          {...(now === undefined ? {} : { now })}
          onOpen={() => setOverlay(overlay?.kind === 'due' ? null : { kind: 'due' })}
          onClose={() => setOverlay(null)}
          onSet={(day) => edit.mutate({ dueAt: day === null ? null : dayToInstant(day) })}
        />

        {firstBacking && reviewVersion ? (
          <button
            type="button"
            className="tm-wk-fact"
            aria-haspopup="dialog"
            onClick={() => setOverlay({ kind: 'approval' })}
          >
            {reviewerName ? (
              <span className="tm-wk-orb" aria-hidden="true">
                {initialsOf(reviewerName)}
              </span>
            ) : null}
            <span className="tm-wk-fact__text">
              <span className="tm-wk-fact__label">{ta('WorkDetail.reviewer')}</span>
              <span className="tm-wk-fact__value">
                {reviewerName ?? ta('WorkDetail.sendForApproval')}
              </span>
            </span>
            <span className="tm-wk-fact__caret" aria-hidden="true">
              ▾
            </span>
          </button>
        ) : null}
      </div>
      {fieldErrors.size > 0 && overlay?.kind !== 'edit' ? (
        <p className="tm-field__error" role="alert">
          {[...fieldErrors.values()].join(' ')}
        </p>
      ) : null}

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

      <div className="tm-wk-tabs" role="tablist" aria-label={ta('WorkDetail.tabsLabel')}>
        {(
          [
            ['details', ta('WorkDetail.tabDetails'), undefined],
            ['files', ta('WorkDetail.tabFiles'), fileCount],
            ['activity', ta('WorkDetail.tabActivity'), activityCount],
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
            {count === undefined ? null : <span className="tm-wk-count">{count}</span>}
          </button>
        ))}
      </div>

      {tab === 'details' ? (
        <div
          className="tm-wk-detail__grid"
          role="tabpanel"
          id="tm-wk-panel-details"
          aria-labelledby="tm-wk-tab-details"
        >
          <div className="tm-wk-detail__stack">
            <DescriptionCard item={item} api={api} organizationSlug={organizationSlug} />
            <MovePanel
              item={item}
              api={api}
              organizationSlug={organizationSlug}
              onMoved={onChanged}
              onError={handleWriteError}
            />
            <AudiencePanel
              item={item}
              api={api}
              organizationSlug={organizationSlug}
              onChanged={onChanged}
              onError={handleWriteError}
            />
            <WorkCommentsPanel organizationSlug={organizationSlug} workItemId={item.id} api={api} />
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
        </div>
      ) : null}

      {tab === 'files' ? (
        <div role="tabpanel" id="tm-wk-panel-files" aria-labelledby="tm-wk-tab-files">
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
        </div>
      ) : null}

      {tab === 'activity' ? (
        <div
          className="tm-wk-detail__stack"
          role="tabpanel"
          id="tm-wk-panel-activity"
          aria-labelledby="tm-wk-tab-activity"
        >
          <section className="tm-wk-card" aria-labelledby="tm-wk-activity-heading">
            <h2 id="tm-wk-activity-heading" className="tm-wk-card__title">
              {ta('WorkDetail.tabActivity')}
            </h2>
            {activity.isPending ? <Skeleton height="var(--row)" /> : null}
            {activity.isError ? (
              <p className="tm-field__hint">{ta('WorkDetail.activityError')}</p>
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
          </section>
        </div>
      ) : null}

      {overlay?.kind === 'edit' ? (
        <EditWorkItemDialog
          api={api}
          organizationSlug={organizationSlug}
          item={item}
          projects={projects}
          {...(clientName === undefined ? {} : { clientName })}
          focusProject={overlay.focusProject}
          saving={edit.isPending}
          fieldErrors={fieldErrors}
          onSave={(changes) => edit.mutate(changes)}
          onClose={() => setOverlay(null)}
        />
      ) : null}

      {overlay?.kind === 'owner' ? (
        <OwnerPickerDialog
          projectName={projectName}
          candidates={owners.candidates}
          loading={owners.loading}
          value={item.ownerUserId}
          saving={edit.isPending}
          onAssign={(userId) => {
            if (userId === item.ownerUserId) setOverlay(null);
            else edit.mutate({ ownerUserId: userId });
          }}
          onClose={() => setOverlay(null)}
        />
      ) : null}

      {overlay?.kind === 'delete' ? (
        <DeleteWorkItemDialog
          title={item.title}
          fileCount={fileCount}
          clientVisible={item.audience !== 'internal'}
          {...(clientName === undefined ? {} : { clientName })}
          deleting={remove.isPending}
          onConfirm={() => remove.mutate()}
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

function DateChip({
  label,
  heading,
  value,
  min,
  open,
  now,
  onOpen,
  onClose,
  onSet,
}: {
  label: string;
  heading: string;
  value: string;
  min?: string;
  open: boolean;
  now?: Date;
  onOpen: () => void;
  onClose: () => void;
  onSet: (day: string | null) => void;
}) {
  const ta = useA6T();
  const locale = useActiveLocale();
  return (
    <div className="tm-wk-popover-anchor">
      <button
        type="button"
        className="tm-wk-fact"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onOpen}
      >
        <span className="tm-wk-fact__text">
          <span className="tm-wk-fact__label">{label}</span>
          <span className="tm-wk-fact__value">
            {value === '' ? ta('WorkDetail.noDate') : formatChipDay(value, locale)}
          </span>
        </span>
        <span className="tm-wk-fact__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <DueDatePicker
          heading={heading}
          value={value}
          {...(min === undefined || min === '' ? {} : { min })}
          {...(now === undefined ? {} : { now })}
          onSet={(day) => {
            onClose();
            if (day !== (value === '' ? null : value)) onSet(day);
          }}
          onClose={onClose}
        />
      ) : null}
    </div>
  );
}

/**
 * The Details tab's left card: the description, a rule, and the checklist. The checklist is the
 * shared `WorkChecklistPanel` (its own count, toggles and add form), drawn flat inside the card.
 */
function DescriptionCard({
  item,
  api,
  organizationSlug,
}: {
  item: WorkItemSummary;
  api: ApiClient;
  organizationSlug: string;
}) {
  const ta = useA6T();
  return (
    <section className="tm-wk-card tm-wk-description" aria-labelledby="tm-wk-description">
      <h2 id="tm-wk-description" className="tm-wk-card__title">
        {ta('WorkDetail.description')}
      </h2>
      <p className="tm-wk-card__prose" data-empty={!item.description}>
        {item.description ? item.description : ta('WorkDetail.noDescription')}
      </p>
      <hr className="tm-wk-card__rule" />
      <WorkChecklistPanel organizationSlug={organizationSlug} workItemId={item.id} api={api} />
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

  // B (wave 17). New files go where the company keeps them: Google Drive when Control > Storage
  // says so and Drive is connected, TManage storage otherwise. Drive files are listed below the
  // TManage ones in the same rows.
  const storageQuery = {
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(api, organizationSlug),
    staleTime: 60_000,
  };
  const storage = useQuery(storageQuery);
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
  const attachFromOneDrive = useMutation({
    mutationFn: async (picked: readonly PickedOneDriveItem[]) => {
      for (const file of picked) await attachOneDriveFile(api, organizationSlug, item.id, file);
    },
    onSuccess: () => setProblem(undefined),
    onError: (error) => setProblem(describe(error, ta)),
    onSettled: () => void queries.invalidateQueries({ queryKey: oneDriveKey }),
  });

  // 409:6602. Each new file is a progress row (bar, Cancel, Retry) until it is attached; a dropped
  // connection reads "Upload stopped at N %", any other refusal in the API's words.
  const filesKey = ['work-item-files', organizationSlug, item.id] as const;
  const uploads = useUploadQueue((error) =>
    error instanceof NetworkError ? null : describe(error, ta),
  );
  const attachFile = async (file: File) => {
    setProblem(undefined);
    // Read at click time, so a status still loading is not mistaken for TManage storage.
    const storageNow = await queries.fetchQuery(storageQuery).catch(() => undefined);
    const oneDriveNow = await queries.fetchQuery(oneDriveQuery).catch(() => undefined);
    await uploads.start(file, uploadDestination(storageNow, oneDriveNow), async (sent, deps) => {
      const result = await uploadWorkItemAttachment(
        api,
        organizationSlug,
        {
          workItemId: item.id,
          projectId: item.projectId,
          file: sent,
          storage: storageNow,
          oneDrive: oneDriveNow,
        },
        deps,
      );
      void queries.invalidateQueries({
        queryKey:
          result.kind === 'google_drive'
            ? driveKey
            : result.kind === 'onedrive'
              ? oneDriveKey
              : filesKey,
      });
      return result.kind === 'tmanage' ? result.file.id : result.attachment.id;
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
    try {
      const fileAssetId = await uploadProjectFile(api, organizationSlug, {
        projectId: item.projectId,
        file,
      });
      if (versionTarget.kind === 'deliverable') {
        addVersion.mutate({ deliverableId: versionTarget.id, fileAssetId, note: null });
      } else {
        addPlainVersion.mutate({ rootFileAssetId: versionTarget.id, fileAssetId });
      }
    } catch (error) {
      setProblem(describe(error, ta));
    }
  }

  const nameOf = (userId: string) => memberDisplayName(userId, members.members, members.isPending);

  return (
    <section className="tm-wk-card" aria-labelledby="tm-wk-files">
      <div className="tm-wk-card__head">
        <h2 id="tm-wk-files" className="tm-wk-card__title">
          {ta('WorkDetail.files')}
        </h2>
        <button
          type="button"
          className="tm-wk-pill-button"
          data-tone="outline"
          onClick={() => picker.current?.click()}
        >
          {ta('WorkDetail.attachFile')}
        </button>
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
        <input
          ref={picker}
          type="file"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void attachFile(file);
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

      {problem ? (
        <InlineAlert tone="danger" title={ta('WorkDetail.fileProblem')} live>
          {problem}
        </InlineAlert>
      ) : null}
      {loading ? <Skeleton height="var(--row)" /> : null}
      {failed ? <p className="tm-field__hint">{ta('WorkDetail.filesError')}</p> : null}
      {!loading &&
      !failed &&
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
            removableWhenDone={row.destination === 'tmanage'}
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
    </section>
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
      return transitionWorkItem(api, organizationSlug, item.id, {
        version: item.version,
        to,
        facts: wire,
      });
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
 */
function AudiencePanel({
  item,
  api,
  organizationSlug,
  onChanged,
  onError,
}: {
  item: WorkItemSummary;
  api: ApiClient;
  organizationSlug: string;
  onChanged: (next: WorkItemSummary) => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const [pending, setPending] = useState<WorkItemAudience | undefined>(undefined);
  const change = useMutation({
    mutationFn: (audience: WorkItemAudience) =>
      updateWorkItem(api, organizationSlug, item.id, { version: item.version, audience }),
    onSuccess: (next) => {
      onChanged(next);
      setPending(undefined);
    },
    onError,
  });

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
              if (audience === 'internal') change.mutate(audience);
              else setPending(audience);
            }}
          >
            {audienceLabel(audience)}
          </Button>
        ))}
      </div>
      {pending !== undefined ? (
        <InlineAlert tone="client" title={t('WorkItemDetailScreen.showToClientTitle')} live>
          <p className="tm-prose">
            “{item.title}” {t('WorkItemDetailScreen.becomes')}{' '}
            {audienceLabel(pending).toLowerCase()} {t('WorkItemDetailScreen.inClientPortal')}
          </p>
          <div className="tm-row">
            <Button
              tone="ink"
              size="accessible"
              loading={change.isPending}
              loadingLabel={t('WorkItemDetailScreen.publishing')}
              onClick={() => change.mutate(pending)}
            >
              {t('WorkItemDetailScreen.showToClient')}
            </Button>
            <Button tone="outline" size="accessible" onClick={() => setPending(undefined)}>
              {t('WorkItemDetailScreen.keepInternal')}
            </Button>
          </div>
        </InlineAlert>
      ) : null}
    </section>
  );
}
