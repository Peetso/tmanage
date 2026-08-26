'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalProjects, listPortalWorkItems } from '../../lib/api/portal';
import type { PortalWorkItem } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ClientActionsScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
  /** Injected in tests so "overdue" is decided against a fixed day. */
  now?: Date;
}

/**
 * **CL-02 My Actions.**
 *
 * `22-SCREEN-BY-SCREEN` §6: "Ordered cards: approval, feedback, upload, answer, client task.
 * Each shows why, due, consequence, estimated review time. **Empty state confirms notification
 * behavior.**"
 *
 * ## What is here and what is honestly not
 *
 * The five card *types* do not exist yet. An approval is `APPR-001`, a feedback request is
 * `REQ-002`, an upload is `FILE-001` — none of them has storage, so there is nothing to sort
 * into five kinds. What does exist is `client_action_required`, which is the audience that
 * says "this one is waiting on the client", and every card on this screen is one of those.
 *
 * "Why", "consequence" and "estimated review time" are three fields the projection does not
 * carry and no table holds. They are named in `BackendPending` rather than filled with
 * plausible sentences: a portal that told a client the consequence of missing a date, and
 * invented it, is worse than one that says it does not know yet.
 *
 * ## The empty state is the specification's, not a shrug
 *
 * "Empty state confirms notification behavior." A client with nothing to do needs to know that
 * this screen being empty means nothing is waiting — and that they will be told rather than
 * expected to keep checking. That sentence is the empty state's whole job, so it says both
 * halves plainly.
 *
 * ## Ordering
 *
 * By due date, soonest first, with undated items last. §6 asks for "ordered cards" without
 * saying by what; the only ordering this screen can honestly apply is the one the client can
 * verify from what is on the card. Anything else — urgency, importance — would be an internal
 * judgement the projection does not carry.
 */
export function ClientActionsScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
  now = new Date(),
}: ClientActionsScreenProps) {
  const api = client ?? browserApiClient();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const workItems = useQuery({
    queryKey: ['portal-work-items', organizationSlug],
    queryFn: () => listPortalWorkItems(api, organizationSlug),
  });

  const actions = (workItems.data ?? [])
    .filter((item) => item.progress === 'waiting_on_you')
    .slice()
    .sort(byDueDate);

  const project = projects.data?.[0];

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(project ? { projectName: project.name } : {})}
      activeNavigationId="actions"
      title="My actions"
      description={`Everything ${providerName} is waiting on you for.`}
    >
      {workItems.isError ? (
        <InlineAlert tone="danger" title="Could not load your actions" live>
          {describe(workItems.error)}
        </InlineAlert>
      ) : null}

      {workItems.isPending ? (
        <div aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading your actions.</span>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </div>
      ) : null}

      {!workItems.isPending && !workItems.isError && actions.length === 0 ? (
        <InlineAlert tone="success" title="Nothing is waiting on you">
          <p className="tm-prose">
            You are up to date. When {providerName} needs something from you it will appear here,
            and you will be told — you do not have to keep checking this page.
          </p>
        </InlineAlert>
      ) : null}

      {actions.length > 0 ? (
        <ul className="tm-stack tm-list" aria-label="Your actions">
          {actions.map((action) => (
            <li key={action.id} className="tm-panel tm-stack tm-stack--tight">
              <div className="tm-row tm-row--wrap">
                <StateCapsule state="client">Waiting on you</StateCapsule>
                {isOverdue(action, now) ? (
                  <StateCapsule state="blocked">Past its date</StateCapsule>
                ) : null}
              </div>
              <p className="tm-prose">
                <strong>{action.title}</strong>
              </p>
              <p className="tm-prose">{describeDue(action.dueAt)}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <BackendPending ticket="APPR-001 · REQ-002 · FILE-001">
        Approvals, feedback requests and uploads are not built, so every card here is the one kind
        that exists: something {providerName} has marked as needing you. Why it needs you, what
        happens if it waits, and how long a review usually takes are three things nothing records
        yet — they are missing rather than guessed at.
      </BackendPending>
    </ClientPortalShell>
  );
}

/** Undated last: a missing date is not urgency, and sorting it first would invent some. */
function byDueDate(left: PortalWorkItem, right: PortalWorkItem): number {
  if (left.dueAt === right.dueAt) return 0;
  if (left.dueAt === null) return 1;
  if (right.dueAt === null) return -1;
  return left.dueAt < right.dueAt ? -1 : 1;
}

function isOverdue(item: PortalWorkItem, now: Date): boolean {
  if (item.dueAt === null) return false;
  const due = new Date(item.dueAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < now.getTime();
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}

function describeDue(value: string | null): string {
  if (value === null) return 'No date has been set for this.';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `Needed by ${new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(parsed)}`;
}
