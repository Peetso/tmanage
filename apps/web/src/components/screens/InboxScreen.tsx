'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CLIENT_REQUEST_STATES, WORK_ITEM_STATES } from '@tmanage/domain';
import type { ClientRequestState, WorkItemState } from '@tmanage/domain';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { DEFAULT_INBOX_PAGE, listInbox, markBundleRead } from '../../lib/api/inbox';
import type { InboxBundle, InboxMode } from '../../lib/api/inbox';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { formatInstant, stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import { triageStateCapsule, triageStateLabel } from '../../lib/triage-presentation';

export interface InboxScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **TM-04 Inbox** — `22-SCREEN-BY-SCREEN` §TM-04, `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §4
 * (`IN-01` through `IN-04`), and the Inbox part of `WEB-010 Home/Inbox/Search/Admin screens`,
 * over the first half of `INBOX-001`.
 *
 * ## The four modes are the API's, not the screen's
 *
 * `REQ-01` filters a list it already holds, so its buttons carry counts. This screen cannot: a
 * mode is a different query — `waiting_on_me` is a different `WHERE`, and `important` is
 * decided by what each bundle contains after the API has resolved it — so switching a mode
 * refetches, and the buttons say what they are without a number the page does not know. A
 * count for a mode not on screen would be a count the API never gave.
 *
 * ## What a row says, and what it does not
 *
 * A bundle is one object and every notification about it. The row shows the object's title
 * and current state — both read by the API through the object's own authorized path at the
 * moment of the request, which is why a bundle about something this person may no longer see
 * never arrives here — the number of updates, how many are unread, and the latest time. The
 * "why" is the event type, said in words: `Blocked`, `Client submitted a request`. Nothing
 * ranks, scores or reorders: `35-NOTIFICATION-AND-EMAIL-COPY` §4's `Due today` and
 * `Blocks 2 people` need facts no notification row carries and no endpoint yet computes.
 *
 * ## One inline action, reauthorized where it runs
 *
 * "Mark read" is the one action TM-04 has today. It posts to the API, which re-reads the
 * object before it writes anything, exactly as the list does; the screen offers the button
 * and then asks the list again rather than pretending it knows the outcome.
 */
export function InboxScreen({ organizationSlug, organizationName, client }: InboxScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<InboxMode>('all');

  const inbox = useInfiniteQuery({
    queryKey: ['inbox', organizationSlug, mode],
    queryFn: ({ pageParam }) =>
      listInbox(api, organizationSlug, {
        mode,
        limit: DEFAULT_INBOX_PAGE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const markRead = useMutation({
    mutationFn: (bundleId: string) => markBundleRead(api, organizationSlug, bundleId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inbox', organizationSlug] }),
  });

  const bundles = mergePages(inbox.data?.pages.map((page) => page.items) ?? []);

  // A mode is a different list. A "could not mark that read" about a row of the old list
  // would otherwise stay on screen above rows it does not name.
  const selectMode = (next: InboxMode) => {
    markRead.reset();
    setMode(next);
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      title="Inbox"
      description={`What has happened to the work you are part of at ${organizationName}.`}
    >
      {inbox.isError ? (
        <InlineAlert tone="danger" title="Could not load the inbox" live>
          {describe(inbox.error)}
        </InlineAlert>
      ) : null}

      {markRead.isError ? (
        <InlineAlert tone="danger" title="Could not mark that read" live>
          {describe(markRead.error)}
        </InlineAlert>
      ) : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-inbox-modes">
        <h2 id="tm-inbox-modes" className="tm-eyebrow">
          Show
        </h2>
        <div className="tm-row tm-row--wrap" role="group" aria-label="Inbox mode">
          {MODES.map((candidate) => (
            <ModeButton
              key={candidate.id}
              id={candidate.id}
              label={candidate.label}
              active={mode === candidate.id}
              onSelect={selectMode}
            />
          ))}
        </div>
      </section>

      {inbox.isPending ? (
        <LoadingRegion label="Loading the inbox.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {/*
        "Nothing" is only said when the API has said it: a page can come back short — every
        bundle on it dropped because its object is no longer this person's to see — while a
        cursor beneath it says there is more. That is "nothing on this page", not "nothing".
      */}
      {!inbox.isPending && !inbox.isError && bundles.length === 0 && !inbox.hasNextPage ? (
        <InlineAlert tone="neutral" title={EMPTY_TITLES[mode]}>
          <p className="tm-prose">{EMPTY_BODIES[mode]}</p>
        </InlineAlert>
      ) : null}

      {!inbox.isPending && !inbox.isError && bundles.length === 0 && inbox.hasNextPage ? (
        <p className="tm-prose">Nothing you can still see on this page. There are older pages.</p>
      ) : null}

      {bundles.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow
          // columns (WCAG 2.2 2.1.1); the .tm-table-scroll CSS comment states the same.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Notification bundles"
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Notification bundles, most recently touched first. One row per object; each links to
              the object.
            </caption>
            <thead>
              <tr>
                <th scope="col">About</th>
                <th scope="col">State</th>
                <th scope="col">Updates</th>
                <th scope="col">Latest</th>
                <th scope="col">
                  <span className="tm-visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((bundle) => (
                <tr key={bundle.bundleId}>
                  <th scope="row">
                    <Link href={hrefOf(organizationSlug, bundle)}>{bundle.title}</Link>
                    <span className="tm-field__hint">{describeWhy(bundle)}</span>
                  </th>
                  <td>
                    <StateCapsule state={capsuleOf(bundle)}>{labelOf(bundle)}</StateCapsule>
                  </td>
                  <td>
                    {bundle.count} {bundle.count === 1 ? 'update' : 'updates'}
                    {bundle.unreadCount > 0 ? (
                      <span className="tm-field__hint">{bundle.unreadCount} unread</span>
                    ) : null}
                  </td>
                  <td>{formatInstant(bundle.latestAt)}</td>
                  <td>
                    {bundle.unreadCount > 0 ? (
                      <Button
                        tone="outline"
                        size="accessible"
                        loading={markRead.isPending && markRead.variables === bundle.bundleId}
                        loadingLabel="Marking read"
                        aria-label={`Mark read: ${bundle.title}`}
                        onClick={() => markRead.mutate(bundle.bundleId)}
                      >
                        Mark read
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {inbox.hasNextPage ? (
        <div className="tm-row">
          <Button
            tone="outline"
            size="accessible"
            loading={inbox.isFetchingNextPage}
            loadingLabel="Loading more"
            onClick={() => void inbox.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}

      {/*
        WCAG 2.2 4.1.3: "Load more" appends rows to a table that is in no live region, so a
        screen-reader user hears nothing when a page arrives. Announcing the running total into
        the shell's live region tells them the press did something.
      */}
      <Announce
        message={
          (inbox.data?.pages.length ?? 0) > 1 && !inbox.isFetchingNextPage
            ? `${bundles.length} ${bundles.length === 1 ? 'notification' : 'notifications'} loaded in total.`
            : ''
        }
      />

      <BackendPending ticket="INBOX-001">
        Quiet hours, digests and channel preferences are not built: there is nowhere to store a
        preference yet. There is no screen for a group of related events either, so a row links
        straight to the thing it is about. Marking read is permanent &mdash; there is no undo
        interval.
      </BackendPending>
    </AppShell>
  );
}

const MODES: readonly { readonly id: InboxMode; readonly label: string }[] = [
  { id: 'important', label: 'Important' },
  { id: 'all', label: 'All' },
  { id: 'waiting_on_me', label: 'Waiting on me' },
  { id: 'client_actions', label: 'Client actions' },
];

const EMPTY_TITLES: Record<InboxMode, string> = {
  important: 'Nothing important is waiting',
  all: 'Nothing has happened yet',
  waiting_on_me: 'Nothing is unread',
  client_actions: 'No client has acted recently',
};

const EMPTY_BODIES: Record<InboxMode, string> = {
  important: 'Important means a blocker on work you own. There is none right now.',
  all: 'Notifications arrive here when something happens to work you are part of, or when a client submits a request you can triage.',
  waiting_on_me: 'Everything that reached you has been read.',
  client_actions: 'A client submitting a request shows up here.',
};

/** The event types this half of INBOX-001 knows, said in words. Unknown types are shown as is. */
const WHY: Record<string, string> = {
  'work_item.blocked.v1': 'Blocked',
  'client_request.submitted.v1': 'Client submitted a request',
  'client_request.transitioned.v1': 'Request answered',
};

function describeWhy(bundle: InboxBundle): string {
  const words = bundle.types.map((type) => WHY[type] ?? type);
  const kind = bundle.objectType === 'work_item' ? 'Work item' : 'Client request';
  return `${kind} · ${words.join(', ')}`;
}

/**
 * The API bundles one page at a time, so an object whose rows straddle a page boundary
 * arrives twice — once per page, each with its own count. Two rows with one bundle id is two
 * React keys that collide and a title a reader sees twice, so the pages are folded into one
 * list here: counts add, unread counts add, types union, the newest time wins, and the row
 * keeps the place of its first (newest) appearance.
 */
function mergePages(pages: readonly (readonly InboxBundle[])[]): readonly InboxBundle[] {
  const byId = new Map<string, InboxBundle>();
  for (const page of pages) {
    for (const bundle of page) {
      const seen = byId.get(bundle.bundleId);
      if (!seen) {
        byId.set(bundle.bundleId, bundle);
        continue;
      }
      const types = [...seen.types];
      for (const type of bundle.types) if (!types.includes(type)) types.push(type);
      byId.set(bundle.bundleId, {
        ...seen,
        count: seen.count + bundle.count,
        unreadCount: seen.unreadCount + bundle.unreadCount,
        types,
        latestAt: seen.latestAt >= bundle.latestAt ? seen.latestAt : bundle.latestAt,
      });
    }
  }
  return [...byId.values()];
}

function hrefOf(organizationSlug: string, bundle: InboxBundle): string {
  return bundle.objectType === 'work_item'
    ? `/${organizationSlug}/work/${bundle.objectId}`
    : `/${organizationSlug}/work/requests/${bundle.objectId}`;
}

/**
 * The state came through the object's own read, so it is one of that object's states — but the
 * wire type is a string, and a guard is cheaper than trusting it. An unknown state is shown
 * verbatim in a neutral capsule rather than crashing the row.
 */
function capsuleOf(bundle: InboxBundle): CapsuleState {
  if (bundle.objectType === 'work_item' && isWorkItemState(bundle.state)) {
    return stateCapsule(bundle.state);
  }
  if (bundle.objectType === 'client_request' && isClientRequestState(bundle.state)) {
    return triageStateCapsule(bundle.state);
  }
  return 'neutral';
}

function labelOf(bundle: InboxBundle): string {
  if (bundle.objectType === 'work_item' && isWorkItemState(bundle.state)) {
    return stateLabel(bundle.state);
  }
  if (bundle.objectType === 'client_request' && isClientRequestState(bundle.state)) {
    return triageStateLabel(bundle.state);
  }
  return bundle.state;
}

function isWorkItemState(value: string): value is WorkItemState {
  return (WORK_ITEM_STATES as readonly string[]).includes(value);
}

function isClientRequestState(value: string): value is ClientRequestState {
  return (CLIENT_REQUEST_STATES as readonly string[]).includes(value);
}

interface ModeButtonProps {
  id: InboxMode;
  label: string;
  active: boolean;
  onSelect: (id: InboxMode) => void;
}

/**
 * `aria-pressed` rather than a tab set, for `REQ-01`'s reason: the table beneath is the same
 * table, differently filtered, not a panel swap.
 */
function ModeButton({ id, label, active, onSelect }: ModeButtonProps) {
  return (
    <button
      type="button"
      className="tm-button tm-button--outline"
      aria-pressed={active}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
