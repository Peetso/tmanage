'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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
import { workItemKeys } from '../../lib/query-keys';
import {
  describeDateGap,
  formatDay,
  previewClientSentence,
  triageStateLabel,
} from '../../lib/triage-presentation';
import '../../styles/screens/work-planning.css';

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
    queryKey: workItemKeys.project(organizationSlug, found?.projectId ?? ''),
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
        // A date input gives 'YYYY-MM-DD' and since 0012 that is what the API stores: a
        // calendar date, not an invented midnight for a timezone to move.
        commitment: unscheduled ? 'unscheduled' : committedDay,
      });
      queries.setQueryData(['client-request', organizationSlug, clientRequestId], result.request);
      await queries.invalidateQueries({ queryKey: ['client-requests', organizationSlug] });
      await queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
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

  const outcomeProps: OutcomeFormProps = {
    outcome,
    question,
    onQuestion: setQuestion,
    reason,
    onReason: setReason,
    scopeSummary,
    onScopeSummary: setScopeSummary,
    committedDay,
    onCommittedDay: setCommittedDay,
    unscheduled,
    onUnscheduled: setUnscheduled,
    gap,
    acceptable,
    working,
    impact: impactOf(projectWork.data ?? [], unscheduled ? null : committedDay),
    onAsk: () => {
      if (!found) return;
      void run(() =>
        transitionClientRequest(api, organizationSlug, found.id, found.version, {
          to: 'needs_clarification',
          clarificationQuestion: question.trim(),
        }),
      );
    },
    onDefer: () => {
      if (!found) return;
      void run(() =>
        transitionClientRequest(api, organizationSlug, found.id, found.version, {
          to: 'deferred',
          clientVisibleReason: reason.trim(),
        }),
      );
    },
    onDecline: () => {
      if (!found) return;
      void run(() =>
        transitionClientRequest(api, organizationSlug, found.id, found.version, {
          to: 'declined',
          clientVisibleReason: reason.trim(),
        }),
      );
    },
    onReview: () => setReviewing(true),
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={found?.title ?? 'Client request'}
      eyebrow="Request detail / Triage"
      actions={
        <Link className="wp-capsule" href={`/${organizationSlug}/work/requests`}>
          Back to the request inbox
        </Link>
      }
    >
      {request.isError ? (
        <InlineAlert tone="danger" title="Could not load this request" live>
          {describeFailure(request.error)}
        </InlineAlert>
      ) : null}

      {request.isPending ? (
        <LoadingRegion label="Loading the request.">
          <Skeleton height="56px" />
          <Skeleton height="220px" />
        </LoadingRegion>
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
          <StateTrack request={found} />

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
            <>
              <div className="wp-triage">
                <section className="wp-triage__asked" aria-labelledby="tm-triage-asked">
                  <h2 id="tm-triage-asked" className="wp-mono-label">
                    What they asked
                  </h2>
                  <p className="wp-triage__quote">&ldquo;{found.description}&rdquo;</p>
                  {found.urgencyReason !== null ? (
                    <>
                      <h3 className="wp-mono-label">Why the timing matters to them</h3>
                      <p className="wp-triage__quote">{found.urgencyReason}</p>
                    </>
                  ) : null}
                  {/*
                    §6 and CL-06 both: a desired date is a wish. The two dates sit side by side,
                    the wish in warning orange, so the screen where a promise is made is the one
                    that most plainly distinguishes them.
                  */}
                  <dl className="wp-triage__facts">
                    <div>
                      <dt>Desired</dt>
                      <dd className={found.desiredAt === null ? 'wp-unset' : 'wp-desired'}>
                        {found.desiredAt === null ? 'no date' : formatDay(found.desiredAt)}
                      </dd>
                    </div>
                    <div>
                      <dt>Committed</dt>
                      <dd className={found.commitment === 'committed' ? undefined : 'wp-unset'}>
                        {describeCommitted(found)}
                      </dd>
                    </div>
                    <div>
                      <dt>Category</dt>
                      <dd>{found.category}</dd>
                    </div>
                  </dl>
                  {found.clarificationQuestion !== null ? (
                    <section className="wp-stack" aria-labelledby="tm-triage-question">
                      <h3 id="tm-triage-question" className="wp-mono-label">
                        What was already asked
                      </h3>
                      <p className="wp-note">{found.clarificationQuestion}</p>
                    </section>
                  ) : null}
                  {found.clientVisibleReason !== null ? (
                    <section className="wp-stack" aria-labelledby="tm-triage-reason">
                      <h3 id="tm-triage-reason" className="wp-mono-label">
                        The reason the client was given
                      </h3>
                      <p className="wp-note">{found.clientVisibleReason}</p>
                    </section>
                  ) : null}
                </section>

                <TriageActions
                  request={found}
                  outcome={outcome}
                  onChoose={(next) => {
                    setOutcome(next);
                    setFailure(undefined);
                  }}
                  working={working}
                  onOpenTriage={() =>
                    void run(() =>
                      transitionClientRequest(api, organizationSlug, found.id, found.version, {
                        to: 'triage',
                      }),
                    )
                  }
                />
              </div>

              {found.state === 'triage' && outcome !== null ? (
                <OutcomeForm {...outcomeProps} />
              ) : null}
            </>
          )}

          {failure ? (
            <InlineAlert tone="danger" title="That did not go through" live>
              {failure}
            </InlineAlert>
          ) : null}
        </>
      ) : null}
    </AppShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * REQ-02's state capsule track: received (ink), where it is now (lime, stretching), and the two
 * steps still ahead (dashed). Every step is a fact the record carries — nothing is projected.
 */
function StateTrack({ request }: { request: ClientRequestRecord }) {
  const answered = ['accepted', 'planned', 'delivered'].includes(request.state);
  const planned = request.state === 'planned' || request.state === 'delivered';
  const committed = request.commitment === 'committed' && request.committedAt !== null;
  const asked = request.clarificationQuestion !== null && request.state === 'needs_clarification';

  return (
    <ol className="wp-track" aria-label="Where this request is">
      <li className="wp-track__step wp-track__step--done">
        Received {formatDay(request.createdAt)}
      </li>
      <li
        className={`wp-track__step ${answered ? 'wp-track__step--done' : 'wp-track__step--current'}`}
        aria-current={answered ? undefined : 'step'}
      >
        {triageStateLabel(request.state)}
        {asked ? ' · 1 question asked' : ''}
      </li>
      <li
        className={`wp-track__step ${
          committed
            ? planned
              ? 'wp-track__step--done'
              : 'wp-track__step--current'
            : answered && !planned
              ? 'wp-track__step--current'
              : ''
        }`}
      >
        {committed && request.committedAt !== null
          ? `Committed ${formatDay(request.committedAt)}`
          : answered
            ? 'Accepted, no date set'
            : 'Committed'}
      </li>
      <li
        className={`wp-track__step ${planned ? 'wp-track__step--current' : ''}`}
        aria-current={planned ? 'step' : undefined}
      >
        Planned
      </li>
    </ol>
  );
}

interface TriageActionsProps {
  request: ClientRequestRecord;
  outcome: Outcome;
  onChoose: (outcome: Outcome) => void;
  working: boolean;
  onOpenTriage: () => void;
}

/**
 * The four outcomes, each naming what it needs — REQ-02's right-hand column.
 *
 * Two states get a panel of their own instead, and both exist for the same reason: `23-ERD` §6
 * routes every answer through `triage`, and a manager should not have to discover that by being
 * refused. A request nobody has opened yet gets "Start triaging". A request waiting on a
 * clarification gets "The client has answered", which is the only edge §6 draws out of
 * `needs_clarification` besides the client's own withdrawal — the outcomes are hidden there
 * rather than offered and then rejected.
 */
function TriageActions({ request, outcome, onChoose, working, onOpenTriage }: TriageActionsProps) {
  if (request.state === 'submitted') {
    return (
      <section className="wp-triage__actions" aria-labelledby="tm-triage-start">
        <h2 id="tm-triage-start" className="wp-triage__heading">
          Nobody has picked this up
        </h2>
        <p>
          Opening it tells the client somebody is looking. It also means they can no longer withdraw
          it themselves — once triage has started, only somebody here can close it.
        </p>
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
      </section>
    );
  }

  if (request.state === 'needs_clarification') {
    return (
      <section className="wp-triage__actions" aria-labelledby="tm-triage-waiting">
        <h2 id="tm-triage-waiting" className="wp-triage__heading">
          Waiting on the client
        </h2>
        {/*
          The three outcomes are deliberately absent here. `23-ERD` §6 routes every answer back
          through triage — `needs_clarification` to `triage`, and only then to accepted, deferred
          or declined — so offering them in this state would render three buttons the state
          machine refuses with a 422.
        */}
        <p>
          They have been asked something, and the request sits with them until they answer. When
          their reply reaches you, record it here — committing, deferring and declining come back
          once the request is in triage again.
        </p>
        <Button
          type="button"
          tone="ink"
          size="accessible"
          loading={working}
          loadingLabel="Reopening"
          onClick={onOpenTriage}
        >
          The client has answered
        </Button>
      </section>
    );
  }

  if (request.state !== 'triage') {
    return (
      <section className="wp-triage__actions" aria-labelledby="tm-triage-closed">
        <h2 id="tm-triage-closed" className="wp-triage__heading">
          This request has been answered
        </h2>
        <p>
          It is {triageStateLabel(request.state).toLowerCase()}, and there is no move back from
          here. A client who needs something else sends a new request.
        </p>
      </section>
    );
  }

  return (
    <section className="wp-triage__actions" aria-labelledby="tm-triage-actions">
      <h2 id="tm-triage-actions" className="tm-visually-hidden">
        Answer this request
      </h2>
      <button
        type="button"
        className="wp-outcome wp-outcome--ink"
        aria-pressed={outcome === 'accept'}
        onClick={() => onChoose('accept')}
      >
        Commit with a date
      </button>
      <button
        type="button"
        className="wp-outcome wp-outcome--strong"
        aria-pressed={outcome === 'clarify'}
        onClick={() => onChoose('clarify')}
      >
        Ask another question
      </button>
      <button
        type="button"
        className="wp-outcome"
        aria-pressed={outcome === 'defer'}
        onClick={() => onChoose('defer')}
      >
        Defer with a reason
      </button>
      <button
        type="button"
        className="wp-outcome wp-outcome--danger"
        aria-pressed={outcome === 'decline'}
        onClick={() => onChoose('decline')}
      >
        Decline with a reason
      </button>
      {/* The artifact's caption, and it is the design rather than decoration. */}
      <p className="wp-caption">
        <strong>Every outcome requires a reason the client can read.</strong>
      </p>
    </section>
  );
}

interface OutcomeFormProps {
  outcome: Outcome;
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
  onAsk: () => void;
  onDefer: () => void;
  onDecline: () => void;
  onReview: () => void;
}

/** What the chosen outcome needs, beneath the REQ-02 card. */
function OutcomeForm({
  outcome,
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
  onAsk,
  onDefer,
  onDecline,
  onReview,
}: OutcomeFormProps) {
  if (outcome === 'clarify') {
    return (
      <section className="wp-outcome-form" aria-label="Ask another question">
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
      </section>
    );
  }

  if (outcome === 'defer' || outcome === 'decline') {
    return (
      <section
        className="wp-outcome-form"
        aria-label={outcome === 'defer' ? 'Defer with a reason' : 'Decline with a reason'}
      >
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
      </section>
    );
  }

  if (outcome !== 'accept') return null;

  return (
    <section className="wp-outcome-form" aria-label="Commit with a date">
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
          The client-safe scope summary. It is what the client will hold you to.
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
          The client is told you have taken it on and have not scheduled it — which is an answer,
          unlike silence.
        </span>
      </label>

      {gap ? (
        <InlineAlert tone="warning" title="That is not the date they asked for">
          {gap}
        </InlineAlert>
      ) : null}

      <p className="wp-note">Impact: {impact}</p>

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
 * REQ-03 — the promise, restated before it is made: the ink card with its lime ring, and beside
 * it the dark card with the exact sentence the client will read. The gap between their date and
 * ours is stated there, not hidden.
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
    <section className="wp-review" aria-labelledby="tm-triage-review">
      <div className="wp-review__promise">
        <p className="wp-mono-label">Commitment review</p>
        <h2 id="tm-triage-review" className="wp-review__title">
          You are about to promise a date to {request.clientOrganizationName ?? 'this client'}
        </h2>

        <dl className="wp-review__facts">
          <div>
            <dt>Scope</dt>
            <dd>{scopeSummary}</dd>
          </div>
          <div>
            <dt>Committed</dt>
            <dd>
              {commitment.kind === 'unscheduled'
                ? 'No date yet, stated'
                : formatDay(commitment.day)}
            </dd>
          </div>
          <div>
            <dt>Work</dt>
            <dd>A work item in this project, created with the acceptance</dd>
          </div>
        </dl>

        <div className="wp-review__buttons">
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
          <Button type="button" tone="outline" size="accessible" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>

      <section className="wp-review__client" aria-labelledby="tm-triage-preview">
        <h3 id="tm-triage-preview">What the client will read</h3>
        <p>&ldquo;{previewClientSentence(scopeSummary, commitment)}&rdquo;</p>
        {gap ? <p className="wp-caption">{gap} · The difference is stated, not hidden</p> : null}
      </section>
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
