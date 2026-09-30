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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface DocReviewsViewProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
}

const STATE_LABEL: Record<DocReviewState, string> = {
  pending: 'Pending',
  approved: 'Approved',
  changes_requested: 'Changes requested',
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
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

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
          Reviews
        </h2>
        {latest ? <Badge>{STATE_LABEL[latest.state]}</Badge> : null}
      </div>

      {reviews.isPending ? (
        <LoadingRegion label="Loading reviews.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notAvailable ? (
        <InlineAlert tone="neutral" title="Reviews unavailable" live>
          Reviews are not available for this document.
        </InlineAlert>
      ) : null}

      {reviews.isError && !notAvailable ? (
        <InlineAlert tone="danger" title="Could not load reviews" live>
          {describeError(reviews.error)}
        </InlineAlert>
      ) : null}

      {!reviews.isPending && !reviews.isError ? (
        rows.length > 0 ? (
          <ol className="tm-stack" aria-label="Reviews of this document">
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
          <p className="tm-prose">No reviews requested yet.</p>
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
            Request a review from (user id)
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
            Note (optional)
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
          <InlineAlert tone="danger" title="Could not request the review" live>
            {describeError(request.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={request.isPending}
            loadingLabel="Requesting"
            disabled={!canRequest}
          >
            Request review
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
        <Badge>{STATE_LABEL[review.state]}</Badge>
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
            label="Decision"
            value={state}
            onChange={(event) => setState(event.target.value as 'approved' | 'changes_requested')}
          >
            <option value="approved">Approve</option>
            <option value="changes_requested">Request changes</option>
          </Select>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor={`tm-doc-review-decide-note-${review.id}`}>
              Note{state === 'changes_requested' ? '' : ' (optional)'}
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
            <InlineAlert tone="danger" title="Could not record the decision" live>
              {describeError(decide.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={decide.isPending}
              loadingLabel="Saving"
              disabled={needsNote}
            >
              Save decision
            </Button>
          </div>
        </form>
      ) : (
        <p className="tm-field__hint">
          Decided {review.decidedAt ? formatInstant(review.decidedAt) : ''}
        </p>
      )}
    </li>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
