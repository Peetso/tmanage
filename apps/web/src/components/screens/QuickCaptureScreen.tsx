'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { NewProjectLink, useCanCreateProjects } from '../projects/NewProjectLink';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { addWorkComment, attachWorkItemFile, createWorkItem } from '../../lib/api/work-items';
import type { CreateWorkItemInput, WorkItemSummary } from '../../lib/api/work-items';
import { assignItemLabel, defineWorkLabel, listWorkLabels } from '../../lib/api/work-labels';
import { uploadProjectFile } from '../../lib/api/uploads';
import type { UploadAttachmentOptions } from '../../lib/api/uploads';
import { CaptureAttachmentPicker, CaptureLabelPicker } from './CaptureExtras';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/home.css';

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
 * and otherwise on the first project, so the common case is one keystroke, not a decision.
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
}): CreateWorkItemInput {
  return { projectId: input.projectId, title: input.title.trim() };
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
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const headingId = useId();
  const canCreateProjects = useCanCreateProjects(organizationSlug, client);

  const projects = useQuery({
    queryKey: ['capture-projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const [title, setTitle] = useState(draft?.title ?? '');
  const [note, setNote] = useState(draft?.note ?? '');
  const labelsKey = ['capture-labels', organizationSlug];
  const labels = useQuery({
    queryKey: labelsKey,
    queryFn: () => listWorkLabels(api, organizationSlug),
  });

  const [projectId, setProjectId] = useState('');
  const [selectedLabels, setSelectedLabels] = useState<ReadonlySet<string>>(new Set());
  const [files, setFiles] = useState<readonly File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<CaptureResult | null>(null);

  // The project the caller came from, else the first project, once the list arrives — unless the
  // caller has already chosen one. A capture into the obvious place is then a title and Enter.
  const available = projects.data ?? [];
  const preferred = available.some((project) => project.id === initialProjectId)
    ? (initialProjectId ?? '')
    : (available[0]?.id ?? '');
  const effectiveProjectId = projectId !== '' ? projectId : preferred;

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
      setProgress('Filing…');
      const item = await createWorkItem(
        api,
        organizationSlug,
        buildCapturePayload({ projectId: effectiveProjectId, title }),
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
      for (const [index, file] of files.entries()) {
        setProgress(`Uploading ${index + 1} of ${files.length}…`);
        try {
          const fileAssetId = await uploadProjectFile(
            api,
            organizationSlug,
            { projectId: item.projectId, file },
            uploadOptions,
          );
          await attachWorkItemFile(api, organizationSlug, item.id, { fileAssetId });
        } catch (error) {
          failures.push(
            error instanceof ApiRequestError
              ? `“${file.name}” was not attached: ${error.message}`
              : error instanceof Error
                ? error.message
                : `“${file.name}” was not attached.`,
          );
        }
      }
      return { item, failures };
    },
    onSuccess: (result) => {
      setCaptured(result);
      setTitle('');
      setNote('');
      setSelectedLabels(new Set());
      setFiles([]);
      setFormError(null);
    },
    onSettled: () => setProgress(null),
  });

  const submit = (): void => {
    if (title.trim() === '') {
      setFormError('Give the capture a title.');
      return;
    }
    if (effectiveProjectId === '') {
      setFormError('Choose the project this work belongs to.');
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
      eyebrow="Work"
      title="Quick capture"
      description="File a note or task without leaving what you are doing."
    >
      {projects.isPending ? (
        <LoadingRegion label="Loading your projects">
          <Skeleton height="220px" radius="var(--r-feature)" />
        </LoadingRegion>
      ) : projects.isError ? (
        <InlineAlert tone="danger" title="We could not load your projects">
          {errorMessage(projects.error)}
        </InlineAlert>
      ) : (
        <form
          className="tm-capture"
          aria-labelledby={headingId}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <h2 id={headingId} className="tm-visually-hidden">
            Capture
          </h2>

          <div className="tm-capture__capsule">
            <Field
              className="tm-capture__title"
              label="Title"
              required
              value={title}
              maxLength={500}
              onChange={(event) => setTitle(event.target.value)}
            />

            <div className="tm-capture__chips" role="group" aria-label="What this capture will be">
              <span className="tm-chip tm-chip--compact tm-capture__chip-static">
                Owner · unassigned
              </span>
              <span className="tm-chip tm-chip--compact tm-chip--dashed">
                Committed date · not set
              </span>
            </div>

            {available.length === 0 ? (
              <div className="tm-capture__no-project">
                <InlineAlert tone="neutral" title="No project to capture into">
                  {canCreateProjects
                    ? 'Work lives in a project. Create your first one, then capture here.'
                    : 'You are not a member of a project that accepts new work yet. Ask an owner or admin to add you to one, then capture here.'}
                </InlineAlert>
                <NewProjectLink
                  organizationSlug={organizationSlug}
                  label="Create a project"
                  size="default"
                  {...(client ? { client } : {})}
                />
              </div>
            ) : (
              <Select
                className="tm-capture__note"
                label="Project"
                required
                hint="The project this work is filed in. Only projects you can add work to are listed."
                value={effectiveProjectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {available.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            )}

            <CaptureLabelPicker
              labels={labels.data ?? []}
              selected={selectedLabels}
              onToggle={toggleLabel}
              onCreate={(name) => createLabel.mutate(name)}
              creating={createLabel.isPending}
              createError={createLabel.isError ? errorMessage(createLabel.error) : null}
              disabled={capture.isPending}
            />

            <CaptureAttachmentPicker
              files={files}
              onAdd={(picked) => setFiles((current) => [...current, ...picked])}
              onRemove={(index) =>
                setFiles((current) => current.filter((_, position) => position !== index))
              }
              disabled={capture.isPending}
            />

            <Field
              className="tm-capture__note"
              label="Note"
              hint="Optional. Filed as the first comment on the new item."
              value={note}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
            />

            {formError ? (
              <InlineAlert tone="danger" title="Check the capture">
                {formError}
              </InlineAlert>
            ) : null}

            {capture.isError ? (
              <InlineAlert tone="danger" title="We could not file the capture">
                {errorMessage(capture.error)}
              </InlineAlert>
            ) : null}

            {captured ? (
              <InlineAlert tone="success" title="Captured">
                “{captured.item.title}” was filed.{' '}
                <Link href={`/${organizationSlug}/work/${encodeURIComponent(captured.item.id)}`}>
                  Open it
                </Link>
                , capture another, or carry on.
              </InlineAlert>
            ) : null}

            {captured && captured.failures.length > 0 ? (
              <InlineAlert tone="warning" title="Some extras were not added">
                {captured.failures.join(' ')} Open the item to add them again.
              </InlineAlert>
            ) : null}

            <div className="tm-capture__actions">
              <Button
                type="submit"
                tone="ink"
                size="feature"
                disabled={capture.isPending || available.length === 0}
              >
                {capture.isPending ? (progress ?? 'Filing…') : 'Capture'}
              </Button>
            </div>
          </div>

          <p className="tm-capture__note-callout">
            <span className="tm-capture__note-glyph" aria-hidden="true">
              !
            </span>
            <span>
              A capture is filed without an owner or a committed date. Open it afterwards to assign
              it and commit a date — until then it is not a commitment.
            </span>
          </p>

          <p className="tm-capture__keys">Enter captures · the note is optional</p>
        </form>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
