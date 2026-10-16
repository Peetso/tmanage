'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { addWorkComment, createWorkItem } from '../../lib/api/work-items';
import type { CreateWorkItemInput, WorkItemSummary } from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
 * project", so the destination is an explicit pick from the caller's projects — the first project
 * is selected so the common case (capture into the obvious place) is one keystroke, not a decision.
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
  readonly client?: ApiClient;
}

export function QuickCaptureScreen({
  organizationSlug,
  organizationName,
  draft,
  client,
}: QuickCaptureScreenProps) {
  const api = client ?? browserApiClient();
  const headingId = useId();

  const projects = useQuery({
    queryKey: ['capture-projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const [title, setTitle] = useState(draft?.title ?? '');
  const [note, setNote] = useState(draft?.note ?? '');
  const [projectId, setProjectId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);

  // The first project is the default destination once the list arrives, unless the caller has
  // already chosen one. A capture into the obvious place is then a title and Enter.
  const available = projects.data ?? [];
  const effectiveProjectId = projectId !== '' ? projectId : (available[0]?.id ?? '');

  const capture = useMutation({
    mutationFn: async (): Promise<WorkItemSummary> => {
      const item = await createWorkItem(
        api,
        organizationSlug,
        buildCapturePayload({ projectId: effectiveProjectId, title }),
      );
      const body = note.trim();
      if (body !== '') {
        await addWorkComment(api, organizationSlug, item.id, { body });
      }
      return item;
    },
    onSuccess: (item) => {
      setCaptured(item.title);
      setTitle('');
      setNote('');
      setFormError(null);
    },
  });

  const submit = (): void => {
    if (title.trim() === '') {
      setFormError('Give the capture a title.');
      return;
    }
    if (effectiveProjectId === '') {
      setFormError('Choose a destination project.');
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
      title="Quick capture"
      description="File a note or task without leaving what you are doing."
    >
      {projects.isPending ? (
        <LoadingRegion label="Loading your projects">
          <Skeleton />
        </LoadingRegion>
      ) : projects.isError ? (
        <InlineAlert tone="danger" title="We could not load your projects">
          {errorMessage(projects.error)}
        </InlineAlert>
      ) : (
        <form
          className="tm-panel tm-stack"
          aria-labelledby={headingId}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <h2 id={headingId} className="tm-eyebrow">
            Capture
          </h2>

          <Field
            label="Title"
            required
            value={title}
            maxLength={500}
            onChange={(event) => setTitle(event.target.value)}
          />

          <Field
            label="Note"
            hint="Optional. Filed as the first comment on the new item."
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
          />

          {available.length === 0 ? (
            <InlineAlert tone="neutral" title="No project to capture into">
              You are not a member of a project that accepts new work yet. Create or join one, then
              capture here.
            </InlineAlert>
          ) : (
            <Select
              label="Destination"
              hint="The project the captured item is filed in."
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
              “{captured}” was filed. Capture another, or carry on.
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={capture.isPending || available.length === 0}>
              {capture.isPending ? 'Filing…' : 'Capture'}
            </Button>
          </div>
        </form>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
