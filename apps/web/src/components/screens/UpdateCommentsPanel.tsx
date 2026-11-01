'use client';

import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  listProjectUpdateComments,
  postProjectUpdateComment,
  type UpdateComment,
} from '../../lib/api/portal';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appLocale } from '../../lib/i18n/app-locale';

export interface UpdateCommentsPanelProps {
  organizationSlug: string;
  projectId: string;
  updateId: string;
  api: ApiClient;
}

const MAX_BODY_LENGTH = 5000;

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(appLocale());
}

/**
 * **x203 — a comment thread on a client update.** (Client portal, module 13.)
 *
 * The internal compose surface for the update comment lifecycle 0041 deferred: post an internal
 * comment on a published update, see the thread oldest-first. The comments the studio posts here are
 * shown to the client reading that update's timeline; a client *reply* is a later slice (it needs a
 * client-write capability). Edit and delete are deferred too — this panel does post / list only,
 * matching the append-only route behind it, behind `project.manage`.
 *
 * A distinct file from x125's update compose panel: it reads its own query and invalidates it on
 * every write so the list reflects the server rather than an optimistic guess.
 */
export function UpdateCommentsPanel({
  organizationSlug,
  projectId,
  updateId,
  api,
}: UpdateCommentsPanelProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['project-update-comments', organizationSlug, projectId, updateId] as const;
  const bodyId = useId();
  const [body, setBody] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const comments = useQuery({
    queryKey,
    queryFn: () => listProjectUpdateComments(api, organizationSlug, projectId, updateId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (nextBody: string) =>
      postProjectUpdateComment(api, organizationSlug, projectId, updateId, { body: nextBody }),
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

  const items: readonly UpdateComment[] = comments.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-update-comments">
      <h2 id="tm-update-comments" className="tm-eyebrow">
        {t('UpdateCommentsPanel.heading')}
      </h2>

      {comments.isPending ? (
        <LoadingRegion label={t('UpdateCommentsPanel.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {comments.isError ? (
        <InlineAlert tone="danger" title={t('UpdateCommentsPanel.loadError')} live>
          {describe(comments.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('UpdateCommentsPanel.submitError')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {comments.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('UpdateCommentsPanel.empty')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('UpdateCommentsPanel.listLabel')}>
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
            {t('UpdateCommentsPanel.addLabel')}
          </label>
          <textarea
            id={bodyId}
            className="tm-field__control"
            value={body}
            rows={3}
            maxLength={MAX_BODY_LENGTH}
            onChange={(event) => setBody(event.target.value)}
          />
          <span className="tm-field__hint">{t('UpdateCommentsPanel.hint')}</span>
        </div>
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('UpdateCommentsPanel.adding')}
            disabled={body.trim() === ''}
          >
            {t('UpdateCommentsPanel.add')}
          </Button>
        </div>
      </form>
    </section>
  );
}
