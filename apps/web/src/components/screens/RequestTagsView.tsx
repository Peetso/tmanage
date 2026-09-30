'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, TextButton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { addRequestTag, fetchRequestTags, removeRequestTag } from '../../lib/api/request-tags';
import type { RequestTagItem } from '../../lib/api/request-tags';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface RequestTagsViewProps {
  organizationSlug: string;
  clientRequestId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Request tags** — the free-text triage labels on a client request (x316, Requests module 11),
 * rendered as chips with add / remove on the internal request-detail surface. It reads
 * `GET /v1/organizations/:orgSlug/client-requests/:id/tags` (gated on the server by
 * `client_request.triage`) and writes with the matching `POST` / `DELETE`.
 *
 * The decisions are the sibling triage surfaces':
 * 1. **Authorization is the API's.** A caller without `client_request.triage` gets the ordinary 403,
 *    which `describe()` turns into a sentence in the panel's own alert; the view never guesses a
 *    capability of its own and never renders blank on a refusal.
 * 2. **The server owns validation.** An empty / over-length label is a 400 and a duplicate a 409,
 *    both surfaced from the server rather than re-implemented here; the input only trims and bounds
 *    for the member's convenience.
 */
export function RequestTagsView({
  organizationSlug,
  clientRequestId,
  client,
}: RequestTagsViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['request-tags', organizationSlug, clientRequestId];

  const tags = useQuery({
    queryKey,
    queryFn: () => fetchRequestTags(api, organizationSlug, clientRequestId),
  });

  const [label, setLabel] = useState('');

  const add = useMutation({
    mutationFn: (value: string) => addRequestTag(api, organizationSlug, clientRequestId, value),
    onSuccess: async () => {
      setLabel('');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (tagId: string) => removeRequestTag(api, organizationSlug, clientRequestId, tagId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const rows: readonly RequestTagItem[] = tags.data?.tags ?? [];
  const trimmed = label.trim();

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-request-tags-heading">
      <h2 id="tm-request-tags-heading" className="tm-eyebrow">
        Tags
      </h2>

      {tags.isError ? (
        <InlineAlert tone="danger" title="Could not load the tags" live>
          {describeError(tags.error)}
        </InlineAlert>
      ) : null}

      {tags.isPending ? (
        <LoadingRegion label="Loading the tags.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!tags.isPending && !tags.isError && rows.length === 0 ? (
        <p className="tm-muted">No tags yet.</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-tag-list" aria-label="Tags on this request">
          {rows.map((tag) => (
            <li key={tag.id} className="tm-tag-chip">
              <span>{tag.label}</span>
              <TextButton
                type="button"
                size="compact"
                onClick={() => {
                  if (!remove.isPending) remove.mutate(tag.id);
                }}
                aria-label={`Remove tag ${tag.label}`}
              >
                Remove
              </TextButton>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        className="tm-row"
        noValidate
        aria-label="Add a tag"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (trimmed !== '' && !add.isPending) add.mutate(trimmed);
        }}
      >
        <Field
          label="New tag"
          name="request-tag-label"
          value={label}
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
          hint="A short free-text label. It is added once; duplicates are ignored."
        />
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          disabled={trimmed === ''}
          loading={add.isPending}
          loadingLabel="Adding"
        >
          Add tag
        </Button>
      </form>

      {add.isError ? (
        <InlineAlert tone="danger" title="Could not add the tag" live>
          {describeError(add.error)}
        </InlineAlert>
      ) : null}
      {remove.isError ? (
        <InlineAlert tone="danger" title="Could not remove the tag" live>
          {describeError(remove.error)}
        </InlineAlert>
      ) : null}
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
