'use client';

import { Fragment, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { searchConversationMessages } from '../../lib/api/conversation-search';
import type { MessageSearchMatch } from '../../lib/api/conversation-search';
import type { ApiClient } from '../../lib/api/client';
import { getConversation } from '../../lib/api/conversations';
import { useMembers } from '../../lib/use-members';
import '../../styles/screens/chat.css';

/**
 * **CH-10 Search in conversation** (x253). A search field over one channel's messages, and the
 * matches it returns — author, time and a snippet with the term highlighted.
 *
 * The conversation id is in the path for the reason the channel screen's is: it is not a
 * credential. The API resolves the conversation and applies `conversation.read` before it reads
 * anything, so a channel in another tenant answers 404 exactly as one that does not exist — and
 * the snippet is built server-side over non-moderated messages only, so nothing withheld is
 * drawn here. A blank query shows nothing rather than the whole transcript. Painted as the
 * handoff's CH-10: the quoted term as the title, the lime-ringed search capsule with its match
 * count, and one card per match.
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

function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (words.length >= 2) return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function formatStamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(parsed);
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

  const conversation = useQuery({
    queryKey: ['conversation', organizationSlug, conversationId],
    queryFn: () => getConversation(api, organizationSlug, conversationId),
  });

  const query = useQuery({
    queryKey: ['conversation-search', organizationSlug, conversationId, term],
    enabled: term.trim() !== '',
    queryFn: () => searchConversationMessages(api, organizationSlug, conversationId, { q: term }),
  });

  // Author names from the member directory; an id it does not know keeps its short form.
  const directory = useMembers(api, organizationSlug);
  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const member of directory.members ?? []) byId.set(member.userId, member.displayName);
    return byId;
  }, [directory.members]);
  const nameOf = (userId: string) => names.get(userId) ?? userId.slice(0, 8);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTerm(draft);
  }

  const results: readonly MessageSearchMatch[] = query.data ?? [];
  const hasSearched = term.trim() !== '';
  const channel = conversation.data ? `#${conversation.data.name}` : 'this channel';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="chat"
      eyebrow={`Search in ${channel}`}
      title={hasSearched ? `“${term.trim()}”` : 'Search this conversation'}
      description={
        <>
          Only messages you can read are searched.{' '}
          <Link href={`/${organizationSlug}/chat/${conversationId}`}>Back to {channel}</Link>
        </>
      }
    >
      <div className="tm-chat-search">
        <form onSubmit={onSubmit} role="search" className="tm-chat-search__field">
          <span aria-hidden="true" className="tm-chat-mono">
            ⌕
          </span>
          <label htmlFor="tm-chat-search-q" className="tm-visually-hidden">
            Search this conversation
          </label>
          <input
            id="tm-chat-search-q"
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder="Search messages…"
          />
          {hasSearched && query.data ? (
            <span className="tm-chat-search__count" aria-live="polite">
              {results.length === 1 ? '1 match' : `${results.length} matches`}
            </span>
          ) : null}
          <button type="submit" className="tm-chat-send">
            <span className="tm-chat-send__orb" aria-hidden="true">
              ⌕
            </span>
            Search
          </button>
        </form>

        {query.isError ? (
          <InlineAlert tone="danger" title="That search could not be run" live>
            Try again, or reload the channel.
          </InlineAlert>
        ) : null}

        {hasSearched && query.isPending ? (
          <LoadingRegion label="Searching this conversation">
            <Skeleton />
            <Skeleton />
          </LoadingRegion>
        ) : null}

        {!hasSearched ? (
          <p className="tm-chat-empty">
            <span>
              <strong>Search {channel}</strong>
              Type a word and press Enter. Matches show who said it, when, and the words around it.
            </span>
          </p>
        ) : null}

        {hasSearched && !query.isPending && !query.isError && results.length === 0 ? (
          <p className="tm-chat-empty">
            <span>
              <strong>No messages match that search.</strong>
              Removed messages are never searched, and nothing outside this channel is.
            </span>
          </p>
        ) : null}

        {results.length > 0 ? (
          <ul className="tm-chat-search__results" aria-label="Matches">
            {results.map((match) => (
              <li key={match.id} className="tm-chat-result">
                <div className="tm-chat-result__head">
                  <span className="tm-chat-orb tm-chat-orb--md" aria-hidden="true">
                    {initialsOf(nameOf(match.authorUserId))}
                  </span>
                  <span>{nameOf(match.authorUserId)}</span>
                  <time className="tm-chat-mono" dateTime={match.createdAt}>
                    {formatStamp(match.createdAt)}
                  </time>
                </div>
                <p className="tm-chat-result__body">
                  <Link href={`/${organizationSlug}/chat/${conversationId}#message-${match.id}`}>
                    {highlight(match.snippet, term)}
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </AppShell>
  );
}
