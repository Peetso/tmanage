'use client';

import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { submitPortalDeliverableFeedback } from '../../lib/api/portal-deliverable-feedback';
import type { PortalDeliverableFeedback } from '../../lib/api/portal-deliverable-feedback';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PortalDeliverableFeedbackViewProps {
  organizationSlug: string;
  /** The deliverable the client is rating — the `:deliverableId` in the route. */
  deliverableId: string;
  client?: ApiClient;
}

const RATINGS = [1, 2, 3, 4, 5] as const;

/**
 * **CL-03 Deliverable feedback (module 13 Client Portal, x321).**
 *
 * The rating (1–5) and optional comment a client contact leaves on a *published* deliverable, on
 * the client deliverable view. Behind `client_projection.read` — the one key a client role holds —
 * and scoped server-side to the caller's own client organization: the author is the authenticated
 * principal, never a value this view supplies, and only a published, client-visible deliverable
 * accepts feedback (anything else is a 404 the client turns into an error, never a hint the
 * deliverable is real). Feedback is one-per-contact-per-version, so a re-submit revises in place;
 * this view reflects that by keeping the confirmation and the last saved rating.
 */
export function PortalDeliverableFeedbackView({
  organizationSlug,
  deliverableId,
  client = browserApiClient(),
}: PortalDeliverableFeedbackViewProps) {
  const commentId = useId();
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [ratingRequired, setRatingRequired] = useState(false);

  const submit = useMutation({
    mutationFn: (input: { rating: number; comment?: string }) =>
      submitPortalDeliverableFeedback(client, organizationSlug, deliverableId, input),
  });

  function onSubmit() {
    if (rating === null) {
      setRatingRequired(true);
      return;
    }
    setRatingRequired(false);
    const trimmed = comment.trim();
    submit.mutate({ rating, ...(trimmed === '' ? {} : { comment: trimmed }) });
  }

  const saved: PortalDeliverableFeedback | undefined = submit.data;

  return (
    <section className="tm-stack tm-stack--tight" aria-label="Leave feedback on this deliverable">
      {submit.isError ? (
        <InlineAlert tone="danger" title="Could not save your feedback" live>
          {describe(submit.error)}
        </InlineAlert>
      ) : null}

      {saved ? (
        <InlineAlert tone="success" title="Thanks — your feedback was saved" live>
          You rated this deliverable {saved.rating} out of 5. You can change your rating at any
          time.
        </InlineAlert>
      ) : null}

      <fieldset className="tm-field" aria-invalid={ratingRequired ? true : undefined}>
        <legend className="tm-field__label">Your rating</legend>
        <div className="tm-row tm-row--wrap" role="radiogroup" aria-label="Rating from 1 to 5">
          {RATINGS.map((value) => (
            <Button
              key={value}
              type="button"
              tone={rating === value ? 'lime' : 'outline'}
              aria-pressed={rating === value}
              disabled={submit.isPending}
              onClick={() => setRating(value)}
            >
              {value}
            </Button>
          ))}
        </div>
        {ratingRequired ? (
          <span className="tm-field__error" role="alert">
            Choose a rating from 1 to 5.
          </span>
        ) : null}
      </fieldset>

      <label className="tm-field" htmlFor={commentId}>
        <span className="tm-field__label">A comment (optional)</span>
        <textarea
          id={commentId}
          className="tm-input"
          rows={3}
          value={comment}
          maxLength={4000}
          disabled={submit.isPending}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>

      <div className="tm-row tm-row--wrap">
        <Button
          type="button"
          tone="lime"
          loading={submit.isPending}
          disabled={submit.isPending}
          onClick={onSubmit}
        >
          {saved ? 'Update feedback' : 'Send feedback'}
        </Button>
      </div>
    </section>
  );
}

/** The shared error shapes carry a client-safe message; anything else gets a neutral fallback. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) {
    return error.message;
  }
  return 'Your feedback could not be saved. Please try again.';
}
