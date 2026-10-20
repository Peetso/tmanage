'use client';

import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { addWorkComment, listWorkComments, type WorkComment } from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface WorkCommentsPanelProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
}

const MAX_BODY_LENGTH = 5000;

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString();
}

/**
 * **x147 — a work item's comments / activity.** (Work module 7; TM-13's "activity / discussion"
 * section.)
 *
 * The smallest useful unit of the activity trail the work-item detail screen named but had not
 * built: add an internal comment, see the list oldest-first. Edit, delete, mentions and reactions
 * are NS-13; this panel does add / list only, matching the append-only route behind it.
 *
 * It is mounted additively beside the rest of the detail screen (and disjoint from x145's
 * checklist), reads its own query, and invalidates that query on every write so the list reflects
 * the server rather than an optimistic guess. Comments are internal-only.
 */
export function WorkCommentsPanel({ organizationSlug, workItemId, api }: WorkCommentsPanelProps) {
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['work-item-comments', organizationSlug, workItemId] as const;
  const bodyId = useId();
  const [body, setBody] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const comments = useQuery({
    queryKey,
    queryFn: () => listWorkComments(api, organizationSlug, workItemId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (nextBody: string) =>
      addWorkComment(api, organizationSlug, workItemId, { body: nextBody }),
    onSuccess: () => {
      setBody('');
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = body.trim();
    if (trimmed === '') return;
    add.mutate(trimmed);
  }

  const items: readonly WorkComment[] = comments.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-work-comments">
      <h2 id="tm-work-comments" className="tm-eyebrow">
        {t('WorkCommentsPanel.heading')}
      </h2>

      {comments.isPending ? (
        <LoadingRegion label={t('WorkCommentsPanel.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {comments.isError ? (
        <InlineAlert tone="danger" title={t('WorkCommentsPanel.loadError')} live>
          {describe(comments.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkCommentsPanel.submitError')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {comments.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('WorkCommentsPanel.empty')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('WorkCommentsPanel.listLabel')}>
            {items.map((comment) => (
              <li key={comment.id} className="tm-stack">
                <p className="tm-prose">{comment.body}</p>
                <time className="tm-eyebrow" dateTime={comment.createdAt}>
                  {formatWhen(comment.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={bodyId}>
            {t('WorkCommentsPanel.addLabel')}
          </label>
          <textarea
            id={bodyId}
            className="tm-field__control"
            value={body}
            rows={3}
            maxLength={MAX_BODY_LENGTH}
            onChange={(event) => setBody(event.target.value)}
          />
          <span className="tm-field__hint">{t('WorkCommentsPanel.hint')}</span>
        </div>
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('WorkCommentsPanel.adding')}
            disabled={body.trim() === ''}
          >
            {t('WorkCommentsPanel.add')}
          </Button>
        </div>
      </form>
    </section>
  );
}
