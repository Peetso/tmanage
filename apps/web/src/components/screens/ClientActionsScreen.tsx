'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listClientRequests, listPortalProjects, listPortalWorkItems } from '../../lib/api/portal';
import type { PortalWorkItem } from '../../lib/api/portal';
import { isWaitingOnClient } from '../../lib/client-request-presentation';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { isPast, longDay, Segmented, shortDay, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';

export interface ClientActionsScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
  /** Injected in tests so "overdue" is decided against a fixed day. */
  now?: Date;
}

type View = 'needs' | 'studio' | 'done';

/**
 * **CL-02 My Actions.**
 *
 * `22-SCREEN-BY-SCREEN` §6: "Ordered cards: approval, feedback, upload, answer, client task.
 * Each shows why, due, consequence, estimated review time. **Empty state confirms notification
 * behavior.**"
 *
 * Drawn as the handoff's CL-02: a headline that counts what needs the client, the "Needs you /
 * Waiting on the studio / Done" switch, one capsule card per item with the soonest outlined in
 * ink, and the "waiting on the studio" strip along the bottom.
 *
 * Two kinds of card exist: a question the studio asked on one of the client's requests (an
 * *answer*), and a work item the studio marked as needing the client (a *client task*). They are
 * kept as two lists because they are answered in different places. Estimated review time and
 * consequence are not carried by the projection, so the cards do not show them rather than
 * guessing.
 *
 * Ordering is by due date, soonest first, undated last — the only order a client can verify
 * from what is on the card.
 */
export function ClientActionsScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
  now = new Date(),
}: ClientActionsScreenProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const [view, setView] = useState<View>('needs');

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const workItems = useQuery({
    queryKey: ['portal-work-items', organizationSlug],
    queryFn: () => listPortalWorkItems(api, organizationSlug),
  });

  const requests = useQuery({
    queryKey: ['portal-requests', organizationSlug],
    queryFn: () => listClientRequests(api, organizationSlug),
  });

  /**
   * `clarifying` is the only status where a request is the client's to move — and the state that
   * carries the `client_action_required` audience on the row.
   */
  const awaitingAnswer = (requests.data ?? []).filter(isWaitingOnClient);

  const all = (workItems.data ?? []).slice().sort(byDueDate);
  const actions = all.filter((item) => item.progress === 'waiting_on_you');
  const studio = all.filter((item) => item.progress === 'in_progress');
  const done = all.filter((item) => item.progress === 'done');

  const project = projects.data?.[0];
  // REQ-06: the list spans every shared project, so naming only the first in the heading is
  // wrong. With more than one project it says "All projects"; with exactly one it keeps its name.
  const projectCount = (projects.data ?? []).length;
  const actionsEyebrow =
    projectCount > 1
      ? 'What needs you · All projects'
      : project
        ? `What needs you · ${project.name}`
        : 'What needs you';
  const needCount = actions.length + awaitingAnswer.length;
  const settled = !workItems.isPending && !workItems.isError && !requests.isPending;

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="actions"
      title={settled ? headline(needCount) : 'My actions'}
      eyebrow={actionsEyebrow}
      headerAside={
        <Segmented<View>
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { id: 'needs', label: `Needs you · ${needCount}` },
            { id: 'studio', label: `Waiting on the studio · ${studio.length}` },
            { id: 'done', label: `Done · ${done.length}` },
          ]}
        />
      }
    >
      <div className="tm-pt tm-pt--compact">
        {workItems.isError ? (
          <InlineAlert tone="danger" title="Could not load your actions" live>
            {describe(workItems.error)}
          </InlineAlert>
        ) : null}

        {workItems.isPending ? (
          <LoadingRegion label="Loading your actions.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {view === 'needs' ? (
          <>
            {settled && needCount === 0 ? (
              <div className="tm-pt-card tm-pt-card--dashed tm-pt-card--lg">
                <div className="tm-pt-aside-row">
                  <span className="tm-pt-orb tm-pt-orb--md" aria-hidden="true">
                    ✓
                  </span>
                  <div className="tm-pt-item__main">
                    <h2 className="tm-pt-card__title">Nothing is waiting on you</h2>
                    <p className="tm-pt-card__body">
                      You are up to date. When {providerName} needs something from you it will
                      appear here, and you will be told — you do not have to keep checking this
                      page.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {awaitingAnswer.length > 0 ? (
              <ul className="tm-pt-list" aria-label="Questions to answer">
                {awaitingAnswer.map((request, index) => (
                  <li
                    key={request.id}
                    className={
                      index === 0 && actions.length === 0
                        ? 'tm-pt-action tm-pt-action--lead'
                        : 'tm-pt-action'
                    }
                  >
                    <span className="tm-pt-action__orb" aria-hidden="true">
                      ?
                    </span>
                    <div className="tm-pt-action__body">
                      <div className="tm-pt-action__meta">
                        <Tag tone="lime">Waiting on you</Tag>
                        <span className="tm-pt-mono">Asked by {providerName}</span>
                      </div>
                      <h2 className="tm-pt-action__title">
                        <Link href={`/${organizationSlug}/portal/requests/${request.id}`}>
                          {request.title}
                        </Link>
                      </h2>
                      {/* The studio wrote the question down: the one "why" this card can carry. */}
                      <p className="tm-pt-action__text">
                        {request.clarificationQuestion ??
                          `${providerName} has asked you something about this request.`}
                      </p>
                    </div>
                    <div className="tm-pt-action__end">
                      <Link
                        className="tm-pt-btn tm-pt-btn--ink"
                        href={`/${organizationSlug}/portal/requests/${request.id}`}
                        aria-label={`Answer: ${request.title}`}
                      >
                        Answer
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            {actions.length > 0 ? (
              <ul className="tm-pt-list" aria-label="Your actions">
                {actions.map((action, index) => (
                  <li
                    key={action.id}
                    className={index === 0 ? 'tm-pt-action tm-pt-action--lead' : 'tm-pt-action'}
                  >
                    <span className="tm-pt-action__orb" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div className="tm-pt-action__body">
                      <div className="tm-pt-action__meta">
                        {action.dueAt === null ? (
                          <Tag>No deadline</Tag>
                        ) : (
                          <Tag tone={index === 0 ? 'lime' : undefined}>
                            {index === 0 ? 'By' : 'Needed by'} {shortDay(action.dueAt)}
                          </Tag>
                        )}
                        {isOverdue(action, now) ? <Tag tone="danger">Past its date</Tag> : null}
                        <span className="tm-pt-mono">Waiting on you</span>
                      </div>
                      <h2 className="tm-pt-action__title">{action.title}</h2>
                      <p className="tm-pt-action__text">{describeDue(action.dueAt)}</p>
                    </div>
                    <div className="tm-pt-action__end">
                      <Link
                        className="tm-pt-btn"
                        href={`/${organizationSlug}/portal/requests/new?about=${encodeURIComponent(
                          action.title,
                        )}&project=${encodeURIComponent(action.projectId)}`}
                        aria-label={`Ask about: ${action.title}`}
                      >
                        Ask about this
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <ItemList
            label={view === 'studio' ? 'Waiting on the studio' : 'Done'}
            items={view === 'studio' ? studio : done}
            empty={
              view === 'studio'
                ? `Nothing is with ${providerName} at the moment.`
                : 'Nothing has been finished yet.'
            }
            done={view === 'done'}
          />
        )}

        {studio.length > 0 ? (
          <div className="tm-pt-foot">
            <span className="tm-pt-eyebrow">Waiting on the studio</span>
            <ul>
              {studio.slice(0, 2).map((item, index) => (
                <li key={item.id} className="tm-pt-aside-row">
                  {index > 0 ? <span className="tm-pt-foot__sep" aria-hidden="true" /> : null}
                  {item.title}
                  {item.dueAt ? ` · expected ${shortDay(item.dueAt)}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </ClientPortalShell>
  );
}

function ItemList({
  label,
  items,
  empty,
  done,
}: {
  label: string;
  items: readonly PortalWorkItem[];
  empty: string;
  done: boolean;
}) {
  if (items.length === 0) {
    return <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">{empty}</p>;
  }
  return (
    <ul className="tm-pt-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className="tm-pt-action">
          <span className="tm-pt-action__orb" aria-hidden="true">
            {done ? '✓' : '…'}
          </span>
          <div className="tm-pt-action__body">
            <div className="tm-pt-action__meta">
              <Tag tone={done ? 'done' : undefined}>{done ? 'Done' : 'In progress'}</Tag>
              {item.dueAt ? (
                <span className="tm-pt-mono">
                  {done ? 'Due' : 'Expected'} {shortDay(item.dueAt)}
                </span>
              ) : null}
            </div>
            <h2 className="tm-pt-action__title">{item.title}</h2>
          </div>
        </li>
      ))}
    </ul>
  );
}

const COUNT_WORDS = ['Nothing', 'One thing', 'Two things', 'Three things', 'Four things'];

function headline(count: number): string {
  if (count === 0) return 'Nothing needs you';
  const words = COUNT_WORDS[count] ?? `${count} things`;
  return `${words} need${count === 1 ? 's' : ''} you`;
}

/** Undated last: a missing date is not urgency, and sorting it first would invent some. */
function byDueDate(left: PortalWorkItem, right: PortalWorkItem): number {
  if (left.dueAt === right.dueAt) return 0;
  if (left.dueAt === null) return 1;
  if (right.dueAt === null) return -1;
  return left.dueAt < right.dueAt ? -1 : 1;
}

function isOverdue(item: PortalWorkItem, now: Date): boolean {
  return isPast(item.dueAt, now);
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}

function describeDue(value: string | null): string {
  if (value === null) return 'No date has been set for this.';
  return `Needed by ${longDay(value)}.`;
}
