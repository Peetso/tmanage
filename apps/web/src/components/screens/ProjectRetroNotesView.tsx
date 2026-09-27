'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  createProjectRetroNote,
  deleteProjectRetroNote,
  listProjectRetroNotes,
  type ProjectRetroBoard,
  type ProjectRetroNoteCategory,
  type ProjectRetroNoteSummary,
} from '../../lib/api/project-retro-notes';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectRetroNotesViewProps {
  organizationSlug: string;
  /** The project whose retrospective board this view shows — from the `[projectId]` route segment. */
  projectId: string;
  api: ApiClient;
}

const CATEGORIES: readonly ProjectRetroNoteCategory[] = ['went_well', 'to_improve', 'action'];

const CATEGORY_LABELS: Readonly<Record<ProjectRetroNoteCategory, string>> = {
  went_well: 'Went well',
  to_improve: 'To improve',
  action: 'Action',
};

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

function groupOf(
  board: ProjectRetroBoard,
  category: ProjectRetroNoteCategory,
): readonly ProjectRetroNoteSummary[] {
  if (category === 'went_well') return board.wentWell;
  if (category === 'to_improve') return board.toImprove;
  return board.action;
}

/**
 * **x311 — a project's retrospective board.** (PROJ / module 8; 38-MODULE-MAP §Projects & portfolio
 * "retrospectives"; 22-SCREEN §Project detail.)
 *
 * The smallest useful unit of a retro: capture a note under one of `went_well` / `to_improve` /
 * `action`, see the project's notes grouped by category (newest-first), and delete one. Behind
 * `project.manage` on the server — the studio's own reflection log, captured and read by the people
 * who manage the project. Mounted additively beside the rest of the project detail; it reads its own
 * board query and invalidates it on every write so the board reflects the server.
 *
 * As on the sibling views, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describe()` turns into a sentence.
 */
export function ProjectRetroNotesView({
  organizationSlug,
  projectId,
  api,
}: ProjectRetroNotesViewProps) {
  const queries = useQueryClient();
  const queryKey = ['project-retro-notes', organizationSlug, projectId] as const;

  const [category, setCategory] = useState<ProjectRetroNoteCategory>('went_well');
  const [body, setBody] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const board = useQuery({
    queryKey,
    queryFn: () => listProjectRetroNotes(api, organizationSlug, projectId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const capture = useMutation({
    mutationFn: () =>
      createProjectRetroNote(api, organizationSlug, projectId, { category, body: body.trim() }),
    onSuccess: () => {
      setFailure(undefined);
      setBody('');
      setCategory('went_well');
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (noteId: string) =>
      deleteProjectRetroNote(api, organizationSlug, projectId, noteId),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (body.trim() === '') {
      setFailure('Write the note before adding it.');
      return;
    }
    capture.mutate();
  }

  const pending = capture.isPending || remove.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-retro-notes">
      <h2 id="tm-retro-notes" className="tm-eyebrow">
        Retrospective
      </h2>

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      <form className="tm-stack" onSubmit={submit} noValidate>
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-retro-category">
            Category
          </label>
          <select
            id="tm-retro-category"
            name="category"
            className="tm-field__control"
            value={category}
            disabled={pending}
            onChange={(event) => setCategory(event.target.value as ProjectRetroNoteCategory)}
          >
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-retro-body">
            Note
          </label>
          <textarea
            id="tm-retro-body"
            name="body"
            className="tm-field__control"
            rows={3}
            value={body}
            disabled={pending}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            disabled={pending}
            loading={capture.isPending}
            loadingLabel="Adding"
          >
            Add note
          </Button>
        </div>
      </form>

      {board.isPending ? (
        <LoadingRegion label="Loading the retrospective board.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {board.isError ? (
        <InlineAlert tone="danger" title="Could not load the board" live>
          {describe(board.error)}
        </InlineAlert>
      ) : null}

      {board.data
        ? CATEGORIES.map((value) => {
            const notes = groupOf(board.data, value);
            return (
              <div key={value} className="tm-stack">
                <h3 className="tm-eyebrow">{CATEGORY_LABELS[value]}</h3>
                {notes.length === 0 ? (
                  <p className="tm-prose">Nothing here yet.</p>
                ) : (
                  <ul className="tm-list" aria-label={`${CATEGORY_LABELS[value]} notes`}>
                    {notes.map((note) => (
                      <li key={note.id} className="tm-row">
                        <p className="tm-prose">{note.body}</p>
                        <Button
                          type="button"
                          tone="outline"
                          size="accessible"
                          disabled={pending}
                          onClick={() => remove.mutate(note.id)}
                        >
                          Delete
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })
        : null}
    </section>
  );
}
