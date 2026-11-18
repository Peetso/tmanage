'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, TextButton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { addRequestTag, fetchRequestTags, removeRequestTag } from '../../lib/api/request-tags';
import type { RequestTagItem } from '../../lib/api/request-tags';
import { useDescribeApiError } from '../../lib/api/describe-error';
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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
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
        {t('RequestTagsView.tags')}
      </h2>

      {tags.isError ? (
        <InlineAlert tone="danger" title={t('RequestTagsView.loadFailed')} live>
          {describeError(tags.error)}
        </InlineAlert>
      ) : null}

      {tags.isPending ? (
        <LoadingRegion label={t('RequestTagsView.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!tags.isPending && !tags.isError && rows.length === 0 ? (
        <TeachingEmptyState
          title={t('teachEmpty.requestTagsTitle')}
          explanation={t('teachEmpty.requestTagsBody')}
          action={
            canUse('client_request.triage') ? (
              <Button
                tone="lime"
                size="accessible"
                onClick={() => focusFirstField(firstStep.current)}
              >
                {t('teachEmpty.requestTagsAction')}
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-tag-list" aria-label={t('RequestTagsView.listLabel')}>
          {rows.map((tag) => (
            <li key={tag.id} className="tm-tag-chip">
              <span>{tag.label}</span>
              <TextButton
                type="button"
                size="compact"
                onClick={() => {
                  if (!remove.isPending) remove.mutate(tag.id);
                }}
                aria-label={`${t('RequestTagsView.removeTagPrefix')}${tag.label}`}
              >
                {t('RequestTagsView.remove')}
              </TextButton>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        ref={firstStep}
        className="tm-row"
        noValidate
        aria-label={t('RequestTagsView.addFormLabel')}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (trimmed !== '' && !add.isPending) add.mutate(trimmed);
        }}
      >
        <Field
          label={t('RequestTagsView.newTag')}
          name="request-tag-label"
          value={label}
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
          hint={t('RequestTagsView.newTagHint')}
        />
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          disabled={trimmed === ''}
          loading={add.isPending}
          loadingLabel={t('RequestTagsView.adding')}
        >
          {t('RequestTagsView.addTag')}
        </Button>
      </form>

      {add.isError ? (
        <InlineAlert tone="danger" title={t('RequestTagsView.addFailed')} live>
          {describeError(add.error)}
        </InlineAlert>
      ) : null}
      {remove.isError ? (
        <InlineAlert tone="danger" title={t('RequestTagsView.removeFailed')} live>
          {describeError(remove.error)}
        </InlineAlert>
      ) : null}
    </section>
  );
}
