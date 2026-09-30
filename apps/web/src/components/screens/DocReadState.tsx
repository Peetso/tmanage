'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getDocReadState, markDocRead, markDocUnread } from '../../lib/api/doc-read-state';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

/** One document the screen shows a read/unread state for. The caller supplies the list it can read. */
export interface DocReadStateRowInput {
  readonly id: string;
  readonly title: string;
}

export interface DocReadStateScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The documents to show read state for — the caller's readable document list. */
  documents: readonly DocReadStateRowInput[];
  client?: ApiClient;
}

/**
 * **DOC read state (x297).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs — a read/unread view over a document list. It batch-reads
 * the caller's own read state for the supplied documents and shows a "New" badge on the ones the caller
 * has not marked read. Each row toggles its own read state; a "Mark all read" affordance marks every
 * shown-unread document read, driven client-side over the read-state endpoint.
 *
 * ## What it does, and what it cannot
 *
 * - **The state is the caller's own.** The API scopes the batch read to the acting membership; there is
 *   no view of another member's read state.
 * - **Documents come from the caller.** This screen renders read state over a document list it is given;
 *   it does not itself list documents.
 */
export function DocReadStateScreen({
  organizationSlug,
  organizationName,
  documents,
  client,
}: DocReadStateScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const documentIds = useMemo(() => documents.map((doc) => doc.id), [documents]);

  const readState = useQuery({
    queryKey: ['doc-read-state', organizationSlug, documentIds],
    queryFn: () => getDocReadState(api, organizationSlug, documentIds),
    enabled: documentIds.length > 0,
  });

  const readByDocId = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of readState.data ?? []) {
      map.set(entry.docId, entry.lastReadAt);
    }
    return map;
  }, [readState.data]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['doc-read-state', organizationSlug] });

  const toggle = useMutation({
    mutationFn: async (input: { documentId: string; read: boolean }) => {
      if (input.read) {
        await markDocUnread(api, organizationSlug, input.documentId);
      } else {
        await markDocRead(api, organizationSlug, input.documentId);
      }
    },
    onSuccess: invalidate,
  });

  const markAll = useMutation({
    mutationFn: async () => {
      const unread = documents.filter((doc) => !readByDocId.has(doc.id));
      // Sequential so a partial failure leaves a consistent, re-runnable state rather than racing.
      for (const doc of unread) {
        await markDocRead(api, organizationSlug, doc.id);
      }
    },
    onSuccess: invalidate,
  });

  const unreadCount = documents.filter((doc) => !readByDocId.has(doc.id)).length;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title="Document read state"
      description="Which documents are new since you last looked. Mark documents read or unread; this state is only yours."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-read-state-heading">
        <div className="tm-row tm-row--between">
          <h2 id="tm-read-state-heading" className="tm-eyebrow">
            Your read state
          </h2>
          <Button
            type="button"
            tone="ink"
            size="accessible"
            loading={markAll.isPending}
            loadingLabel="Marking"
            disabled={readState.isPending || unreadCount === 0}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </Button>
        </div>

        {readState.isError ? (
          <InlineAlert tone="danger" title="Could not load your read state" live>
            {describeError(readState.error)}
          </InlineAlert>
        ) : null}

        {toggle.isError || markAll.isError ? (
          <InlineAlert tone="danger" title="Could not update read state" live>
            {describeError(toggle.error ?? markAll.error)}
          </InlineAlert>
        ) : null}

        {readState.isPending && documentIds.length > 0 ? (
          <LoadingRegion label="Loading your read state.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {documents.length === 0 ? (
          <InlineAlert tone="neutral" title="No documents">
            There are no documents to show read state for.
          </InlineAlert>
        ) : null}

        {documents.length > 0 && !readState.isPending ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the other screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Documents and read state"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Your documents and whether you have read them, {unreadCount} unread.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">State</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => {
                  const read = readByDocId.has(doc.id);
                  return (
                    <tr key={doc.id}>
                      <th scope="row" className="tm-table__title">
                        {doc.title}
                      </th>
                      <td>
                        {read ? (
                          <Badge tone="neutral">Read</Badge>
                        ) : (
                          <Badge tone="client">New</Badge>
                        )}
                      </td>
                      <td>
                        <Button
                          type="button"
                          tone={read ? 'outline' : 'ink'}
                          size="accessible"
                          aria-pressed={read}
                          loading={toggle.isPending && toggle.variables?.documentId === doc.id}
                          loadingLabel={read ? 'Updating' : 'Updating'}
                          onClick={() => toggle.mutate({ documentId: doc.id, read })}
                        >
                          {read ? 'Mark unread' : 'Mark read'}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
