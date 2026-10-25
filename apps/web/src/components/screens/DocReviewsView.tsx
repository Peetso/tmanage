'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  decideDocReview,
  listDocReviews,
  requestDocReview,
  type DocReviewState,
  type DocReviewView,
} from '../../lib/api/doc-reviews';
import { ApiRequestError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface DocReviewsViewProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
}

/** The message key for each review state's label; resolved through `t()` at each render site. */
const STATE_LABEL_KEY: Record<DocReviewState, MessageKey> = {
  pending: 'DocReviewsView.statePending',
  approved: 'DocReviewsView.stateApproved',
  changes_requested: 'DocReviewsView.stateChangesRequested',
};

/**
 * **Docs review workflow (x313) — document reviews.**
 *
 * The review surface `38-MODULE-MAP` §Docs defers ("review/approval"): a document's reviews, each a
 * request to a named reviewer and the reviewer's decision, with the current state shown as a chip. It
 * renders beside `DocumentViewScreen`, so it is a plain labelled region rather than its own screen.
 *
 * ## Not-found is the read's quiet case
 *
 * The reviews list is keyed by the document id, which the API resolves **tenant-scoped before the
 * relation check**, so an id in another tenant, a document the caller is not a member of, and one
 * that does not exist all answer the same 404. This panel shows that 404 as a plain "not available"
 * note and every other refusal as an error, so a transient outage is not misread as "no reviews".
 *
 * ## People are shown by id
 *
 * No endpoint resolves a membership or user id to a display name here, so the requester and reviewer
 * are shown by id — the honesty `DocumentCommentsPanel`/`DocumentEditorScreen` apply to the same gap.
 */
export function DocReviewsView({ organizationSlug, documentId, client }: DocReviewsViewProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const reviews = useQuery({
    queryKey: ['doc-reviews', organizationSlug, documentId],
    queryFn: () => listDocReviews(api, organizationSlug, documentId),
  });

  const [reviewerUserId, setReviewerUserId] = useState('');
  const [requestNote, setRequestNote] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['doc-reviews', organizationSlug, documentId] });

  const request = useMutation({
    mutationFn: () =>
      requestDocReview(api, organizationSlug, documentId, {
        reviewerUserId: reviewerUserId.trim(),
        ...(requestNote.trim() ? { note: requestNote.trim() } : {}),
      }),
    onSuccess: async () => {
      setReviewerUserId('');
      setRequestNote('');
      await invalidate();
    },
  });

  const notAvailable =
    reviews.isError && reviews.error instanceof ApiRequestError && reviews.error.status === 404;

  const rows = reviews.data ?? [];
  const latest = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const canRequest = reviewerUserId.trim() !== '';

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-doc-reviews">
      <div className="tm-row">
        <h2 id="tm-doc-reviews" className="tm-eyebrow">
          {t('DocReviewsView.reviews')}
        </h2>
        {latest ? <Badge>{t(STATE_LABEL_KEY[latest.state])}</Badge> : null}
      </div>

      {reviews.isPending ? (
        <LoadingRegion label={t('DocReviewsView.loadingReviews')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notAvailable ? (
        <InlineAlert tone="neutral" title={t('DocReviewsView.unavailableTitle')} live>
          {t('DocReviewsView.unavailableBody')}
        </InlineAlert>
      ) : null}

      {reviews.isError && !notAvailable ? (
        <InlineAlert tone="danger" title={t('DocReviewsView.loadError')} live>
          {describeError(reviews.error)}
        </InlineAlert>
      ) : null}

      {!reviews.isPending && !reviews.isError ? (
        rows.length > 0 ? (
          <ol className="tm-stack" aria-label={t('DocReviewsView.listAria')}>
            {rows.map((review) => (
              <ReviewRow
                key={review.id}
                review={review}
                api={api}
                organizationSlug={organizationSlug}
                documentId={documentId}
                onDecided={invalidate}
              />
            ))}
          </ol>
        ) : (
          <p className="tm-prose">{t('DocReviewsView.emptyReviews')}</p>
        )
      ) : null}

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canRequest) request.mutate();
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-doc-review-reviewer">
            {t('DocReviewsView.requestFromLabel')}
          </label>
          <input
            id="tm-doc-review-reviewer"
            name="reviewerUserId"
            className="tm-field__control"
            value={reviewerUserId}
            onChange={(event) => setReviewerUserId(event.target.value)}
          />
        </div>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-doc-review-note">
            {t('DocReviewsView.noteOptionalLabel')}
          </label>
          <textarea
            id="tm-doc-review-note"
            name="note"
            className="tm-field__control tm-field__control--multiline"
            rows={2}
            value={requestNote}
            onChange={(event) => setRequestNote(event.target.value)}
          />
        </div>

        {request.isError ? (
          <InlineAlert tone="danger" title={t('DocReviewsView.requestError')} live>
            {describeError(request.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={request.isPending}
            loadingLabel={t('DocReviewsView.requesting')}
            disabled={!canRequest}
          >
            {t('DocReviewsView.requestReview')}
          </Button>
        </div>
      </form>
    </section>
  );
}

interface ReviewRowProps {
  review: DocReviewView;
  api: ApiClient;
  organizationSlug: string;
  documentId: string;
  onDecided: () => Promise<unknown>;
}

/** One review row: the state chip, who/when, and — while pending — a decision panel. */
function ReviewRow({ review, api, organizationSlug, documentId, onDecided }: ReviewRowProps) {
  const describeError = useDescribeApiError();
  const t = useT();
  const [state, setState] = useState<'approved' | 'changes_requested'>('approved');
  const [note, setNote] = useState('');

  const decide = useMutation({
    mutationFn: () =>
      decideDocReview(api, organizationSlug, documentId, review.id, {
        state,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async () => {
      setNote('');
      await onDecided();
    },
  });

  const needsNote = state === 'changes_requested' && note.trim() === '';

  return (
    <li className="tm-stack">
      <div className="tm-row">
        <Badge>{t(STATE_LABEL_KEY[review.state])}</Badge>
        <span className="tm-field__hint">
          {review.reviewerUserId} · {formatInstant(review.createdAt)}
        </span>
      </div>
      {review.note ? <p className="tm-prose">{review.note}</p> : null}

      {review.state === 'pending' ? (
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!needsNote) decide.mutate();
          }}
        >
          <Select
            label={t('DocReviewsView.decision')}
            value={state}
            onChange={(event) => setState(event.target.value as 'approved' | 'changes_requested')}
          >
            <option value="approved">{t('DocReviewsView.approve')}</option>
            <option value="changes_requested">{t('DocReviewsView.requestChanges')}</option>
          </Select>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor={`tm-doc-review-decide-note-${review.id}`}>
              {t('DocReviewsView.note')}
              {state === 'changes_requested' ? '' : t('DocReviewsView.optionalSuffix')}
            </label>
            <textarea
              id={`tm-doc-review-decide-note-${review.id}`}
              name="note"
              className="tm-field__control tm-field__control--multiline"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          {decide.isError ? (
            <InlineAlert tone="danger" title={t('DocReviewsView.decisionError')} live>
              {describeError(decide.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={decide.isPending}
              loadingLabel={t('DocReviewsView.saving')}
              disabled={needsNote}
            >
              {t('DocReviewsView.saveDecision')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="tm-field__hint">
          {t('DocReviewsView.decided')} {review.decidedAt ? formatInstant(review.decidedAt) : ''}
        </p>
      )}
    </li>
  );
}
