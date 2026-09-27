'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { createFocusBlock, deleteFocusBlock, listFocusBlocks } from '../../lib/api/focus-blocks';
import type { FocusBlockView } from '../../lib/api/focus-blocks';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface FocusBlocksScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The list window: from the start of today through 30 days out, so a member sees their upcoming blocks. */
function listWindow(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Render an ISO instant as a readable local date-time, falling back to the raw value. */
function formatInstant(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

/**
 * **Calendar focus blocks (module Calendar, CAL-04 "Focus block", x255).**
 *
 * A member protects time on their own calendar: they create a block (a start, an end and a short
 * title), see their upcoming blocks, and delete one. Persisted behind `work.read`, scoped to the
 * caller's own membership by the server — a member never sees or removes another's blocks.
 */
export function FocusBlocksScreen({
  organizationSlug,
  organizationName,
  client,
}: FocusBlocksScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const window = useMemo(listWindow, []);

  const blocks = useQuery({
    queryKey: ['focus-blocks', organizationSlug, window.from, window.to],
    queryFn: () => listFocusBlocks(api, organizationSlug, window.from, window.to),
  });

  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () =>
    queries.invalidateQueries({ queryKey: ['focus-blocks', organizationSlug] });

  const create = useMutation({
    mutationFn: (): Promise<FocusBlockView> =>
      createFocusBlock(api, organizationSlug, {
        // `datetime-local` yields a wall-clock string with no zone; the Date constructor reads it as
        // local and toISOString normalises it to the instant the API stores.
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        title,
      }),
    onSuccess: () => {
      setStartsAt('');
      setEndsAt('');
      setTitle('');
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string): Promise<void> => deleteFocusBlock(api, organizationSlug, id),
    onSuccess: () => void invalidate(),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!startsAt || !endsAt || title.trim().length === 0) {
      setFormError('A start, an end and a title are all required.');
      return;
    }
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      setFormError('The end must be after the start.');
      return;
    }
    create.mutate();
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Focus blocks"
      description="Protect time on your calendar. Create a block, see your upcoming blocks, and remove one."
    >
      <form className="tm-panel tm-stack" aria-labelledby="tm-focus-heading" onSubmit={submit}>
        <h2 id="tm-focus-heading" className="tm-eyebrow">
          New focus block
        </h2>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-focus-title">
            Title
          </label>
          <input
            id="tm-focus-title"
            className="tm-field__control"
            type="text"
            value={title}
            placeholder="e.g. Deep work"
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-focus-start">
            Start
          </label>
          <input
            id="tm-focus-start"
            className="tm-field__control"
            type="datetime-local"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
          />
        </div>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-focus-end">
            End
          </label>
          <input
            id="tm-focus-end"
            className="tm-field__control"
            type="datetime-local"
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
          />
        </div>

        {formError ? (
          <InlineAlert tone="danger" title="Check the focus block">
            {formError}
          </InlineAlert>
        ) : null}

        {create.isError ? (
          <InlineAlert tone="danger" title="We could not create the focus block">
            {errorMessage(create.error)}
          </InlineAlert>
        ) : null}

        <div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create focus block'}
          </Button>
        </div>
      </form>

      {blocks.isPending ? (
        <LoadingRegion label="Loading your focus blocks">
          <Skeleton />
        </LoadingRegion>
      ) : blocks.isError ? (
        <InlineAlert tone="danger" title="We could not load your focus blocks">
          {errorMessage(blocks.error)}
        </InlineAlert>
      ) : blocks.data.length === 0 ? (
        <InlineAlert tone="neutral" title="No focus blocks">
          You have no upcoming focus blocks. Create one above.
        </InlineAlert>
      ) : (
        <ul className="tm-list tm-stack" aria-label="Upcoming focus blocks">
          {blocks.data.map((block) => (
            <li key={block.id} className="tm-row tm-row--between">
              <div className="tm-stack tm-stack--tight">
                <strong>{block.title}</strong>
                <span className="tm-muted">
                  {formatInstant(block.startsAt)} — {formatInstant(block.endsAt)}
                </span>
              </div>
              <Button
                type="button"
                tone="text"
                disabled={remove.isPending}
                onClick={() => remove.mutate(block.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {remove.isError ? (
        <InlineAlert tone="danger" title="We could not remove the focus block">
          {errorMessage(remove.error)}
        </InlineAlert>
      ) : null}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
