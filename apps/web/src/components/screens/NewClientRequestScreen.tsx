'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalProjects, submitClientRequest } from '../../lib/api/portal';
import type { ClientRequest } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { formatDay } from '../../lib/client-request-presentation';

export interface NewClientRequestScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
  /** Called with the new request's id once it exists, so the route can show its detail. */
  onSubmitted?: (requestId: string) => void;
}

/**
 * **CL-09 New request** (`41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §9), the first half of
 * **CL-06 New request / request detail** in `22-SCREEN-BY-SCREEN` §6.
 *
 * §6: "Title, category, description, urgency reason, desired date, files. **Confirmation states
 * date is uncommitted.**" The design artifact is blunter still — its own caption reads
 * "A DESIRED DATE IS A WISH, NOT A COMMITMENT" — and that sentence is this screen's whole job.
 *
 * ## The date is said three times, in three places, on purpose
 *
 * Beside the field, in the summary before sending, and in the confirmation after. `REQ-001`
 * already keeps the two apart in storage — `desired_at` is what the client asked for and
 * `committed_at` can only be written by an acceptance — so the screen is not compensating for
 * a data model that confuses them. It is saying it out loud because a client who types a date
 * into a form has, in every other product they have used, just set a deadline.
 *
 * The field is labelled "When you would like it", never "Due date", and the capsule beside the
 * value reads `Asked for`. A screen that collected a date and called it a deadline would make a
 * promise on the studio's behalf before anybody at the studio had read the request.
 *
 * ## What the specification lists and this screen does not offer
 *
 * - **Files.** §6 lists them, US-B01 requires "valid files scanned", and `FILE-001` has not
 *   shipped: there is no `file_assets` table and nothing scans anything. There is no file input
 *   here, because an input that accepted a file and dropped it would be worse than one that is
 *   honestly absent.
 * - **Save as draft.** The design artifact draws the button. `23-ERD` §6's machine has no draft
 *   state — `submitted` is the initial one — so a draft would be a state the lifecycle does not
 *   have, stored somewhere this system does not have.
 * - **"Similar things you asked for".** The artifact lists two. Similarity is a judgement
 *   nothing computes; what this screen can honestly show is the requests this client has
 *   already sent, and it does that on the list rather than pretending to have matched them.
 * - **"Who will see this", by name.** The artifact names four people. Nothing returns a person's
 *   name to a client — `CL-13 People`, "approved contacts only", is unbuilt — so the audience is
 *   stated as the two groups it actually is.
 *
 * ## Category
 *
 * A short label rather than a picker, and the reason is recorded rather than hidden: **no
 * document in the planning pack enumerates the categories.** The API constrains the shape to a
 * slug because the value reaches audit metadata, so the field accepts one and says what one
 * looks like. A `<select>` with invented options would look like a decision somebody made.
 */
export function NewClientRequestScreen({
  organizationSlug,
  clientName,
  providerName,
  client,
  onSubmitted,
}: NewClientRequestScreenProps) {
  const api = client ?? browserApiClient();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [urgencyReason, setUrgencyReason] = useState('');
  const [desiredDate, setDesiredDate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [sent, setSent] = useState<ClientRequest | undefined>(undefined);

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const available = projects.data ?? [];
  // The project is a real choice only when this client has more than one. With exactly one it
  // is stated rather than offered, for the reason `FirstProjectScreen` states an owner: a
  // select with a single option looks like a decision and is not.
  const chosenProjectId = projectId !== '' ? projectId : (available[0]?.id ?? '');
  const chosenProject = available.find((project) => project.id === chosenProjectId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    setFieldErrors(new Map());

    if (title.trim() === '') {
      setFailure('Say what you need in the first field.');
      return;
    }
    if (description.trim() === '') {
      setFailure('Tell the studio why it matters, so they can judge it.');
      return;
    }
    if (chosenProjectId === '') {
      setFailure('No project has been shared with you yet, so there is nothing to ask about.');
      return;
    }

    setSending(true);
    try {
      const created = await submitClientRequest(api, organizationSlug, {
        projectId: chosenProjectId,
        title: title.trim(),
        description: description.trim(),
        ...(category.trim() === '' ? {} : { category: category.trim() }),
        ...(urgencyReason.trim() === '' ? {} : { urgencyReason: urgencyReason.trim() }),
        // The API takes an instant and refuses a bare calendar date rather than guessing a
        // time of day. A date picker gives a day, so the guess is made here, visibly.
        ...(desiredDate === '' ? {} : { desiredAt: startOfDay(desiredDate) }),
      });
      setSent(created);
      onSubmitted?.(created.id);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const fields = error.fieldErrors();
        if (fields.size > 0) setFieldErrors(fields);
        else setFailure(error.message);
      } else if (error instanceof NetworkError) {
        setFailure('The portal is not answering. Try again shortly.');
      } else {
        setFailure('Something went wrong. Try again.');
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      {...(chosenProject ? { projectName: chosenProject.name } : {})}
      activeNavigationId="overview"
      title={`Ask ${providerName} for something`}
      description="Tell them what you need. Nothing is scheduled until they say so."
    >
      {sent ? (
        <SentConfirmation
          request={sent}
          providerName={providerName}
          organizationSlug={organizationSlug}
        />
      ) : (
        <>
          {projects.isError ? (
            <InlineAlert tone="danger" title="Could not load your projects" live>
              {describe(projects.error)}
            </InlineAlert>
          ) : null}

          {projects.isPending ? (
            <div aria-busy="true" aria-live="polite">
              <span className="tm-visually-hidden">Loading your projects.</span>
              <Skeleton height="var(--row)" />
            </div>
          ) : null}

          <form className="tm-stack tm-stack--loose" noValidate onSubmit={submit}>
            <Field
              label="What do you need?"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              hint="One line. This is what the studio sees first."
              required
              {...errorFor(fieldErrors, 'title')}
            />

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-request-description">
                Why it matters
                <span className="tm-field__required" aria-hidden="true">
                  *
                </span>
              </label>
              <textarea
                id="tm-request-description"
                name="description"
                className="tm-field__control tm-field__control--multiline"
                rows={5}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                aria-describedby="tm-request-description-hint"
                aria-invalid={fieldErrors.has('description') ? true : undefined}
                required
              />
              <span className="tm-field__hint" id="tm-request-description-hint">
                What you are trying to achieve, and what happens if it does not get done. The studio
                judges the request on this.
              </span>
              {fieldErrors.get('description') ? (
                <span className="tm-field__error">{fieldErrors.get('description')}</span>
              ) : null}
            </div>

            <Field
              label="Category"
              name="category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              hint="Optional. A short label such as new-page or bug-report — lowercase, no spaces."
              {...errorFor(fieldErrors, 'category')}
            />

            <Field
              label="Is it urgent, and why?"
              name="urgencyReason"
              value={urgencyReason}
              onChange={(event) => setUrgencyReason(event.target.value)}
              hint="Optional. A deadline of your own, a season, an event — anything that makes the timing matter."
              {...errorFor(fieldErrors, 'urgencyReason')}
            />

            <Field
              label="When you would like it"
              name="desiredAt"
              type="date"
              value={desiredDate}
              onChange={(event) => setDesiredDate(event.target.value)}
              dir="ltr"
              hint="Optional, and it is a wish rather than a deadline. Nothing is scheduled until the studio agrees a date."
              {...errorFor(fieldErrors, 'desiredAt')}
            />

            {available.length > 1 ? (
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-request-project">
                  Which project
                </label>
                <select
                  id="tm-request-project"
                  className="tm-field__control"
                  value={chosenProjectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {available.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="tm-field">
                <span className="tm-field__label">Which project</span>
                <p className="tm-prose">
                  {chosenProject?.name ?? 'No project shared with you yet'}
                </p>
                <span className="tm-field__hint">
                  The only project {providerName} has shared with you.
                </span>
              </div>
            )}

            <section
              className="tm-panel tm-panel--quiet tm-stack"
              aria-labelledby="tm-request-summary"
            >
              <h2 id="tm-request-summary" className="tm-eyebrow">
                What will be sent
              </h2>
              <div className="tm-row">
                <StateCapsule state="future">Asked for</StateCapsule>
                <span className="tm-prose">
                  {desiredDate === '' ? 'No date' : formatDay(startOfDay(desiredDate))}
                </span>
              </div>
              <InlineAlert tone="neutral" title="A date you ask for is not a date you are given">
                {providerName} reads the request, asks anything unclear, and then either agrees a
                date or tells you why not. Your date stays visible either way, and it never becomes
                a commitment on its own.
              </InlineAlert>
            </section>

            <section className="tm-panel tm-stack" aria-labelledby="tm-request-audience">
              <h2 id="tm-request-audience" className="tm-eyebrow">
                Who will see this
              </h2>
              <p className="tm-prose">
                {providerName}&rsquo;s delivery team, and your colleagues at {clientName}. Nobody
                outside those two groups — no other client of {providerName} can see it, and no
                other client organization exists as far as this portal is concerned.
              </p>
            </section>

            {failure ? (
              <InlineAlert tone="danger" title="Could not send the request" live>
                {failure}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={sending}
                loadingLabel="Sending"
                disabled={projects.isPending}
              >
                Send request
              </Button>
            </div>
          </form>

          <BackendPending ticket="FILE-001 · CONV-001 · CL-13">
            Three things the design draws are not here. You cannot attach a file, because nothing in
            this system scans one yet and an unscanned attachment is worse than none. You cannot
            save a draft, because the request lifecycle has no draft state to save into. And
            &ldquo;who will see this&rdquo; names two groups rather than four people, because
            nothing returns a person&rsquo;s name to a client.
          </BackendPending>
        </>
      )}
    </ClientPortalShell>
  );
}

interface SentConfirmationProps {
  request: ClientRequest;
  providerName: string;
  organizationSlug: string;
}

/**
 * §6: "**Confirmation states date is uncommitted.**"
 *
 * It is the specification's one bolded requirement for this screen, so it is a panel of its own
 * rather than a toast. The confirmation repeats the date back as `Asked for` — the same words
 * the form used — and says in a sentence what happens next, because the moment a person has
 * just pressed Send is the moment they most want to know whether they have set a deadline.
 */
function SentConfirmation({ request, providerName, organizationSlug }: SentConfirmationProps) {
  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-request-sent">
      <h2 id="tm-request-sent" className="tm-eyebrow">
        Sent
      </h2>
      <InlineAlert tone="success" title="Your request is with the studio" live>
        <p className="tm-prose">
          <strong>{request.title}</strong>
        </p>
      </InlineAlert>

      <div className="tm-row">
        <StateCapsule state="future">Asked for</StateCapsule>
        <span className="tm-prose">
          {request.desiredAt === null ? 'No date' : formatDay(request.desiredAt)}
        </span>
      </div>

      <InlineAlert tone="neutral" title="Nothing is scheduled yet">
        The date above is the one you asked for. It is not a commitment and it has not been agreed.{' '}
        {providerName} will read the request, ask you anything they need, and then either agree a
        date or tell you why not — you will see whichever it is on this request.
      </InlineAlert>

      {/*
        A confirmation has to lead somewhere. Without these two links the screen is a dead end:
        the form is gone, the request exists, and the only way back to either is the browser's
        own button — which re-mounts an empty form and reads as though the request was lost.
      */}
      <p className="tm-prose">
        <Link href={`/${organizationSlug}/portal/requests/${request.id}`}>See this request</Link>
        {' · '}
        <Link href={`/${organizationSlug}/portal/requests`}>All of your requests</Link>
      </p>
    </section>
  );
}

/** The field errors the API returned, in the shape `Field` takes. */
function errorFor(errors: ReadonlyMap<string, string>, field: string): { error?: string } {
  const message = errors.get(field);
  return message === undefined ? {} : { error: message };
}

/**
 * A calendar day as an instant: **midnight UTC**, not midnight where the reader is.
 *
 * The API refuses a bare `2026-09-03` rather than guessing a time of day, which is right — a
 * request "by the third" and one "by the third at nine" are different asks. A date input gives
 * a day, so the guess is made here, visibly, rather than left to the API to make invisibly.
 *
 * UTC because that is what `ProjectsController.parseTargetDate` already does for `targetDate`,
 * and one convention that is occasionally off by a day beats two conventions that disagree.
 * The cost is real and is recorded rather than hidden: a client west of UTC picks 3 September
 * and `Intl.DateTimeFormat` in their own zone reads the stored instant back as 2 September.
 * The proper fix is a `DATE` column for a date that has no time — `client_requests.desired_at`
 * is `DATETIME(3)`, as `projects.forecast_at` is — and that is a migration rather than a
 * screen's decision. Recorded in `docs/implementation-status.md`.
 */
function startOfDay(day: string): string {
  return `${day}T00:00:00.000Z`;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
