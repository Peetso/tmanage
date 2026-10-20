'use client';

import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  addDecisionComment,
  deleteDecisionComment,
  listDecisionComments,
  type DecisionComment,
} from '../../lib/api/decision-comments';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface DecisionCommentsViewProps {
  organizationSlug: string;
  decisionId: string;
  /** The acting membership, so the view offers delete only on the caller's own comments. */
  membershipId: string;
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
 * **x317 — a decision's discussion.** (Requests, decisions & approvals: decision discussion;
 * 22-SCREEN decision register.)
 *
 * The internal comment thread on a decision on the register: add a comment, see the list
 * oldest-first, and delete one's own. Decisions are internal, so this thread is internal-only and
 * never projected to a client. It reads its own query and invalidates it on every write so the list
 * reflects the server rather than an optimistic guess. Delete is offered only on the caller's own
 * comments; the server is the authority (another member's comment is refused).
 */
export function DecisionCommentsView({
  organizationSlug,
  decisionId,
  membershipId,
  api,
}: DecisionCommentsViewProps) {
  const queries = useQueryClient();
  const t = useT();
  const queryKey = ['decision-comments', organizationSlug, decisionId] as const;
  const bodyId = useId();
  const [body, setBody] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const comments = useQuery({
    queryKey,
    queryFn: () => listDecisionComments(api, organizationSlug, decisionId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (nextBody: string) =>
      addDecisionComment(api, organizationSlug, decisionId, { body: nextBody }),
    onSuccess: () => {
      setBody('');
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (commentId: string) =>
      deleteDecisionComment(api, organizationSlug, decisionId, commentId),
    onSuccess: () => {
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

  const items: readonly DecisionComment[] = comments.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-decision-comments">
      <h2 id="tm-decision-comments" className="tm-eyebrow">
        {t('DecisionCommentsView.discussion')}
      </h2>

      {comments.isPending ? (
        <LoadingRegion label={t('DecisionCommentsView.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {comments.isError ? (
        <InlineAlert tone="danger" title={t('DecisionCommentsView.loadError')} live>
          {describe(comments.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('DecisionCommentsView.actionFailed')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {comments.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('DecisionCommentsView.empty')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('DecisionCommentsView.commentsAria')}>
            {items.map((comment) => (
              <li key={comment.id} className="tm-stack">
                <p className="tm-prose">{comment.body}</p>
                <div className="tm-row">
                  <time className="tm-eyebrow" dateTime={comment.createdAt}>
                    {formatWhen(comment.createdAt)}
                  </time>
                  {comment.authorMembershipId === membershipId ? (
                    <Button
                      type="button"
                      tone="text"
                      size="accessible"
                      loading={remove.isPending && remove.variables === comment.id}
                      loadingLabel={t('DecisionCommentsView.removing')}
                      onClick={() => remove.mutate(comment.id)}
                    >
                      {t('DecisionCommentsView.delete')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={bodyId}>
            {t('DecisionCommentsView.addLabel')}
          </label>
          <textarea
            id={bodyId}
            className="tm-field__control"
            value={body}
            rows={3}
            maxLength={MAX_BODY_LENGTH}
            onChange={(event) => setBody(event.target.value)}
          />
          <span className="tm-field__hint">{t('DecisionCommentsView.hint')}</span>
        </div>
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('DecisionCommentsView.adding')}
            disabled={body.trim() === ''}
          >
            {t('DecisionCommentsView.addComment')}
          </Button>
        </div>
      </form>
    </section>
  );
}
