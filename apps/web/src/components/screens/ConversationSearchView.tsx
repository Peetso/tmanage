'use client';

import { Fragment, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, SearchField, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { searchConversationMessages } from '../../lib/api/conversation-search';
import type { MessageSearchMatch } from '../../lib/api/conversation-search';
import type { ApiClient } from '../../lib/api/client';

/**
 * **CH-10 Search in conversation** (x253). A search field over one channel's messages, and the
 * matches it returns — author, time and a snippet with the term highlighted.
 *
 * The conversation id is in the path for the reason the channel screen's is: it is not a
 * credential. The API resolves the conversation and applies `conversation.read` before it reads
 * anything, so a channel in another tenant answers 404 exactly as one that does not exist — and
 * the snippet is built server-side over non-moderated messages only, so nothing withheld is
 * drawn here. A blank query shows nothing rather than the whole transcript.
 */

export interface ConversationSearchViewProps {
  organizationSlug: string;
  organizationName: string;
  conversationId: string;
  /** A test seam, as every screen has: the running app passes the browser client. */
  client?: ApiClient;
}

/** Split a snippet on the term (case-insensitively) and wrap the matches in `<mark>`. */
function highlight(snippet: string, term: string): ReactNode {
  const needle = term.trim();
  if (needle === '') return snippet;
  const lowerSnippet = snippet.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let found = lowerSnippet.indexOf(lowerNeedle, cursor);
  let key = 0;
  while (found !== -1) {
    if (found > cursor) parts.push(<Fragment key={key++}>{snippet.slice(cursor, found)}</Fragment>);
    parts.push(<mark key={key++}>{snippet.slice(found, found + needle.length)}</mark>);
    cursor = found + needle.length;
    found = lowerSnippet.indexOf(lowerNeedle, cursor);
  }
  if (cursor < snippet.length) parts.push(<Fragment key={key++}>{snippet.slice(cursor)}</Fragment>);
  return parts;
}

export function ConversationSearchView({
  organizationSlug,
  organizationName,
  conversationId,
  client,
}: ConversationSearchViewProps) {
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');

  const query = useQuery({
    queryKey: ['conversation-search', organizationSlug, conversationId, term],
    enabled: term.trim() !== '',
    queryFn: () =>
      searchConversationMessages(api, organizationSlug, conversationId, { q: term }),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTerm(draft);
  }

  const results: readonly MessageSearchMatch[] = query.data ?? [];
  const hasSearched = term.trim() !== '';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="chat"
      title="Search this conversation"
      description="Find messages in this channel. Only messages you can read are searched."
    >
      <form onSubmit={onSubmit} role="search" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
        <SearchField
          label="Search this conversation"
          labelVisible
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Search messages…"
        />
        <Button type="submit">Search</Button>
      </form>

      {query.isError ? (
        <InlineAlert tone="danger" heading="That search could not be run">
          Try again, or reload the channel.
        </InlineAlert>
      ) : null}

      {hasSearched && query.isPending ? (
        <LoadingRegion label="Searching this conversation">
          <Skeleton />
          <Skeleton />
        </LoadingRegion>
      ) : null}

      {hasSearched && !query.isPending && !query.isError && results.length === 0 ? (
        <p>No messages match that search.</p>
      ) : null}

      {results.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.75rem' }}>
          {results.map((match) => (
            <li key={match.id}>
              <p style={{ margin: 0, fontSize: '0.85em', opacity: 0.75 }}>
                <span>{match.authorUserId}</span>
                {' · '}
                <time dateTime={match.createdAt}>{new Date(match.createdAt).toLocaleString()}</time>
              </p>
              <p style={{ margin: '0.25rem 0 0' }}>{highlight(match.snippet, term)}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </AppShell>
  );
}
