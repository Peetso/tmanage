'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { NewProjectLink, useCanCreateProjects } from '../projects/NewProjectLink';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { listProjects } from '../../lib/api/projects';
import { addWorkComment, createWorkItem } from '../../lib/api/work-items';
import type { CreateWorkItemInput, WorkItemSummary } from '../../lib/api/work-items';
import { assignItemLabel, defineWorkLabel, listWorkLabels } from '../../lib/api/work-labels';
import { uploadWorkItemAttachment } from '../../lib/api/uploads';
import type { UploadAttachmentOptions } from '../../lib/api/uploads';
import { CaptureAttachmentPicker, CaptureLabelPicker } from './CaptureExtras';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { UploadProgressItem, useUploadQueue } from '../storage/UploadProgress';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useDictation } from '../voice/useDictation';
import { MicButton, MicNotice } from '../voice/VoiceControls';
import { DriveAttachPicker } from '../storage/DriveAttachPicker';
import { attachDriveFile } from '../../lib/api/google-drive';
import type { PickedDriveItem } from '../../lib/google-picker';
import { OneDriveAttachPicker } from '../storage/OneDriveAttachPicker';
import { attachOneDriveFile } from '../../lib/api/onedrive';
import type { PickedOneDriveItem } from '../../lib/onedrive-picker';
import { NoStorageAttach, useAttachStorageState } from '../storage/NoStorageAttach';
import { DueDatePicker, formatChipDay, useA6T } from '../work/DueDatePicker';
import { OwnerPickerDialog, useOwnerCandidates } from '../work/OwnerPickerDialog';
import { dayToInstant } from '../../lib/work-item-presentation';
import { parseQuickDate, quickDateInstant } from '../../lib/quick-date';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/home.css';
import { MoreOptions, useMyUserId } from '../forms/MoreOptions';
import { useTOr } from '../../lib/i18n/use-t-or';
import { WORK_ITEM_TITLE_MAX } from '@tmanage/domain';

/**
 * **Quick capture (modules 22 Desktop companion / 23 Mobile companion, 38-MODULE-MAP rows 22–23).**
 *
 * The one entry point both companions list: a single screen that files a short note or task
 * without first navigating to a project. It reuses the existing `work.write` surface rather than
 * adding a capture-only write — a captured item *is* a work item, so `POST work-items` is the
 * write, and an optional note becomes the item's first comment through the existing
 * `POST work-items/:id/comments`. No new table, no new endpoint.
 *
 * The screen is reachable three ways, all of which land here: the `capture-new` command in the
 * palette (a `navigate` to `/capture`), a manifest `shortcut`, and a manifest `share_target`. The
 * share target hands its payload in the query string (`?title=`, `?text=`, `?url=`), so the form
 * prefills from {@link buildCaptureDraft}: a shared page's title seeds the capture title, any
 * shared text and the shared URL seed the note.
 *
 * The destination is a project the caller can write to. Nothing returns a single "default inbox
 * project", so the destination is an explicit, required pick from the caller's projects. It opens
 * on the project the caller came from (`?project=` — the work list hands over its chosen project),
 * and otherwise on no project at all (CQ-07 / WRK-09): the first project is never preselected to
 * stand in for a choice the person has not made.
 *
 * **Labels and attachments** (Peter, 2026-10-18: "no attachment feature or tag it in project").
 * The organization's work labels (x233) toggle as capsules, and a new one can be defined in place;
 * files go through the existing upload pipeline (`uploads.ts`) into the chosen project and are
 * attached to the new item (x205). Both are written *after* the item exists — there is nothing to
 * hang them off before — and each failure is named afterwards rather than undoing the item: the
 * work was filed, and the person can add the missing label or file from the item.
 */

/** The prefilled form values a share-target payload (or an empty open) produces. */
export interface CaptureDraft {
  readonly title: string;
  readonly note: string;
}

/**
 * Derive the initial title and note from the share-target query parameters. Pure, so the
 * share-target mapping can be proven without rendering: a page's `title` seeds the capture title;
 * when a separate `text` is shared alongside it the text becomes the note, and a shared `url` is
 * always appended to the note. A share that carries only `text` uses it as the title (there is
 * nothing else to title the capture with) and does not then repeat it in the note.
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
 * Build the `createWorkItem` request body from the form state. Pure and separate from the screen so
 * the request a capture sends is proven directly: it is exactly the chosen project and the trimmed
 * title, and nothing from the note or the query ever reaches this payload (the note is a follow-up
 * comment, not a work-item field).
 */
export function buildCapturePayload(input: {
  readonly projectId: string;
  readonly title: string;
  /** The owner picked on the capsule's Owner chip (2026-10-31 live test), when one was. */
  readonly ownerUserId?: string | null;
  /** The committed day picked on the capsule's date chip, `YYYY-MM-DD`, when one was. */
  readonly committedDay?: string;
  /** The clock "tomorrow 3pm" in the title is read against (FIX-QUEUE B1). */
  readonly now?: Date;
}): CreateWorkItemInput {
  const picked = input.committedDay !== undefined && input.committedDay !== '';
  // A date written in the title ("tomorrow 3pm") leaves the title and becomes the due date,
  // unless a day was picked on the chip: the pick wins.
  const parsed = parseQuickDate(input.title, input.now);
  const dueAt = picked
    ? dayToInstant(input.committedDay ?? '')
    : parsed === null
      ? null
      : quickDateInstant(parsed);
  return {
    projectId: input.projectId,
    title: (parsed?.title ?? input.title).trim(),
    ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
    ...(dueAt === null ? {} : { dueAt }),
  };
}

/**
 * Which project the capture opens on — CQ-07 (WRK-09).
 *
 * The project the caller was handed (`?project=`, when it is one of theirs) is an explicit
 * choice and is honoured. With nothing handed over there is **no preselection**: the capture
 * opens on no project so the destination is a decision the person makes, not the first project
 * in the organization silently standing in for one.
 */
export function initialCaptureProjectId(
  available: readonly { readonly id: string }[],
  initialProjectId?: string,
): string {
  return available.some((project) => project.id === initialProjectId)
    ? (initialProjectId ?? '')
    : '';
}

export interface QuickCaptureScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  /** Prefill from the share-target payload (`?title=`/`?text=`/`?url=`). */
  readonly draft?: CaptureDraft;
  /** The project to open on (`?project=`), when it is one of the caller's projects. */
  readonly initialProjectId?: string;
  readonly client?: ApiClient;
  /** Test seam for the upload's part PUTs and idempotency keys. */
  readonly uploadOptions?: UploadAttachmentOptions;
}

/** What one capture filed, and what could not be added to it afterwards. */
interface CaptureResult {
  readonly item: WorkItemSummary;
  readonly failures: readonly string[];
}

export function QuickCaptureScreen({
  organizationSlug,
  organizationName,
  draft,
  initialProjectId,
  client,
  uploadOptions,
}: QuickCaptureScreenProps) {
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const myUserId = useMyUserId(api, organizationSlug);
  const queryClient = useQueryClient();
  const t = useT();
  const ta = useA6T();
  const locale = useActiveLocale();
  const headingId = useId();
  const canCreateProjects = useCanCreateProjects(organizationSlug, client);
  // 419:23811 / 419:23844: with neither Google Drive nor OneDrive chosen, nothing can be attached.
  const attachState = useAttachStorageState(organizationSlug, api);
  const noStorage = attachState === 'connect' || attachState === 'ask';

  const projects = useQuery({
    queryKey: ['capture-projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const [title, setTitle] = useState(draft?.title ?? '');
  const dictation = useDictation({
    value: title,
    onChange: (next) => setTitle(next.slice(0, 500)),
  });
  const [note, setNote] = useState(draft?.note ?? '');
  const labelsKey = ['capture-labels', organizationSlug];
  const labels = useQuery({
    queryKey: labelsKey,
    queryFn: () => listWorkLabels(api, organizationSlug),
  });

  const [projectId, setProjectId] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<ReadonlySet<string>>(new Set());
  const [files, setFiles] = useState<readonly File[]>([]);
  const [driveFiles, setDriveFiles] = useState<readonly PickedDriveItem[]>([]);
  const [oneDriveFiles, setOneDriveFiles] = useState<readonly PickedOneDriveItem[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<CaptureResult | null>(null);
  // Figma 446:36284 (WK-10, owner and committed date chosen): the capsule's Owner and Committed
  // date chips open the same pickers the work item uses, so a capture can be a commitment.
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [committedDay, setCommittedDay] = useState('');
  const [picker, setPicker] = useState<'owner' | 'date' | null>(null);
  // 409:6602. Each file is a progress row while it goes up; a stopped one keeps Retry, which
  // re-sends it to the item already filed.
  const uploads = useUploadQueue((error) =>
    error instanceof Error && !(error instanceof NetworkError) ? withFullStop(error.message) : null,
  );

  // The project the caller came from (`?project=`), when it is one of theirs — otherwise no
  // preselection (CQ-07 / WRK-09), so the destination is an explicit pick rather than the first
  // project standing in for one. A caller's own choice always wins once made.
  const available = projects.data ?? [];
  const preferred = initialCaptureProjectId(available, initialProjectId);
  const effectiveProjectId = projectId !== '' ? projectId : preferred;
  const owners = useOwnerCandidates(api, organizationSlug, effectiveProjectId);
  const ownerName =
    ownerUserId === null
      ? undefined
      : owners.candidates.find((candidate) => candidate.userId === ownerUserId)?.displayName;
  // The day a date written in the title would set, shown on the date chip until one is picked.
  const shownDay = committedDay !== '' ? committedDay : (parseQuickDate(title)?.day ?? '');
  const projectName = available.find((project) => project.id === effectiveProjectId)?.name ?? '';

  const toggleLabel = (labelId: string): void => {
    setSelectedLabels((current) => {
      const next = new Set(current);
      if (next.has(labelId)) next.delete(labelId);
      else next.add(labelId);
      return next;
    });
  };

  const createLabel = useMutation({
    mutationFn: (name: string) => defineWorkLabel(api, organizationSlug, { name, color: 'gray' }),
    onSuccess: async (label) => {
      setSelectedLabels((current) => new Set(current).add(label.id));
      await queryClient.invalidateQueries({ queryKey: labelsKey });
    },
  });

  const capture = useMutation({
    mutationFn: async (): Promise<CaptureResult> => {
      setProgress(t('QuickCaptureScreen.filing'));
      uploads.clearSettled();
      const item = await createWorkItem(
        api,
        organizationSlug,
        buildCapturePayload({ projectId: effectiveProjectId, title, ownerUserId, committedDay }),
      );
      const failures: string[] = [];
      const body = note.trim();
      if (body !== '') {
        await addWorkComment(api, organizationSlug, item.id, { body }).catch(() => {
          failures.push('The note was not added.');
        });
      }
      for (const labelId of selectedLabels) {
        await assignItemLabel(api, organizationSlug, item.id, labelId).catch(() => {
          const name = labels.data?.find((label) => label.id === labelId)?.name ?? 'A label';
          failures.push(`The label “${name}” was not added.`);
        });
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
              ? new Error(`“${sent.name}” was not attached: ${withFullStop(error.message)}`)
              : error;
          }
        });
      }
      // "Attach from Google Drive" (0210): the picked Drive files are linked once the item exists.
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
      setCaptured(result);
      setTitle('');
      setNote('');
      setSelectedLabels(new Set());
      setFiles([]);
      setDriveFiles([]);
      setOneDriveFiles([]);
      setOwnerUserId(null);
      setCommittedDay('');
      setFormError(null);
    },
    onSettled: () => setProgress(null),
  });

  // 2026-10-31 live test: a file that went up with the last capture belongs to that item (the
  // success line links it); left under the reset form it read as attached to the next one. A
  // failed row stays, because its Retry still sends it to the item already filed.
  const visibleUploads =
    captured === null ? uploads.rows : uploads.rows.filter((row) => row.state !== 'done');

  const submit = (): void => {
    if (title.trim() === '') {
      setFormError(t('QuickCaptureScreen.needTitle'));
      return;
    }
    if (effectiveProjectId === '') {
      setFormError(t('QuickCaptureScreen.needProject'));
      return;
    }
    setFormError(null);
    setCaptured(null);
    capture.mutate();
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('QuickCaptureScreen.eyebrow')}
      title={t('QuickCaptureScreen.title')}
      description={t('QuickCaptureScreen.description')}
    >
      {projects.isPending ? (
        <LoadingRegion label={t('QuickCaptureScreen.loadingProjects')}>
          <Skeleton height="220px" radius="var(--r-feature)" />
        </LoadingRegion>
      ) : projects.isError ? (
        <InlineAlert tone="danger" title={t('QuickCaptureScreen.loadProjectsFailed')}>
          {errorMessage(projects.error)}
        </InlineAlert>
      ) : (
        <form
          className="tm-capture"
          aria-labelledby={headingId}
          // QA-FIX-R M2: the browser's own check on the required project list stopped the submit
          // before `submit()` ran, so the inline "choose a project" message never showed and,
          // where the native bubble is not drawn, the press did nothing at all. The form checks
          // itself and says what is missing next to the button (UX-23, GOV.UK validation pattern).
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <h2 id={headingId} className="tm-visually-hidden">
            {t('QuickCaptureScreen.capture')}
          </h2>

          <div className="tm-capture__capsule">
            <Field
              className="tm-capture__title"
              label={t('QuickCaptureScreen.titleLabel')}
              required
              value={title}
              maxLength={WORK_ITEM_TITLE_MAX}
              onChange={(event) => setTitle(event.target.value)}
            />
            <MicButton dictation={dictation} compact />
            <MicNotice dictation={dictation} />

            <div
              className="tm-capture__chips"
              role="group"
              aria-label={t('QuickCaptureScreen.chipsLabel')}
            >
              <button
                type="button"
                className="tm-chip tm-chip--compact tm-capture__chip-static tm-capture__chip-button"
                aria-haspopup="dialog"
                disabled={capture.isPending}
                onClick={() => {
                  if (effectiveProjectId === '') {
                    setFormError(t('QuickCaptureScreen.ownerNeedsProject' as MessageKey));
                    return;
                  }
                  setPicker('owner');
                }}
              >
                {ownerUserId === null
                  ? t('QuickCaptureScreen.ownerUnassigned')
                  : t('QuickCaptureScreen.ownerChosen' as MessageKey).replace(
                      '{name}',
                      ownerName ?? '…',
                    )}
              </button>
              <button
                type="button"
                className={`tm-chip tm-chip--compact tm-capture__chip-button ${
                  shownDay === '' ? 'tm-chip--dashed' : 'tm-capture__chip-static'
                }`}
                aria-haspopup="dialog"
                disabled={capture.isPending}
                onClick={() => setPicker('date')}
              >
                {shownDay === ''
                  ? t('QuickCaptureScreen.committedNotSet')
                  : t('QuickCaptureScreen.committedChosen' as MessageKey).replace(
                      '{date}',
                      formatChipDay(shownDay, locale),
                    )}
              </button>
            </div>

            {available.length === 0 ? (
              <div className="tm-capture__no-project">
                <InlineAlert tone="neutral" title={t('QuickCaptureScreen.noProjectTitle')}>
                  {canCreateProjects
                    ? t('QuickCaptureScreen.noProjectCanCreate')
                    : t('QuickCaptureScreen.noProjectCannotCreate')}
                </InlineAlert>
                <NewProjectLink
                  organizationSlug={organizationSlug}
                  label={t('QuickCaptureScreen.createProject')}
                  size="default"
                  {...(client ? { client } : {})}
                />
              </div>
            ) : (
              <Select
                className="tm-capture__note"
                label={t('QuickCaptureScreen.projectLabel')}
                required
                hint={t('QuickCaptureScreen.projectHint')}
                value={effectiveProjectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  // An owner is one of the project's people; another project needs another pick.
                  setOwnerUserId(null);
                }}
              >
                {/* CQ-07 (WRK-09): no project is preselected, so the field opens on a prompt
                    rather than silently on the first project. */}
                {effectiveProjectId === '' ? (
                  <option value="">{t('QuickCaptureScreen.chooseProject')}</option>
                ) : null}
                {available.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            )}

            {/* 55-08: title, owner, date and project first; labels, files and the note sit behind
                "More options", remembered per person. */}
            <MoreOptions
              form="task"
              userId={myUserId}
              hint={tOr('MoreOptions.taskHint', 'Labels, files, note')}
              forceOpen={files.length > 0 || visibleUploads.length > 0}
            >
              <CaptureLabelPicker
                labels={labels.data ?? []}
                selected={selectedLabels}
                onToggle={toggleLabel}
                onCreate={(name) => createLabel.mutate(name)}
                creating={createLabel.isPending}
                createError={createLabel.isError ? errorMessage(createLabel.error) : null}
                disabled={capture.isPending}
              />

              {noStorage ? (
                <NoStorageAttach
                  organizationSlug={organizationSlug}
                  client={api}
                  state={attachState}
                />
              ) : (
                <CaptureAttachmentPicker
                  files={files}
                  onAdd={(picked) => setFiles((current) => [...current, ...picked])}
                  onRemove={(index) =>
                    setFiles((current) => current.filter((_, position) => position !== index))
                  }
                  disabled={capture.isPending}
                />
              )}

              {visibleUploads.length > 0 ? (
                <ul className="tm-upload-list">
                  {visibleUploads.map((row) => (
                    <UploadProgressItem
                      key={row.id}
                      row={row}
                      onCancel={uploads.cancel}
                      onRetry={uploads.retry}
                      onRemove={(gone) => uploads.remove(gone.id)}
                    />
                  ))}
                </ul>
              ) : null}

              <Field
                className="tm-capture__note"
                label={t('QuickCaptureScreen.noteLabel')}
                hint={t('QuickCaptureScreen.noteHint')}
                value={note}
                maxLength={2000}
                onChange={(event) => setNote(event.target.value)}
              />
            </MoreOptions>

            {formError ? (
              <InlineAlert tone="danger" title={t('QuickCaptureScreen.checkCapture')}>
                {formError}
              </InlineAlert>
            ) : null}

            {capture.isError ? (
              <InlineAlert tone="danger" title={t('QuickCaptureScreen.fileFailed')}>
                {errorMessage(capture.error)}
              </InlineAlert>
            ) : null}

            {captured ? (
              <InlineAlert tone="success" title={t('QuickCaptureScreen.capturedTitle')}>
                “{captured.item.title}
                {t('QuickCaptureScreen.capturedFiled')}
                <Link href={`/${organizationSlug}/work/${encodeURIComponent(captured.item.id)}`}>
                  {t('QuickCaptureScreen.openIt')}
                </Link>
                {t('QuickCaptureScreen.capturedRest')}
              </InlineAlert>
            ) : null}

            {captured && captured.failures.length > 0 ? (
              <InlineAlert tone="warning" title={t('QuickCaptureScreen.extrasTitle')}>
                {captured.failures.join(' ')}
                {t('QuickCaptureScreen.extrasRest')}
              </InlineAlert>
            ) : null}

            <div className="tm-capture__actions">
              <Button
                type="submit"
                tone="ink"
                size="feature"
                disabled={capture.isPending || available.length === 0}
              >
                {capture.isPending
                  ? (progress ?? t('QuickCaptureScreen.filing'))
                  : t('QuickCaptureScreen.captureButton')}
              </Button>
            </div>
          </div>

          {ownerUserId !== null && shownDay !== '' ? null : (
            <p className="tm-capture__note-callout">
              <span className="tm-capture__note-glyph" aria-hidden="true">
                !
              </span>
              <span>{t('QuickCaptureScreen.calloutBody')}</span>
            </p>
          )}

          {picker === 'owner' ? (
            <OwnerPickerDialog
              projectName={projectName}
              candidates={owners.candidates}
              loading={owners.loading}
              value={ownerUserId}
              onAssign={(userId) => {
                setOwnerUserId(userId);
                setPicker(null);
              }}
              onClose={() => setPicker(null)}
            />
          ) : null}

          {picker === 'date' ? (
            <DueDatePicker
              heading={ta('DueDatePicker.dueHeading')}
              value={shownDay}
              onSet={(day) => {
                setCommittedDay(day ?? '');
                setPicker(null);
              }}
              onClose={() => setPicker(null)}
            />
          ) : null}

          {noStorage ? null : (
            <div className="tm-cloud-attach">
              <DriveAttachPicker
                organizationSlug={organizationSlug}
                client={api}
                picked={driveFiles}
                onPick={(picked) => setDriveFiles((current) => [...current, ...picked])}
                onRemove={(id) =>
                  setDriveFiles((current) => current.filter((file) => file.id !== id))
                }
                projectId={effectiveProjectId}
                disabled={capture.isPending}
              />
              <OneDriveAttachPicker
                organizationSlug={organizationSlug}
                client={api}
                picked={oneDriveFiles}
                onPick={(picked) => setOneDriveFiles((current) => [...current, ...picked])}
                onRemove={(itemId) =>
                  setOneDriveFiles((current) => current.filter((file) => file.itemId !== itemId))
                }
                projectId={effectiveProjectId}
                disabled={capture.isPending}
              />
            </div>
          )}

          <p className="tm-capture__keys">{t('QuickCaptureScreen.keysHint')}</p>
        </form>
      )}
    </AppShell>
  );
}

/** The API's messages carry no full stop; the failures are joined into one paragraph. */
function withFullStop(message: string): string {
  return /[.!?]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`;
}
