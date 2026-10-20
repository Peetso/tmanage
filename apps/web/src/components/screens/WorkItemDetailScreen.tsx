'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { workItemStateMachine } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { MemberSelect } from '../MemberSelect';
import { WorkItemDependenciesScreen } from './WorkItemDependenciesScreen';
import './work-core.css';
import { WorkChecklistPanel } from './WorkChecklistPanel';
import { WorkCommentsPanel } from './WorkCommentsPanel';
import { WorkWatchersPanel } from './WorkWatchersPanel';
import { browserApiClient } from '../../lib/api/browser-client';
import { getWorkItem, transitionWorkItem, updateWorkItem } from '../../lib/api/work-items';
import type { WorkItemAudience, WorkItemSummary } from '../../lib/api/work-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { workItemKeys } from '../../lib/query-keys';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { useRecordRecentItem } from '../../lib/use-record-recent-item';
import {
  audienceLabel,
  formatDay,
  formatInstant,
  isClientFacing,
  isOverdue,
  stateCapsule,
  stateLabel,
} from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { WorkItemTagsAndFiles } from './WorkItemTagsAndFiles';

export interface WorkItemDetailScreenProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
}

/** The label a person reads for each fact the machine can require. */
const FACT_LABEL: Record<string, string> = {
  blockerReason: 'What is blocking this',
  blockerAsk: 'What you need, and from whom',
  blockerOwnerUserId: 'Who the ask is on',
  blockerResolution: 'How it was resolved',
  ownerId: 'Who owned this to completion',
  completedAt: 'When it was completed',
  reopenReason: 'Why it is being reopened',
};

const FACT_HINT: Record<string, string> = {
  blockerReason: 'Plain words. This is read by whoever picks the item up next.',
  blockerAsk: 'The specific thing that would unblock it, and who can give it.',
  blockerOwnerUserId:
    'Optional. The member who can act on the ask, so the blocker shows up in their list rather than only in prose.',
  blockerResolution: 'What actually changed. "Resolved" on its own tells nobody anything.',
  ownerId:
    'The person accountable for it, not whoever moved the card. Filled in with the current owner when there is one.',
  completedAt: 'When the work was actually finished, which need not be right now.',
  reopenReason: 'What was wrong with it. This is the record when a deliverable comes back.',
};

/**
 * The facts that name a person — D16.
 *
 * Each of these is stored as a `user_id`, and each was asked for as a text box a person had
 * to paste a UUID into. They are the two fields the finding is about, and they are listed
 * here rather than detected by name-shape so that a third one is a decision somebody makes
 * rather than a regex that happens to match.
 */
const MEMBER_FACTS: readonly string[] = ['ownerId', 'blockerOwnerUserId'];

/**
 * `completedAt` is asked for with a date-and-time control rather than as an ISO string a
 * person would have to type. The control speaks the browser's local time without a zone;
 * `toIsoInstant` turns what it holds back into the UTC instant the API stores, and
 * `toLocalControlValue` does the reverse for the default the field opens with.
 */
function toLocalControlValue(instant: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}

function toIsoInstant(controlValue: string): string {
  const parsed = new Date(controlValue);
  return Number.isNaN(parsed.getTime()) ? controlValue : parsed.toISOString();
}

/** Facts whose wire form differs from what the control holds. Everything else travels as typed. */
function factsForWire(
  facts: Readonly<Record<string, string>>,
  optional: readonly string[],
): Record<string, string> {
  const wire: Record<string, string> = {};
  for (const [key, value] of Object.entries(facts)) {
    // An optional fact left blank is not sent at all. The API would otherwise read an empty
    // owner as "the member whose id is the empty string", and refuse.
    if (optional.includes(key) && value.trim() === '') continue;
    wire[key] = key === 'completedAt' ? toIsoInstant(value) : value;
  }
  return wire;
}

/**
 * **TM-13 Work item detail.**
 *
 * `22-SCREEN-BY-SCREEN` §5: "Header: type/title/state/audience; fields; description;
 * checklist; dependencies/blocker; source; discussion; files; decisions; activity. Transition
 * presents only fields required for next state. Internal notes are separate objects, never
 * hidden client comments."
 *
 * ## The sentence this screen exists to honour
 *
 * "Transition presents only fields required for next state." The form below asks
 * `workItemStateMachine` two questions — which states can be reached from this one, and what
 * does *this particular* move require — and renders exactly that. Nothing here restates the
 * lifecycle. If §5 gains a transition or a requirement tomorrow, this screen asks for the new
 * fact without being edited, and the one place the rule is written stays the one place.
 *
 * The server validates the same facts through the same machine, so this form is a courtesy
 * rather than a gate: it exists so a person is not refused for a fact they were never asked
 * for. A screen that guessed at the requirements would eventually guess wrong, and the
 * refusal would arrive with the fields already filled in.
 *
 * ## The version, and what happens when somebody else wins
 *
 * Every write carries the version this screen read. When the API answers `409` *for the
 * version* — the envelope names the `version` field — the screen says so in the words of
 * what actually happened — someone else changed it, your change was not applied, here is the
 * current state — and refetches. It does not retry. A retry with a fresh version is precisely
 * the lost update the token exists to prevent, and doing it automatically would make the
 * protection ornamental. A `409` that names no field is a different refusal (today: the item
 * already has an active blocker) and is shown in the API's words, because "reload and try
 * again" is advice that cannot help it.
 *
 * ## What `done` costs, and where it goes
 *
 * §5 makes `done` cost an owner and a completion time, and since 0013 both are stored: the
 * owner on the row's `ownerUserId`, the time on `completedAt`, which this screen then shows
 * as "Completed". The owner field opens filled with the item's current owner and the time
 * with now; both can be changed before the move is made.
 *
 * ## What is not here
 *
 * Description, checklist, dependencies, source, discussion, decisions and activity are each
 * their own object and their own ticket. None is drawn as an empty section: an empty heading
 * looks like an item with nothing in it rather than a feature that does not exist.
 * `BackendPending` names them once, plainly. Labels and attached files are shown, read-only
 * ({@link WorkItemTagsAndFiles}) — they are what the New work capsule adds to an item.
 */
export function WorkItemDetailScreen({
  organizationSlug,
  organizationName,
  workItemId,
  client,
}: WorkItemDetailScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const item = useQuery({
    queryKey: ['work-item', organizationSlug, workItemId],
    queryFn: () => getWorkItem(api, organizationSlug, workItemId),
  });

  useRecordRecentItem({
    organizationSlug,
    objectType: 'work',
    objectId: workItemId,
    enabled: item.isSuccess,
    client,
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow="Work item"
      title={item.data?.title ?? 'Work item'}
    >
      {item.isPending ? (
        <LoadingRegion label="Loading this work item.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {item.isError ? (
        <InlineAlert tone="danger" title="Could not load this work item" live>
          {item.error instanceof ApiRequestError
            ? item.error.message
            : item.error instanceof NetworkError
              ? 'The API did not answer. Is it running?'
              : 'Something went wrong. Try again.'}
        </InlineAlert>
      ) : null}

      {item.data ? (
        <WorkItemBody
          item={item.data}
          api={api}
          organizationSlug={organizationSlug}
          onChanged={(next) => {
            queries.setQueryData(['work-item', organizationSlug, workItemId], next);
            void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
          }}
          onConflict={() => {
            void item.refetch();
          }}
        />
      ) : null}
    </AppShell>
  );
}

interface WorkItemBodyProps {
  item: WorkItemSummary;
  api: ApiClient;
  organizationSlug: string;
  onChanged: (next: WorkItemSummary) => void;
  onConflict: () => void;
}

function WorkItemBody({ item, api, organizationSlug, onChanged, onConflict }: WorkItemBodyProps) {
  const [target, setTarget] = useState<WorkItemState | ''>('');
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const [missing, setMissing] = useState<readonly string[]>([]);
  const [pendingAudience, setPendingAudience] = useState<WorkItemAudience | undefined>(undefined);

  // D16. One query for both the owner line and the pickers, so the name a person reads above
  // and the name they choose below can never come from two different answers. `memberSearch`
  // is what a picker last typed: the roster is longer than one page in any real organization,
  // so the search that finds somebody has to reach the server rather than the page already in
  // hand. `useMembers` merges each answer into what is known, so neither the owner line nor a
  // field already filled in changes because somebody typed in a picker.
  const [memberSearch, setMemberSearch] = useState('');
  const directory = useMembers(api, organizationSlug, memberSearch);

  const reachable = workItemStateMachine.allowedFrom(item.state);
  const required = target === '' ? [] : workItemStateMachine.requirementsFor(item.state, target);
  const optional = target === '' ? [] : workItemStateMachine.optionalFor(item.state, target);

  function describe(error: unknown): string {
    if (error instanceof ApiRequestError) return error.message;
    if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
    return 'Something went wrong. Try again.';
  }

  /**
   * A `409` is its own outcome, not a failure message — when it is the version token's. The
   * API answers 409 for two different things: the item changed since this screen read it,
   * which the envelope says by naming the `version` field, and "this item already has an
   * active blocker", which names no field because no field of the request was wrong. Only
   * the first is "somebody else changed this first"; telling a person to reload for the
   * second would send them round a loop that ends where it started. Any other 409 is shown
   * in the API's own words.
   */
  function handleWriteError(error: unknown) {
    if (error instanceof ApiRequestError && error.status === 409) {
      if (error.fieldErrors().has('version')) {
        setConflict(true);
        setFailure(undefined);
        // The move and its facts were composed against the row that has just been
        // superseded — an owner seeded from a stale item would otherwise ride the next
        // attempt over a colleague's change with a fresh version, which is the lost update
        // the banner tells the reader to avoid. Re-pick against the reloaded row.
        setTarget('');
        setFacts({});
        setMissing([]);
        onConflict();
        return;
      }
      setConflict(false);
      setFailure(error.message);
      return;
    }
    if (error instanceof ApiRequestError && error.status === 422) {
      // The machine's own refusal, which names what it wanted. CQ-07 (WRK-07): a known
      // transition fact is shown by its human label (`FACT_LABEL`) rather than its schema
      // token, so the list says which field is missing in plain words. The server stays
      // authoritative about *which* facts are missing; only the word a person reads is the
      // screen's. An unrecognised field keeps the server's `field: message`.
      setMissing(
        [...error.fieldErrors().entries()].map(
          ([field, message]) => FACT_LABEL[field] ?? `${field}: ${message}`,
        ),
      );
      setFailure(error.message);
      return;
    }
    setFailure(describe(error));
  }

  const move = useMutation({
    mutationFn: (to: WorkItemState) =>
      transitionWorkItem(api, organizationSlug, item.id, {
        version: item.version,
        to,
        facts: factsForWire(facts, optional),
      }),
    onSuccess: (next) => {
      onChanged(next);
      setTarget('');
      setFacts({});
      setMissing([]);
      setFailure(undefined);
      setConflict(false);
    },
    onError: handleWriteError,
  });

  const changeAudience = useMutation({
    mutationFn: (audience: WorkItemAudience) =>
      updateWorkItem(api, organizationSlug, item.id, { version: item.version, audience }),
    onSuccess: (next) => {
      onChanged(next);
      setPendingAudience(undefined);
      setFailure(undefined);
      setConflict(false);
    },
    onError: handleWriteError,
  });

  /**
   * One fact, asked for with the control that fits what it is.
   *
   * A fact naming a person gets the member picker; everything else keeps the text box it had.
   * The value the form holds is identical either way — a `user_id` — which is what lets D16 be
   * fixed here rather than in the state machine, the request body or the API.
   */
  function renderFact(fact: string, isRequired: boolean) {
    const hint = FACT_HINT[fact];

    if (MEMBER_FACTS.includes(fact)) {
      return (
        <MemberSelect
          key={fact}
          label={FACT_LABEL[fact] ?? fact}
          name={fact}
          members={directory.members}
          value={facts[fact] ?? ''}
          onChange={(userId) => setFacts({ ...facts, [fact]: userId })}
          onSearchChange={setMemberSearch}
          loading={directory.isPending}
          failed={directory.isError}
          {...(hint === undefined ? {} : { hint })}
          {...(isRequired ? { required: true } : {})}
        />
      );
    }

    return (
      <Field
        key={fact}
        label={FACT_LABEL[fact] ?? fact}
        name={fact}
        type={fact === 'completedAt' ? 'datetime-local' : 'text'}
        value={facts[fact] ?? ''}
        onChange={(event) => setFacts({ ...facts, [fact]: event.target.value })}
        {...(hint === undefined ? {} : { hint })}
        {...(isRequired ? { required: true } : {})}
      />
    );
  }

  function submitTransition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (target === '') return;
    setMissing([]);
    move.mutate(target);
  }

  const owner = memberDisplayName(item.ownerUserId, directory.members, directory.isPending);
  const overdue = isOverdue(item, new Date());
  const focus = FOCUS[item.state];
  const base = `/${organizationSlug}/work/${item.id}`;

  return (
    <div className="tm-wk-item">
      <div className="tm-wk-item__main">
        <div className="tm-wk-item__chips">
          <Link href={`/${organizationSlug}/work`} className="tm-wk-chip">
            <span className="tm-wk-chip__orb" aria-hidden="true">
              ←
            </span>
            Work list
          </Link>
          <StateCapsule state={stateCapsule(item.state)}>{stateLabel(item.state)}</StateCapsule>
          {/*
            D16's acceptance sentence: a member "can see who is accountable". The chip says who
            by name; "Unassigned" when nobody is.
          */}
          <span className="tm-wk-chip">
            <span
              className="tm-wk-avatar"
              aria-hidden="true"
              data-empty={item.ownerUserId === null}
            >
              {item.ownerUserId === null ? '?' : initialsOf(owner)}
            </span>
            <span className="tm-visually-hidden">Owner: </span>
            {owner}
          </span>
          <span
            className="tm-wk-chip"
            {...(isClientFacing(item.audience) ? { 'data-tone': 'client' } : {})}
          >
            <span className="tm-wk-halo" data-audience={item.audience}>
              <span className="tm-wk-halo__ring" aria-hidden="true">
                {AUDIENCE_GLYPH[item.audience]}
              </span>
            </span>
            {audienceLabel(item.audience)}
          </span>
        </div>

        <nav className="tm-segmented tm-wk-subnav" aria-label="This work item">
          <Link href={base} aria-current="page">
            Overview
          </Link>
          <Link href={`${base}/activity`}>Activity</Link>
          <Link href={`${base}/time-logs`}>Time</Link>
          <Link href={`${base}/estimate`}>Estimate</Link>
        </nav>

        {focus !== undefined ? (
          <div className="tm-focus-capsule">
            <span className="tm-focus-capsule__orb" aria-hidden="true">
              ▸
            </span>
            <div className="tm-focus-capsule__text">
              <p className="tm-focus-capsule__title">{focus.title}</p>
              <p className="tm-focus-capsule__why">
                {focus.why}{' '}
                {item.dueAt === null
                  ? 'No due date is set, so nothing is committed yet.'
                  : overdue
                    ? `It was due ${formatDay(item.dueAt)}.`
                    : `It is due ${formatDay(item.dueAt)}.`}
              </p>
            </div>
            <div className="tm-focus-capsule__end">
              <a className="tm-wk-chip" href="#tm-work-transition">
                Move this item
              </a>
            </div>
          </div>
        ) : null}

        <section className="tm-wk-card" aria-labelledby="tm-work-header">
          <h2 id="tm-work-header" className="tm-wk-card__eyebrow">
            This item · {item.type}
          </h2>
          <dl className="tm-wk-facts">
            <div>
              <dt>Starts</dt>
              <dd>{formatDay(item.startAt)}</dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd {...(overdue ? { 'data-tone': 'warning' } : {})}>{formatDay(item.dueAt)}</dd>
            </div>
            {item.completedAt !== null ? (
              <div>
                <dt>Completed</dt>
                <dd>{formatDay(item.completedAt)}</dd>
              </div>
            ) : null}
            <div>
              <dt>Last changed</dt>
              <dd title={formatInstant(item.updatedAt)}>{formatDay(item.updatedAt)}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>v{item.version}</dd>
            </div>
          </dl>
          <p className="tm-wk-facts__note">
            {overdue
              ? `Past its due date and still ${stateLabel(item.state).toLowerCase()}.`
              : `Currently ${stateLabel(item.state).toLowerCase()}, ${audienceLabel(item.audience).toLowerCase()}.`}
          </p>
        </section>

        <WorkItemTagsAndFiles
          organizationSlug={organizationSlug}
          workItemId={item.id}
          client={api}
        />

        {conflict ? (
          <InlineAlert tone="warning" title="Somebody else changed this first" live>
            Your change was not applied. The item above has been reloaded and now shows what is
            actually stored. Read it, then make the change again if you still want it.
          </InlineAlert>
        ) : null}

        {failure ? (
          <InlineAlert tone="danger" title="That did not go through" live>
            {failure}
          </InlineAlert>
        ) : null}

        {missing.length > 0 ? (
          <InlineAlert tone="warning" title="The move needs more than was given" live>
            <ul className="tm-list">
              {missing.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : null}
        <section className="tm-panel tm-stack" aria-labelledby="tm-work-transition">
          <h2 id="tm-work-transition" className="tm-eyebrow">
            Move this item
          </h2>

          {reachable.length === 0 ? (
            <p className="tm-prose">
              {stateLabel(item.state)} is the end of the lifecycle. There is nowhere to move this
              item from here.
            </p>
          ) : (
            <form className="tm-stack" noValidate onSubmit={submitTransition}>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-work-target">
                  Move to
                </label>
                <select
                  id="tm-work-target"
                  className="tm-field__control"
                  value={target}
                  onChange={(event) => {
                    const next = event.target.value as WorkItemState | '';
                    setTarget(next);
                    // Two of `done`'s facts have sensible starting values: the owner the item
                    // already has, and "now" for the completion time. Both are offered, not
                    // imposed — the fields stay editable — so a person is not made to retype an
                    // id that is already on the row.
                    const needs =
                      next === '' ? [] : workItemStateMachine.requirementsFor(item.state, next);
                    const seeded: Record<string, string> = {};
                    if (needs.includes('ownerId') && item.ownerUserId !== null) {
                      seeded['ownerId'] = item.ownerUserId;
                    }
                    if (needs.includes('completedAt')) {
                      seeded['completedAt'] = toLocalControlValue(new Date());
                    }
                    setFacts(seeded);
                    setMissing([]);
                  }}
                >
                  <option value="">Choose a state</option>
                  {reachable.map((state) => (
                    <option key={state} value={state}>
                      {stateLabel(state)}
                    </option>
                  ))}
                </select>
                <span className="tm-field__hint">
                  Only the moves the lifecycle allows from {stateLabel(item.state)} are listed.
                </span>
              </div>

              {required.map((fact) => renderFact(fact, true))}

              {/*
                What the move will take but does not need. Rendered after the requirements and
                never marked required, so the asterisks say exactly what the machine says.
              */}
              {optional.map((fact) => renderFact(fact, false))}

              {target !== '' && required.length === 0 && optional.length === 0 ? (
                <p className="tm-prose">This move needs nothing else from you.</p>
              ) : null}

              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={move.isPending}
                  loadingLabel="Moving"
                  disabled={target === ''}
                >
                  Move to {target === '' ? 'the chosen state' : stateLabel(target)}
                </Button>
              </div>
            </form>
          )}
        </section>
        <section className="tm-panel tm-stack" aria-labelledby="tm-work-audience">
          <h2 id="tm-work-audience" className="tm-eyebrow">
            Who can see this
          </h2>
          <p className="tm-prose">
            Currently <strong>{audienceLabel(item.audience)}</strong>.
          </p>

          {/*
            Widening is confirmed; narrowing is not.
            `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC` makes audience the control that decides
            what a client can ever see, and widening is the direction that discloses. Narrowing
            takes something away from a client who may already have read it — worth doing, and
            not worth a modal, because nothing new escapes.
          */}
          <div className="tm-row tm-row--wrap">
            {(['internal', 'client_visible', 'client_action_required'] as const).map((audience) => (
              <Button
                key={audience}
                tone={audience === item.audience ? 'ink' : 'outline'}
                size="accessible"
                disabled={audience === item.audience || changeAudience.isPending}
                onClick={() => {
                  if (audience === 'internal') {
                    changeAudience.mutate(audience);
                  } else {
                    setPendingAudience(audience);
                  }
                }}
              >
                {audienceLabel(audience)}
              </Button>
            ))}
          </div>

          {pendingAudience !== undefined ? (
            <InlineAlert tone="client" title="This will show the item to the client" live>
              <p className="tm-prose">
                “{item.title}” becomes {audienceLabel(pendingAudience).toLowerCase()} in the client
                portal. The title is what they will read, so check it says what you mean it to.
              </p>
              <div className="tm-row">
                <Button
                  tone="ink"
                  size="accessible"
                  loading={changeAudience.isPending}
                  loadingLabel="Publishing"
                  onClick={() => changeAudience.mutate(pendingAudience)}
                >
                  Show it to the client
                </Button>
                <Button
                  tone="outline"
                  size="accessible"
                  onClick={() => setPendingAudience(undefined)}
                >
                  Keep it internal
                </Button>
              </div>
            </InlineAlert>
          ) : null}
        </section>
        <WorkChecklistPanel organizationSlug={organizationSlug} workItemId={item.id} api={api} />

        <WorkCommentsPanel organizationSlug={organizationSlug} workItemId={item.id} api={api} />
      </div>

      <aside className="tm-wk-item__aside" aria-label="Story and relationships">
        <section className="tm-wk-card" aria-labelledby="tm-work-story">
          <h2 id="tm-work-story" className="tm-wk-card__eyebrow">
            Work story
          </h2>
          <ol className="tm-wk-story">
            <li>
              <span className="tm-wk-story__when">Created · {formatDay(item.createdAt)}</span>
              <span className="tm-wk-story__what">Added as a {item.type}</span>
            </li>
            {item.completedAt !== null ? (
              <li>
                <span className="tm-wk-story__when">Done · {formatDay(item.completedAt)}</span>
                <span className="tm-wk-story__what">Finished by its owner</span>
              </li>
            ) : null}
            <li>
              <span className="tm-wk-story__when">Changed · {formatDay(item.updatedAt)}</span>
              <span className="tm-wk-story__what">Now at version {item.version}</span>
            </li>
            <li data-state="now">
              <span className="tm-wk-story__when">Now · {stateLabel(item.state)}</span>
              <span className="tm-wk-story__what">
                {item.dueAt === null ? 'No due date' : `Due ${formatDay(item.dueAt)}`}
              </span>
            </li>
          </ol>
        </section>

        <div className="tm-wk-card tm-wk-deps">
          <WorkItemDependenciesScreen
            organizationSlug={organizationSlug}
            workItemId={item.id}
            api={api}
          />
        </div>

        <WorkWatchersPanel organizationSlug={organizationSlug} workItemId={item.id} api={api} />
      </aside>
    </div>
  );
}

/** One Focus Capsule per surface: what to do next with the item, and why now. */
const FOCUS: Partial<Record<WorkItemState, { title: string; why: string }>> = {
  backlog: { title: 'Get this ready to start', why: 'It is in the backlog.' },
  ready: { title: 'Start this item', why: 'It is ready and waiting for its owner.' },
  in_progress: { title: 'Move it on when it is ready', why: 'Work is in progress.' },
  blocked: {
    title: 'Resolve the blocker',
    why: 'Nothing moves until the blocker is cleared.',
  },
  internal_review: { title: 'Finish the internal review', why: 'It is waiting on a reviewer.' },
};

const AUDIENCE_GLYPH: Record<WorkItemAudience, string> = {
  internal: '■',
  client_visible: '◎',
  client_action_required: '!',
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}
