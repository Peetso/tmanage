'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  acceptClientRequest,
  getClientRequestRecord,
  transitionClientRequest,
} from '../../lib/api/client-requests';
import type { ClientRequestRecord } from '../../lib/api/client-requests';
import { listWorkItems } from '../../lib/api/work-items';
import type { WorkItemSummary } from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  describeDateGap,
  formatDay,
  previewClientSentence,
  triageStateCapsule,
  triageStateLabel,
} from '../../lib/triage-presentation';

export interface RequestTriageScreenProps {
  organizationSlug: string;
  organizationName: string;
  clientRequestId: string;
  client?: ApiClient;
}

/** Which of the four outcomes the manager is composing. `null` is the page at rest. */
type Outcome = 'clarify' | 'accept' | 'defer' | 'decline' | null;

/**
 * **REQ-02 Request detail / triage** and **REQ-03 Commitment review** —
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §8, and the second half of `WEB-005`.
 *
 * The artifact's four actions are "Commit with a date · Ask another question · Defer with a
 * reason · Decline with a reason", under a caption that is the whole design: **"EVERY OUTCOME
 * REQUIRES A REASON THE CLIENT CAN READ."** Every one of the four names what it needs in its own
 * label, so a manager knows the cost of an outcome before choosing it rather than after.
 *
 * That requirement is not this screen's to enforce. `23-ERD` §6 attaches the facts to the moves
 * and `clientRequestStateMachine` refuses a move that arrives without them, so the labels here
 * describe a rule that already holds — which is the right relationship between a screen and a
 * lifecycle, and the opposite of a form that is the only thing standing between a user and a
 * bad row.
 *
 * ## Accepting is two steps, because it is a promise
 *
 * `REQ-03 Commitment review` is a separate artboard headed "You are about to promise a date to
 * Atlas Hospitality", and it earns the extra click. An acceptance creates work, commits a date
 * and tells a client — `REQ-002` makes all three one transaction — and the review shows exactly
 * **what the client will read** before any of it happens.
 *
 * It also states the gap. The artifact is emphatic: "10 SEP ≠ THEIR DESIRED 3 SEP · THE
 * DIFFERENCE IS STATED, NOT HIDDEN". A manager promising a later date than the one asked for
 * should see that sentence while they can still change the date.
 *
 * ## The schedule impact is real or it is absent
 *
 * `WEB-005`'s name includes "schedule impact" and the artifact draws "Impact: collides with
 * Content migration, which already forecasts 8 Sep". Milestones do not exist, and **no ticket
 * in `28-SPRINT-TICKETS` schedules them** — they appear in `07-DATA-MODEL` and in `PRJ-02` and
 * nowhere in the plan's own backlog. Nothing models capacity either, so an impact line here
 * would be invented.
 *
 * What this screen shows instead is a **fact it can check**: the work already due in the same
 * project in the week around the date being promised, counted from `work_items.due_at`. It is
 * labelled as what it is, and the collision analysis the artifact draws is named as missing.
 * A count a manager can verify beats a warning they cannot.
 */
export function RequestTriageScreen({
  organizationSlug,
  organizationName,
  clientRequestId,
  client,
}: RequestTriageScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [outcome, setOutcome] = useState<Outcome>(null);
  const [question, setQuestion] = useState('');
  const [reason, setReason] = useState('');
  const [scopeSummary, setScopeSummary] = useState('');
  const [committedDay, setCommittedDay] = useState('');
  const [unscheduled, setUnscheduled] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [accepted, setAccepted] = useState<{ workItemId: string; created: boolean } | undefined>(
    undefined,
  );

  const request = useQuery({
    queryKey: ['client-request', organizationSlug, clientRequestId],
    queryFn: () => getClientRequestRecord(api, organizationSlug, clientRequestId),
  });

  const found = request.data;

  // The project's other dated work, for the impact count. Fetched only once there is a project
  // to ask about, and used for nothing else.
  const projectWork = useQuery({
    queryKey: ['work-items', organizationSlug, found?.projectId ?? ''],
    queryFn: () => listWorkItems(api, organizationSlug, { projectId: found?.projectId ?? '' }),
    enabled: found !== undefined,
  });

  function reset() {
    setOutcome(null);
    setReviewing(false);
    setFailure(undefined);
    setQuestion('');
    setReason('');
    setScopeSummary('');
    setCommittedDay('');
    setUnscheduled(false);
  }

  async function run(work: () => Promise<ClientRequestRecord>) {
    setFailure(undefined);
    setWorking(true);
    try {
      const updated = await work();
      queries.setQueryData(['client-request', organizationSlug, clientRequestId], updated);
      await queries.invalidateQueries({ queryKey: ['client-requests', organizationSlug] });
      reset();
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setWorking(false);
    }
  }

  async function commit() {
    if (!found) return;
    setFailure(undefined);
    setWorking(true);
    try {
      const result = await acceptClientRequest(api, organizationSlug, found.id, {
        version: found.version,
        clientSafeScopeSummary: scopeSummary.trim(),
        commitment: unscheduled ? 'unscheduled' : `${committedDay}T00:00:00.000Z`,
      });
      queries.setQueryData(['client-request', organizationSlug, clientRequestId], result.request);
      await queries.invalidateQueries({ queryKey: ['client-requests', organizationSlug] });
      await queries.invalidateQueries({ queryKey: ['work-items', organizationSlug] });
      setAccepted({ workItemId: result.workItemId, created: result.workItemCreated });
      reset();
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setWorking(false);
    }
  }

  const commitment = unscheduled
    ? ({ kind: 'unscheduled' } as const)
    : ({ kind: 'committed', day: committedDay } as const);
  const gap = unscheduled ? null : describeDateGap(found?.desiredAt ?? null, committedDay || null);
  const acceptable = scopeSummary.trim() !== '' && (unscheduled || committedDay !== '');

  return (
    <AppShell
      organizationName={organizationName}
      activeNavigationId="work"
      title={found?.title ?? 'Client request'}
      description={
        found
          ? `From ${found.clientOrganizationName ?? 'a client'} · received ${formatDay(found.createdAt)}`
          : undefined
      }
    >
      <p className="tm-prose">
        <Link href={`/${organizationSlug}/work/requests`}>Back to the request inbox</Link>
      </p>

      {request.isError ? (
        <InlineAlert tone="danger" title="Could not load this request" live>
          {describeFailure(request.error)}
        </InlineAlert>
      ) : null}

      {request.isPending ? (
        <div aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading the request.</span>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </div>
      ) : null}

      {accepted ? (
        <InlineAlert tone="success" title="Accepted, and the work is committed" live>
          <p className="tm-prose">
            {accepted.created
              ? 'A work item was created in the same transaction as the acceptance.'
              : 'The request was linked to work that already existed.'}{' '}
            <Link href={`/${organizationSlug}/work/${accepted.workItemId}`}>
              Open the work item
            </Link>
          </p>
        </InlineAlert>
      ) : null}

      {found ? (
        <>
          <section className="tm-panel tm-stack" aria-labelledby="tm-triage-state">
            <h2 id="tm-triage-state" className="tm-eyebrow">
              Where this request is
            </h2>
            <div className="tm-row tm-row--wrap">
              <StateCapsule state={triageStateCapsule(found.state)}>
                {triageStateLabel(found.state)}
              </StateCapsule>
            </div>
            <dl className="tm-detail-list">
              <div className="tm-detail-list__pair">
                <dt>They asked for</dt>
                <dd>{found.desiredAt === null ? 'no date' : formatDay(found.desiredAt)}</dd>
              </div>
              <div className="tm-detail-list__pair">
                <dt>Committed</dt>
                <dd>{describeCommitted(found)}</dd>
              </div>
            </dl>
            {/*
              §6 and CL-06 both: a desired date is a wish. Said on this side too, because the
              screen where a promise is made is the one that most needs to distinguish them.
            */}
            <p className="tm-field__hint">
              A desired date is what the client asked for. It becomes a commitment only when
              somebody here accepts the request and names one.
            </p>
          </section>

          <section className="tm-panel tm-stack" aria-labelledby="tm-triage-asked">
            <h2 id="tm-triage-asked" className="tm-eyebrow">
              What they asked
            </h2>
            <p className="tm-prose">{found.description}</p>
            {found.urgencyReason !== null ? (
              <>
                <h3 className="tm-eyebrow">Why the timing matters to them</h3>
                <p className="tm-prose">{found.urgencyReason}</p>
              </>
            ) : null}
            <p className="tm-field__hint">Category: {found.category}</p>
          </section>

          {found.clarificationQuestion !== null ? (
            <section className="tm-panel tm-stack" aria-labelledby="tm-triage-question">
              <h2 id="tm-triage-question" className="tm-eyebrow">
                What was already asked
              </h2>
              <p className="tm-prose">{found.clarificationQuestion}</p>
            </section>
          ) : null}

          {found.clientVisibleReason !== null ? (
            <section className="tm-panel tm-stack" aria-labelledby="tm-triage-reason">
              <h2 id="tm-triage-reason" className="tm-eyebrow">
                The reason the client was given
              </h2>
              <p className="tm-prose">{found.clientVisibleReason}</p>
            </section>
          ) : null}

          {failure ? (
            <InlineAlert tone="danger" title="That did not go through" live>
              {failure}
            </InlineAlert>
          ) : null}

          {reviewing ? (
            <CommitmentReview
              request={found}
              scopeSummary={scopeSummary}
              commitment={commitment}
              gap={gap}
              working={working}
              onBack={() => setReviewing(false)}
              onCommit={() => void commit()}
            />
          ) : (
            <TriageActions
              request={found}
              outcome={outcome}
              onChoose={(next) => {
                setOutcome(next);
                setFailure(undefined);
              }}
              question={question}
              onQuestion={setQuestion}
              reason={reason}
              onReason={setReason}
              scopeSummary={scopeSummary}
              onScopeSummary={setScopeSummary}
              committedDay={committedDay}
              onCommittedDay={setCommittedDay}
              unscheduled={unscheduled}
              onUnscheduled={setUnscheduled}
              gap={gap}
              acceptable={acceptable}
              working={working}
              impact={impactOf(projectWork.data ?? [], unscheduled ? null : committedDay)}
              onOpenTriage={() =>
                void run(() =>
                  transitionClientRequest(api, organizationSlug, found.id, found.version, {
                    to: 'triage',
                  }),
                )
              }
              onAsk={() =>
                void run(() =>
                  transitionClientRequest(api, organizationSlug, found.id, found.version, {
                    to: 'needs_clarification',
                    clarificationQuestion: question.trim(),
                  }),
                )
              }
              onDefer={() =>
                void run(() =>
                  transitionClientRequest(api, organizationSlug, found.id, found.version, {
                    to: 'deferred',
                    clientVisibleReason: reason.trim(),
                  }),
                )
              }
              onDecline={() =>
                void run(() =>
                  transitionClientRequest(api, organizationSlug, found.id, found.version, {
                    to: 'declined',
                    clientVisibleReason: reason.trim(),
                  }),
                )
              }
              onReview={() => setReviewing(true)}
            />
          )}

          <BackendPending ticket="CHAT-001 · FILE-001 · milestones, unscheduled">
            The design draws a collision warning — &ldquo;collides with Content migration, which
            already forecasts 8 Sep&rdquo; — a discussion thread, the client&rsquo;s own request
            history, and a duplicate suggestion. Milestones, messaging and files are not built, and
            nothing models capacity or similarity. What is above the actions instead is a count of
            work already due that week, which is a fact this system can check.
          </BackendPending>
        </>
      ) : null}
    </AppShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface TriageActionsProps {
  request: ClientRequestRecord;
  outcome: Outcome;
  onChoose: (outcome: Outcome) => void;
  question: string;
  onQuestion: (value: string) => void;
  reason: string;
  onReason: (value: string) => void;
  scopeSummary: string;
  onScopeSummary: (value: string) => void;
  committedDay: string;
  onCommittedDay: (value: string) => void;
  unscheduled: boolean;
  onUnscheduled: (value: boolean) => void;
  gap: string | null;
  acceptable: boolean;
  working: boolean;
  impact: string;
  onOpenTriage: () => void;
  onAsk: () => void;
  onDefer: () => void;
  onDecline: () => void;
  onReview: () => void;
}

/**
 * The four outcomes, each naming what it needs.
 *
 * A request nobody has opened yet gets a fifth control — "Start triaging" — because §6 routes
 * every answer through `triage` and a manager should not have to discover that by being refused.
 */
function TriageActions({
  request,
  outcome,
  onChoose,
  question,
  onQuestion,
  reason,
  onReason,
  scopeSummary,
  onScopeSummary,
  committedDay,
  onCommittedDay,
  unscheduled,
  onUnscheduled,
  gap,
  acceptable,
  working,
  impact,
  onOpenTriage,
  onAsk,
  onDefer,
  onDecline,
  onReview,
}: TriageActionsProps) {
  const open = request.state === 'triage' || request.state === 'needs_clarification';

  if (request.state === 'submitted') {
    return (
      <section className="tm-panel tm-stack" aria-labelledby="tm-triage-start">
        <h2 id="tm-triage-start" className="tm-eyebrow">
          Nobody has picked this up
        </h2>
        <p className="tm-prose">
          Opening it tells the client somebody is looking. It also means they can no longer withdraw
          it themselves — <code>23-ERD</code> §6 draws no way out of triage for them.
        </p>
        <div className="tm-row">
          <Button
            type="button"
            tone="ink"
            size="accessible"
            loading={working}
            loadingLabel="Opening"
            onClick={onOpenTriage}
          >
            Start triaging
          </Button>
        </div>
      </section>
    );
  }

  if (!open) {
    return (
      <section className="tm-panel tm-stack" aria-labelledby="tm-triage-closed">
        <h2 id="tm-triage-closed" className="tm-eyebrow">
          This request has been answered
        </h2>
        <p className="tm-prose">
          It is {triageStateLabel(request.state).toLowerCase()}, and §6 has no move back from here.
          A client who needs something else sends a new request.
        </p>
      </section>
    );
  }

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-triage-actions">
      <h2 id="tm-triage-actions" className="tm-eyebrow">
        Answer this request
      </h2>
      {/* The artifact's caption, and it is the design rather than decoration. */}
      <p className="tm-prose">
        <strong>Every outcome requires a reason the client can read.</strong>
      </p>

      <div className="tm-row tm-row--wrap">
        <Button type="button" tone="ink" onClick={() => onChoose('accept')}>
          Commit with a date
        </Button>
        <Button type="button" tone="outline" onClick={() => onChoose('clarify')}>
          Ask another question
        </Button>
        <Button type="button" tone="outline" onClick={() => onChoose('defer')}>
          Defer with a reason
        </Button>
        <Button type="button" tone="destructive" onClick={() => onChoose('decline')}>
          Decline with a reason
        </Button>
      </div>

      {outcome === 'clarify' ? (
        <div className="tm-stack">
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-triage-question-field">
              What do you need to know?
            </label>
            <textarea
              id="tm-triage-question-field"
              className="tm-field__control tm-field__control--multiline"
              rows={3}
              value={question}
              onChange={(event) => onQuestion(event.target.value)}
              aria-describedby="tm-triage-question-hint"
            />
            <span className="tm-field__hint" id="tm-triage-question-hint">
              The client reads this word for word, and the request waits for them until they answer.
            </span>
          </div>
          <div className="tm-row">
            <Button
              type="button"
              tone="ink"
              loading={working}
              loadingLabel="Sending"
              disabled={question.trim() === ''}
              onClick={onAsk}
            >
              Ask the client
            </Button>
          </div>
        </div>
      ) : null}

      {outcome === 'defer' || outcome === 'decline' ? (
        <div className="tm-stack">
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-triage-reason-field">
              {outcome === 'defer' ? 'Why not now?' : 'Why not at all?'}
            </label>
            <textarea
              id="tm-triage-reason-field"
              className="tm-field__control tm-field__control--multiline"
              rows={3}
              value={reason}
              onChange={(event) => onReason(event.target.value)}
              aria-describedby="tm-triage-reason-hint"
            />
            <span className="tm-field__hint" id="tm-triage-reason-hint">
              This is shown to the client as your answer. Write it for them, not for the team.
            </span>
          </div>
          <div className="tm-row">
            <Button
              type="button"
              tone={outcome === 'decline' ? 'destructive' : 'ink'}
              loading={working}
              loadingLabel="Sending"
              disabled={reason.trim() === ''}
              onClick={outcome === 'defer' ? onDefer : onDecline}
            >
              {outcome === 'defer' ? 'Defer this request' : 'Decline this request'}
            </Button>
          </div>
        </div>
      ) : null}

      {outcome === 'accept' ? (
        <div className="tm-stack">
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-triage-scope-field">
              What are you agreeing to do?
            </label>
            <textarea
              id="tm-triage-scope-field"
              className="tm-field__control tm-field__control--multiline"
              rows={3}
              value={scopeSummary}
              onChange={(event) => onScopeSummary(event.target.value)}
              aria-describedby="tm-triage-scope-hint"
            />
            <span className="tm-field__hint" id="tm-triage-scope-hint">
              §6 calls this the client-safe scope summary. It is what the client will hold you to.
            </span>
          </div>

          <Field
            label="Committed date"
            name="committedDay"
            type="date"
            value={committedDay}
            onChange={(event) => onCommittedDay(event.target.value)}
            dir="ltr"
            disabled={unscheduled}
            hint="A promise, not an estimate. The client sees this one as agreed."
          />

          <label className="tm-choice tm-choice--inline">
            <input
              className="tm-choice__input"
              type="checkbox"
              checked={unscheduled}
              onChange={(event) => onUnscheduled(event.target.checked)}
            />
            <span className="tm-choice__name">Accept without a date yet</span>
            <span className="tm-choice__detail">
              §6 allows an explicit unscheduled state. The client is told you have taken it on and
              have not scheduled it — which is an answer, unlike silence.
            </span>
          </label>

          {gap ? (
            <InlineAlert tone="warning" title="That is not the date they asked for">
              {gap}
            </InlineAlert>
          ) : null}

          <InlineAlert tone="neutral" title="What else is due that week">
            {impact}
          </InlineAlert>

          <div className="tm-row">
            <Button
              type="button"
              tone="ink"
              size="accessible"
              disabled={!acceptable}
              onClick={onReview}
            >
              Review the commitment
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface CommitmentReviewProps {
  request: ClientRequestRecord;
  scopeSummary: string;
  commitment: { kind: 'committed'; day: string } | { kind: 'unscheduled' };
  gap: string | null;
  working: boolean;
  onBack: () => void;
  onCommit: () => void;
}

/**
 * **REQ-03 Commitment review.** The last thing before a promise.
 *
 * Its heading is the artifact's, in the second person and naming the client, because a manager
 * about to commit a date is doing something to somebody rather than filling in a form. The panel
 * below shows the sentence the client will read, built from the same two fields the API is about
 * to store, so what is previewed cannot drift from what is written.
 */
function CommitmentReview({
  request,
  scopeSummary,
  commitment,
  gap,
  working,
  onBack,
  onCommit,
}: CommitmentReviewProps) {
  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-triage-review">
      <h2 id="tm-triage-review" className="tm-eyebrow">
        You are about to promise a date to {request.clientOrganizationName ?? 'this client'}
      </h2>

      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Scope</dt>
          <dd>{scopeSummary}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Committed</dt>
          <dd>
            {commitment.kind === 'unscheduled' ? 'No date yet, stated' : formatDay(commitment.day)}
          </dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Work</dt>
          <dd>A work item in this project, created with the acceptance</dd>
        </div>
      </dl>

      {gap ? (
        <InlineAlert tone="warning" title="The difference is stated, not hidden">
          {gap}
        </InlineAlert>
      ) : null}

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-triage-preview">
        <h3 id="tm-triage-preview" className="tm-eyebrow">
          What the client will read
        </h3>
        <p className="tm-prose">{previewClientSentence(scopeSummary, commitment)}</p>
      </section>

      <div className="tm-row">
        <Button
          type="button"
          tone="ink"
          size="accessible"
          loading={working}
          loadingLabel="Committing"
          onClick={onCommit}
        >
          Commit and tell the client
        </Button>
        <Button type="button" tone="outline" onClick={onBack}>
          Back
        </Button>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * What else is already due in this project in the week around a proposed date.
 *
 * A count of rows, not a capacity judgement, and the wording says so. Milestones are what the
 * artifact's collision warning needs; they do not exist and no ticket schedules them. This is the
 * honest thing that can be computed from `work_items.due_at` today.
 */
function impactOf(workItems: readonly WorkItemSummary[], committedDay: string | null): string {
  if (committedDay === null || committedDay === '') {
    return 'Pick a date to see what else this project already owes around it.';
  }

  const target = new Date(`${committedDay}T00:00:00.000Z`).getTime();
  if (Number.isNaN(target)) return 'That is not a date this can be checked against.';

  const week = 3.5 * 86_400_000;
  const near = workItems.filter((item) => {
    if (item.dueAt === null || item.deletedAt !== null) return false;
    const due = new Date(item.dueAt).getTime();
    return !Number.isNaN(due) && Math.abs(due - target) <= week;
  });

  if (near.length === 0) {
    return 'Nothing else in this project is due within three days either side of that date.';
  }
  return `${near.length} other ${near.length === 1 ? 'item is' : 'items are'} already due within three days either side of that date: ${near
    .map((item) => item.title)
    .join(
      ', ',
    )}. This is a count of dated work, not a check of anybody's capacity — nothing in this system models that yet.`;
}

function describeCommitted(request: ClientRequestRecord): string {
  if (request.commitment === 'committed' && request.committedAt !== null) {
    return formatDay(request.committedAt);
  }
  if (request.commitment === 'unscheduled') return 'accepted, no date set';
  return 'not set';
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 409) {
      return 'Somebody changed this request while you were reading it. Reload the page to see where it is now.';
    }
    return error.message;
  }
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
