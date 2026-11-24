'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../../lib/api/errors';
import { listProjects } from '../../../lib/api/projects';
import { readOrganizationMe } from '../../../lib/api/permission-matrix';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { listProjectShares } from '../../../lib/api/clients';
import { listClientOrganizationOptions } from '../../../lib/api/project-client';
import {
  createWorkItem,
  setWorkItemReminder,
  type WorkItemAudience,
  type WorkItemSummary,
} from '../../../lib/api/work-items';
import {
  setWorkItemRecurrence,
  type WorkItemRecurrenceFreq,
} from '../../../lib/api/work-item-recurrence';
import { assignItemLabel, listWorkLabels } from '../../../lib/api/work-labels';
import { setWorkStageSet, type StageSetView, type StageView } from '../../../lib/api/work-stages';
import { uploadWorkItemAttachment, type UploadAttachmentOptions } from '../../../lib/api/uploads';
import { attachDriveFile } from '../../../lib/api/google-drive';
import { attachOneDriveFile } from '../../../lib/api/onedrive';
import type { PickedDriveItem } from '../../../lib/google-picker';
import type { PickedOneDriveItem } from '../../../lib/onedrive-picker';
import { workItemKeys } from '../../../lib/query-keys';
import { useUploadQueue } from '../../storage/UploadProgress';
import { useA6T } from '../DueDatePicker';
import { useOwnerCandidates } from '../OwnerPickerDialog';
import { moveToStage } from '../stages/move-to-stage';
import { currentStage } from '../stages/stage-model';
import { useProjectStageSet, useStageSets } from '../stages/use-work-stages';
import {
  buildNewWorkPayload,
  defaultSetForProject,
  firstStage,
  initialCaptureProjectId,
  stageFollowUp,
  type CaptureDraft,
} from './new-work-model';

/** What one create filed, and what could not be added to it afterwards. */
export interface NewWorkResult {
  readonly item: WorkItemSummary;
  readonly failures: readonly string[];
}

export interface UseNewWorkOptions {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly draft?: CaptureDraft;
  readonly initialProjectId?: string;
  readonly uploadOptions?: UploadAttachmentOptions;
  readonly now?: Date;
  /** After a create; `another` is "Create and add another" (the form stays, cleared). */
  readonly onCreated?: (result: NewWorkResult, another: boolean) => void;
}

/**
 * The state and the writes of one New work form (quick or full; W-WEB-3). The create itself is
 * one `POST work-items` carrying the name, people, client, dates, description and first steps
 * (W-API-1). What the API cannot take in that body (a stage set or stage, labels, a repeat, a
 * reminder, files) is written after the item exists; each failure is named afterwards and never
 * undoes the work, because the work was filed and the missing piece can be added on its page.
 */
export function useNewWork({
  api,
  organizationSlug,
  draft,
  initialProjectId,
  uploadOptions,
  now,
  onCreated,
}: UseNewWorkOptions) {
  const t = useA6T();
  const tOr = useTOr();
  const queries = useQueryClient();

  const projects = useQuery({
    queryKey: ['capture-projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const available = projects.data ?? [];

  const [title, setTitle] = useState(draft?.title ?? '');
  const [description, setDescription] = useState(draft?.note ?? '');
  const [pickedProject, setPickedProject] = useState('');
  const projectId =
    pickedProject !== '' ? pickedProject : initialCaptureProjectId(available, initialProjectId);
  const projectName = available.find((project) => project.id === projectId)?.name ?? '';

  const [doers, setDoers] = useState<readonly string[]>([]);
  const [supervisors, setSupervisors] = useState<readonly string[]>([]);
  const [watchers, setWatchers] = useState<readonly string[]>([]);
  const [clients, setClients] = useState<readonly string[]>([]);
  const [clientAudience, setClientAudience] =
    useState<Exclude<WorkItemAudience, 'internal'>>('client_visible');
  const [dueDay, setDueDay] = useState('');
  const [startDay, setStartDay] = useState('');
  const [steps, setSteps] = useState<readonly string[]>([]);
  const [labels, setLabels] = useState<ReadonlySet<string>>(new Set());
  const [repeat, setRepeat] = useState<WorkItemRecurrenceFreq | null>(null);
  const [reminder, setReminder] = useState('');
  const [files, setFiles] = useState<readonly File[]>([]);
  const [driveFiles, setDriveFiles] = useState<readonly PickedDriveItem[]>([]);
  const [oneDriveFiles, setOneDriveFiles] = useState<readonly PickedOneDriveItem[]>([]);
  const [pickedSet, setPickedSet] = useState<StageSetView | null>(null);
  const [pickedStage, setPickedStage] = useState<StageView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<NewWorkResult | null>(null);
  const another = useRef(false);

  const people = useOwnerCandidates(api, organizationSlug, projectId, { withAi: true });
  // 60-08 (S7b0/S7b): who fills Supervisor when an AI employee is chosen, and whether he may.
  const me = useQuery({
    queryKey: ['organization-me', organizationSlug],
    queryFn: () => readOrganizationMe(api, organizationSlug),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const viewerUserId = me.data?.userId ?? null;
  const aiIds = new Set(
    people.candidates
      .filter((candidate) => candidate.kind === 'ai')
      .map((candidate) => candidate.userId),
  );
  const aiDoer = doers.find((id) => aiIds.has(id)) ?? null;
  const supervisorRequired =
    aiDoer !== null && supervisors.filter((id) => !aiIds.has(id)).length === 0;
  const canAssignAi =
    me.data === undefined ? undefined : me.data.capabilities.includes('ai_employee.assign');

  /**
   * Choosing an AI employee as a doer fills an empty Supervisor with the person assigning (S7b0),
   * as the server does. When the viewer is not a person on this project there is no default and
   * Supervisor asks for a person (S7b).
   */
  function chooseDoers(next: readonly string[]) {
    setDoers(next);
    const viewerIsPerson =
      viewerUserId !== null &&
      people.candidates.some(
        (candidate) => candidate.userId === viewerUserId && candidate.kind !== 'ai',
      );
    if (next.some((id) => aiIds.has(id)) && supervisors.length === 0 && viewerIsPerson) {
      setSupervisors([viewerUserId]);
    }
  }
  const workLabels = useQuery({
    queryKey: ['capture-labels', organizationSlug],
    queryFn: () => listWorkLabels(api, organizationSlug),
  });
  const shares = useQuery({
    queryKey: ['project-shares', organizationSlug, projectId],
    queryFn: () => listProjectShares(api, organizationSlug, projectId),
    enabled: projectId !== '',
  });
  const clientOptions = useQuery({
    queryKey: ['client-organization-options', organizationSlug],
    queryFn: () => listClientOrganizationOptions(api, organizationSlug),
    enabled: (shares.data?.length ?? 0) > 0,
  });
  const projectClients = (shares.data ?? []).map((share) => ({
    id: share.clientOrganizationId,
    name:
      clientOptions.data?.find((option) => option.id === share.clientOrganizationId)?.name ?? '',
  }));

  const sets = useStageSets(api, organizationSlug);
  const projectSetQuery = useProjectStageSet(api, organizationSlug, projectId || null);
  const projectSet = projectSetQuery.data?.stageSet ?? null;
  const baseSet = defaultSetForProject(sets.data ?? [], projectSet);
  const stageSet = pickedSet ?? baseSet;
  const stage =
    pickedStage !== null && stageSet?.stages.some((entry) => entry.id === pickedStage.id)
      ? pickedStage
      : firstStage(stageSet);
  const setChoices = (sets.data ?? []).filter(
    (set) => set.projectId === null || set.projectId === projectId,
  );

  const uploads = useUploadQueue((error) =>
    error instanceof Error && !(error instanceof NetworkError) ? withFullStop(error.message) : null,
  );

  /** A new project means new people, clients and stages: the old picks do not carry over. */
  function chooseProject(next: string) {
    if (next === projectId) return;
    setPickedProject(next);
    setDoers([]);
    setSupervisors([]);
    setWatchers([]);
    setClients([]);
    setPickedSet(null);
    setPickedStage(null);
  }

  const create = useMutation({
    mutationFn: async (): Promise<NewWorkResult> => {
      uploads.clearSettled();
      let item = await createWorkItem(
        api,
        organizationSlug,
        buildNewWorkPayload({
          projectId,
          title,
          description,
          doerUserIds: doers,
          supervisorUserIds: supervisors,
          watcherUserIds: watchers,
          clientOrganizationIds: clients,
          clientAudience,
          steps,
          dueDay,
          startDay,
          ...(now === undefined ? {} : { now }),
        }),
      );
      const failures: string[] = [];
      const follow = stageFollowUp({
        chosenSet: stageSet,
        baseSet,
        chosenStage: stage,
        landedStageId: currentStage(stageSet, item.stageId, item.state)?.id ?? null,
      });
      try {
        if (follow.stageSetId !== null) {
          item = await setWorkStageSet(api, organizationSlug, item.id, {
            stageSetId: follow.stageSetId,
            version: item.version,
          });
        }
        if (follow.stage !== null) {
          const moved = await moveToStage(api, organizationSlug, item, follow.stage);
          if (moved === null) throw new Error('no-move');
          item = moved;
        }
      } catch {
        failures.push(t('NewWork.stageNotSet'));
      }
      for (const labelId of labels) {
        await assignItemLabel(api, organizationSlug, item.id, labelId).catch(() => {
          const name = workLabels.data?.find((label) => label.id === labelId)?.name ?? '';
          failures.push(t('NewWork.labelNotAdded', { name }));
        });
      }
      if (repeat !== null) {
        await setWorkItemRecurrence(api, organizationSlug, item.id, {
          freq: repeat,
          interval: 1,
        }).catch(() => failures.push(t('NewWork.repeatNotSet')));
      }
      if (reminder !== '') {
        await setWorkItemReminder(
          api,
          organizationSlug,
          item.id,
          new Date(reminder).toISOString(),
        ).catch(() => failures.push(t('NewWork.reminderNotSet')));
      }
      // FIX6 item 2: files take the same road as chat and Files (TManage upload, item file).
      for (const file of files) {
        await uploads.start(file, async (sent, deps) => {
          try {
            const attached = await uploadWorkItemAttachment(
              api,
              organizationSlug,
              { workItemId: item.id, projectId: item.projectId, file: sent },
              { ...uploadOptions, ...deps },
            );
            return attached.id;
          } catch (error) {
            throw error instanceof ApiRequestError
              ? new Error(
                  t('NewWork.fileNotAttached', {
                    name: sent.name,
                    reason: withFullStop(error.message),
                  }),
                )
              : error;
          }
        });
      }
      for (const driveFile of driveFiles) {
        await attachDriveFile(api, organizationSlug, item.id, driveFile.id).catch(() => {
          failures.push(`“${driveFile.name}” ${t('DriveAttach.notAttached')}`);
        });
      }
      for (const picked of oneDriveFiles) {
        await attachOneDriveFile(api, organizationSlug, item.id, picked).catch(() => {
          failures.push(`“${picked.name}” ${t('OneDriveAttach.notAttached')}`);
        });
      }
      return { item, failures };
    },
    onSuccess: (result) => {
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
      setCreated(result);
      if (another.current) resetForNext();
      onCreated?.(result, another.current);
    },
  });

  /** "Create and add another": keep the project and the people, clear the rest. */
  function resetForNext() {
    setTitle('');
    setDescription('');
    setSteps([]);
    setLabels(new Set());
    setRepeat(null);
    setReminder('');
    setFiles([]);
    setDriveFiles([]);
    setOneDriveFiles([]);
    setDueDay('');
    setStartDay('');
    setFormError(null);
  }

  /** Check, then create; says what is missing next to the button (UX-23, GOV.UK validation). */
  function submit(andAnother = false): boolean {
    if (title.trim() === '') {
      setFormError(t('NewWork.needTitle'));
      return false;
    }
    if (projectId === '') {
      setFormError(t('NewWork.needProject'));
      return false;
    }
    if (supervisorRequired) {
      setFormError(
        tOr(
          'AiPickers.needPerson',
          'An AI employee does this work. Choose a person to supervise it.',
        ),
      );
      return false;
    }
    setFormError(null);
    setCreated(null);
    another.current = andAnother;
    create.mutate();
    return true;
  }

  return {
    projects,
    available,
    projectId,
    projectName,
    chooseProject,
    title,
    setTitle,
    description,
    setDescription,
    doers,
    setDoers: chooseDoers,
    aiDoer,
    supervisorRequired,
    viewerUserId,
    canAssignAi,
    supervisors,
    setSupervisors,
    watchers,
    setWatchers,
    clients,
    setClients,
    clientAudience,
    setClientAudience,
    projectClients,
    dueDay,
    setDueDay,
    startDay,
    setStartDay,
    steps,
    setSteps,
    labels,
    setLabels,
    workLabels,
    repeat,
    setRepeat,
    reminder,
    setReminder,
    files,
    setFiles,
    driveFiles,
    setDriveFiles,
    oneDriveFiles,
    setOneDriveFiles,
    uploads,
    people,
    stageSet,
    stage,
    projectSet,
    setChoices,
    pickSet: (set: StageSetView) => {
      setPickedSet(set);
      setPickedStage(null);
    },
    pickStage: setPickedStage,
    stagesLoading: sets.isPending,
    formError,
    setFormError,
    create,
    created,
    submit,
    resetForNext,
  };
}

export type NewWorkState = ReturnType<typeof useNewWork>;

/** The API's messages carry no full stop; the failures are joined into one paragraph. */
function withFullStop(message: string): string {
  return /[.!?]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`;
}
