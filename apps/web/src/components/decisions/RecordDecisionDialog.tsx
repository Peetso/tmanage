'use client';

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  createDecision,
  type CreateDecisionInput,
  type DecisionAudience,
  type DecisionSummary,
} from '../../lib/api/decisions';
import { listProjects } from '../../lib/api/projects';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useMembers } from '../../lib/use-members';
import { dayToInstant } from '../../lib/work-item-presentation';
import { DueDatePicker, formatChipDay, todayOf, WorkDialogFrame } from '../work/DueDatePicker';
import { initialsOf, useOwnerCandidates } from '../work/OwnerPickerDialog';
import { formatDocMoment, rtlLine } from '../docs/doc-markdown';
import './record-decision.css';

/** The chat message a decision is recorded from. */
export interface RecordDecisionMessage {
  readonly id: string;
  readonly body: string;
  readonly authorName: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export interface RecordDecisionDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly message: RecordDecisionMessage;
  /** A channel's own project; a direct message has none, so the first project is offered. */
  readonly defaultProjectId?: string;
  /** The signed-in person, when the screen knows them — the default "Decided by". */
  readonly selfUserId?: string;
  /** Injected in tests; the reader's clock otherwise. */
  readonly now?: Date;
  readonly onRecorded: (decision: DecisionSummary) => void;
  readonly onClose: () => void;
}

/** `decisions.title` is `VARCHAR(300)`; a title drawn from a message stays a line. */
const TITLE_FROM_MESSAGE_LIMIT = 120;

/**
 * F3 — the title the dialog starts with: the message's first sentence, without a short lead-in
 * label ("Agreed:", "Decision:"), first letter capitalised. "Agreed: we launch the mobile
 * booking flow first. Desktop follows…" → "We launch the mobile booking flow first".
 */
export function titleFromMessage(body: string): string {
  const flat = body.replace(/\s+/gu, ' ').trim();
  const first = (flat.split(/(?<=[.!?؟])\s/u)[0] ?? flat).replace(/[.!?؟]+$/u, '');
  const lead = /^([^\s:]+(?:\s[^\s:]+)?):\s+(.+)$/u.exec(first);
  const sentence = lead?.[2] ?? first;
  const capital = sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1);
  return capital.length > TITLE_FROM_MESSAGE_LIMIT
    ? `${capital.slice(0, TITLE_FROM_MESSAGE_LIMIT - 1).trimEnd()}…`
    : capital;
}

/** Where the decision page opens after saving, with the "Decision recorded" toast. */
export function recordedDecisionHref(organizationSlug: string, decisionId: string): string {
  return `/${organizationSlug}/decisions/${encodeURIComponent(decisionId)}?recorded=1`;
}

/**
 * Reads and clears the `?recorded=1` the dialog navigates with, so a reload or a shared link
 * never shows the toast again.
 */
export function takeRecordedFlag(): boolean {
  if (typeof window === 'undefined') return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get('recorded') !== '1') return false;
  url.searchParams.delete('recorded');
  window.history.replaceState(window.history.state, '', url.toString());
  return true;
}

/** How long the toast stays; it is feedback about a write that already succeeded. */
const TOAST_MS = 6000;

/**
 * F3 (390:6040 / 390:21927) — "Decision recorded · Saved from Lina Samir's message." The saved
 * toast (378:18159): a success-edged card with the dot, the title and one line.
 */
export function RecordedDecisionToast({
  authorName,
  onDone,
}: {
  readonly authorName: string | undefined;
  readonly onDone: () => void;
}) {
  const tOr = useTOr();
  useEffect(() => {
    const timer = setTimeout(onDone, TOAST_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <div className="tm-recdec-toast" role="status">
      <span className="tm-recdec-toast__dot" aria-hidden="true" />
      <span className="tm-recdec-toast__text">
        <span className="tm-recdec-toast__title">
          {tOr('RecordDecision.toastTitle', 'Decision recorded')}
        </span>
        {authorName ? (
          <span className="tm-recdec-toast__body">
            {tOr('RecordDecision.toastBody', 'Saved from {name}’s message.').replace(
              '{name}',
              authorName,
            )}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * **F3 — Record as decision** (Figma 390:5985 / 390:21872; phone sheet 390:6268 / 390:22155).
 *
 * Opened from a message's actions ("Record as decision"), filled in from the message: Title (its
 * first sentence), Decision (its text), then Details — Decided by, Date, Visible to and Project
 * chips, the Edit work item dialog's own — and "Link to the message", on by default, with the
 * line saying what the decision will show. Save decision records it as decided
 * (`POST …/decisions`, `status: accepted`, `sourceMessageId` when linked) and hands the new
 * decision back; the screen opens its page. On a phone the same form is a bottom sheet.
 */
export function RecordDecisionDialog({
  api,
  organizationSlug,
  message,
  defaultProjectId,
  selfUserId,
  now,
  onRecorded,
  onClose,
}: RecordDecisionDialogProps) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const titleId = useId();
  const today = useMemo(() => todayOf(now ?? new Date()), [now]);

  const [title, setTitle] = useState(() => titleFromMessage(message.body));
  const [statement, setStatement] = useState(message.body.trim());
  const [day, setDay] = useState(today);
  const [audience, setAudience] = useState<DecisionAudience>('internal');
  const [linked, setLinked] = useState(true);
  const [pickedProject, setPickedProject] = useState<string | undefined>(defaultProjectId);
  const [decidedBy, setDecidedBy] = useState(selfUserId ?? '');
  const [datePicker, setDatePicker] = useState(false);
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const projectRows = useMemo(
    () =>
      (Array.isArray(projects.data) ? projects.data : []).filter(
        (project) => project.status !== 'archived',
      ),
    [projects.data],
  );
  const projectId = pickedProject ?? projectRows[0]?.id ?? '';

  const owners = useOwnerCandidates(api, organizationSlug, projectId);
  const directory = useMembers(api, organizationSlug);
  const selfName =
    selfUserId === undefined
      ? undefined
      : (directory.members ?? []).find((member) => member.userId === selfUserId)?.displayName;
  const people = useMemo(() => {
    const rows = owners.candidates.map((c) => ({ userId: c.userId, name: c.displayName }));
    if (selfUserId !== undefined && !rows.some((row) => row.userId === selfUserId)) {
      rows.unshift({ userId: selfUserId, name: selfName ?? '…' });
    }
    return rows;
  }, [owners.candidates, selfUserId, selfName]);
  const deciderName =
    decidedBy === ''
      ? tOr('RecordDecision.you', 'You')
      : (people.find((person) => person.userId === decidedBy)?.name ?? '…');

  const save = useMutation({
    mutationFn: (input: CreateDecisionInput) => createDecision(api, organizationSlug, input),
    onSuccess: onRecorded,
    onError: (error) => {
      if (error instanceof ApiRequestError) setProblems(error.fieldErrors());
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();
    const nextStatement = statement.trim();
    const local = new Map<string, string>();
    if (nextTitle === '') {
      local.set('title', tOr('RecordDecision.titleRequired', 'Give the decision a title.'));
    }
    if (nextStatement === '') {
      local.set('statement', tOr('RecordDecision.statementRequired', 'Say what was decided.'));
    }
    if (projectId === '') {
      local.set('projectId', tOr('RecordDecision.projectRequired', 'Choose a project.'));
    }
    setProblems(local);
    if (local.size > 0 || save.isPending) return;
    const decidedAt = day === today ? undefined : dayToInstant(day);
    save.mutate({
      projectId,
      title: nextTitle,
      statement: nextStatement,
      status: 'accepted',
      audience,
      ...(decidedAt ? { decidedAt } : {}),
      ...(linked ? { sourceMessageId: message.id } : {}),
      ...(decidedBy !== '' && decidedBy !== selfUserId ? { decidedBy } : {}),
    });
  }

  const failure =
    save.isError && !(save.error instanceof ApiRequestError && save.error.status === 400)
      ? describe(save.error, tOr)
      : undefined;
  const linkHint = tOr(
    'RecordDecision.linkHint',
    'The decision shows {name}’s message from {when}.',
  )
    .replace('{name}', message.authorName)
    .replace('{when}', formatDocMoment(message.createdAt, locale));

  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <form className="tm-wk-dialog__form tm-recdec" noValidate onSubmit={submit}>
        <h2 id={titleId} className="tm-wk-dialog__title">
          {tOr('RecordDecision.heading', 'Record as decision')}
        </h2>

        <Field
          label={tOr('RecordDecision.title', 'Title')}
          name="title"
          value={title}
          maxLength={300}
          required
          onChange={(event) => setTitle(event.target.value)}
          {...(problems.get('title') === undefined ? {} : { error: problems.get('title') })}
        />

        <div className="tm-field">
          <label className="tm-field__label" htmlFor={`${titleId}-statement`}>
            {tOr('RecordDecision.decision', 'Decision')}
          </label>
          <textarea
            id={`${titleId}-statement`}
            name="statement"
            className="tm-field__control tm-wk-textarea tm-recdec__statement"
            rows={2}
            maxLength={20000}
            value={statement}
            {...(problems.has('statement') ? { 'aria-invalid': true } : {})}
            onChange={(event) => setStatement(event.target.value)}
          />
          {problems.get('statement') ? (
            <span className="tm-field__error" role="alert">
              {problems.get('statement')}
            </span>
          ) : null}
        </div>

        <fieldset className="tm-wk-dialog__group">
          <legend className="tm-field__label">{tOr('RecordDecision.details', 'Details')}</legend>
          <div className="tm-wk-fact-chips">
            <label className="tm-wk-fact" data-kind="select">
              <span className="tm-wk-orb" aria-hidden="true">
                {initialsOf(deciderName)}
              </span>
              <span className="tm-wk-fact__text">
                <span className="tm-wk-fact__label">
                  {tOr('RecordDecision.decidedBy', 'Decided by')}
                </span>
                <select
                  className="tm-wk-fact__select"
                  name="decidedBy"
                  value={decidedBy}
                  onChange={(event) => setDecidedBy(event.target.value)}
                >
                  {selfUserId === undefined ? (
                    <option value="">{tOr('RecordDecision.you', 'You')}</option>
                  ) : null}
                  {people.map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </span>
              <span className="tm-wk-fact__caret" aria-hidden="true">
                ▾
              </span>
            </label>

            <div className="tm-wk-popover-anchor">
              <button
                type="button"
                className="tm-wk-fact"
                aria-haspopup="dialog"
                aria-expanded={datePicker}
                onClick={() => setDatePicker((open) => !open)}
              >
                <span className="tm-wk-fact__text">
                  <span className="tm-wk-fact__label">{tOr('RecordDecision.date', 'Date')}</span>
                  <span className="tm-wk-fact__value">{formatChipDay(day, locale)}</span>
                </span>
                <span className="tm-wk-fact__caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {datePicker ? (
                <DueDatePicker
                  heading={tOr('RecordDecision.dateHeading', 'Decision date')}
                  value={day}
                  {...(now === undefined ? {} : { now })}
                  onSet={(next) => {
                    setDay(next ?? today);
                    setDatePicker(false);
                  }}
                  onClose={() => setDatePicker(false)}
                />
              ) : null}
            </div>
          </div>

          <div className="tm-wk-fact-chips">
            <label className="tm-wk-fact" data-kind="select">
              <span className="tm-wk-fact__text">
                <span className="tm-wk-fact__label">
                  {tOr('RecordDecision.visibleTo', 'Visible to')}
                </span>
                <select
                  className="tm-wk-fact__select"
                  name="audience"
                  value={audience}
                  onChange={(event) => setAudience(event.target.value as DecisionAudience)}
                >
                  <option value="internal">{tOr('RecordDecision.teamOnly', 'Team only')}</option>
                  <option value="client_visible">
                    {tOr('RecordDecision.teamAndClient', 'Team and client')}
                  </option>
                </select>
              </span>
              <span className="tm-wk-fact__caret" aria-hidden="true">
                ▾
              </span>
            </label>

            <label className="tm-wk-fact" data-kind="select">
              <span className="tm-wk-fact__text">
                <span className="tm-wk-fact__label">
                  {tOr('RecordDecision.project', 'Project')}
                </span>
                <select
                  className="tm-wk-fact__select"
                  name="projectId"
                  value={projectId}
                  onChange={(event) => {
                    setPickedProject(event.target.value);
                    // The decider must be on the new project; the signed-in person stays.
                    setDecidedBy(selfUserId ?? '');
                  }}
                >
                  {projectRows.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </span>
              <span className="tm-wk-fact__caret" aria-hidden="true">
                ▾
              </span>
            </label>
          </div>
          {problems.get('projectId') ? (
            <span className="tm-field__error" role="alert">
              {problems.get('projectId')}
            </span>
          ) : null}
        </fieldset>

        <Checkbox
          label={tOr('RecordDecision.link', 'Link to the message')}
          hint={rtlLine(linkHint, locale)}
          checked={linked}
          onChange={(event) => setLinked(event.target.checked)}
        />

        {failure !== undefined ? (
          <InlineAlert tone="danger" title={tOr('RecordDecision.notSaved', 'Not saved')} live>
            {failure}
          </InlineAlert>
        ) : null}

        <div className="tm-wk-dialog__actions">
          <Button tone="outline" size="accessible" onClick={onClose}>
            {tOr('RecordDecision.cancel', 'Cancel')}
          </Button>
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={save.isPending}
            loadingLabel={tOr('RecordDecision.saving', 'Saving…')}
          >
            {tOr('RecordDecision.save', 'Save decision')}
          </Button>
        </div>
      </form>
    </WorkDialogFrame>
  );
}

function describe(error: unknown, tOr: (key: string, english: string) => string): string {
  if (error instanceof ApiRequestError && error.status === 404) {
    return tOr(
      'RecordDecision.notFound',
      'This message, project or person can no longer be used. Check the details and try again.',
    );
  }
  if (error instanceof ApiRequestError && error.status === 403) {
    return tOr('RecordDecision.forbidden', 'You cannot record decisions in this project.');
  }
  if (error instanceof NetworkError) {
    return tOr('RecordDecision.noAnswer', 'The server did not answer. Try again.');
  }
  return tOr('RecordDecision.genericError', 'Something went wrong. Try again.');
}
