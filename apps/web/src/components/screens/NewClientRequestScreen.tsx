'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPortalProjects, submitClientRequest } from '../../lib/api/portal';
import type { ClientRequest } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { formatDay } from '../../lib/client-request-presentation';
import './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';

export interface NewClientRequestScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
  /** Called with the new request's id once it exists, so the route can show its detail. */
  onSubmitted?: (requestId: string) => void;
  /**
   * REQ-15: when the form is opened from an item's "Ask about this" control, the item it is about
   * is carried in so the form is not blank. Its title names the item in a banner and seeds the
   * description, and `initialProjectId` files the request against that item's own project.
   */
  aboutItemTitle?: string;
  initialProjectId?: string;
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
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
  onSubmitted,
  aboutItemTitle,
  initialProjectId,
}: NewClientRequestScreenProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState(() =>
    aboutItemTitle ? `Regarding “${aboutItemTitle}”.\n\n` : '',
  );
  const [category, setCategory] = useState('');
  const [urgencyReason, setUrgencyReason] = useState('');
  const [desiredDate, setDesiredDate] = useState('');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [sent, setSent] = useState<ClientRequest | undefined>(undefined);

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const available = projects.data ?? [];
  const projectsLoaded = !projects.isPending && !projects.isError;
  // Once the projects have loaded and there are none, there is nothing to ask about. The screen
  // says so up front (REQ-04) rather than letting a person fill the whole form and refusing only
  // after Send.
  const noProjectShared = projectsLoaded && available.length === 0;
  const onlyProject = available.length === 1 ? available[0] : undefined;
  const singleProject = onlyProject !== undefined;
  // The project is a real choice only when this client has more than one. With exactly one it
  // is stated rather than offered, for the reason `FirstProjectScreen` states an owner: a
  // select with a single option looks like a decision and is not. With more than one, nothing is
  // pre-selected (WRK-09): the first project in the list is not a safe default to file against.
  const chosenProjectId = onlyProject ? onlyProject.id : projectId;
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
    if (noProjectShared) {
      setFailure('No project has been shared with you yet, so there is nothing to ask about.');
      return;
    }
    if (chosenProjectId === '') {
      setFailure('Choose which project this is about before you send it.');
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
        // A date input gives 'YYYY-MM-DD' and since 0012 that is exactly what the API
        // stores: a calendar date, no invented time of day, no zone to shift it in.
        ...(desiredDate === '' ? {} : { desiredAt: desiredDate }),
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
      activeNavigationId="overview"
      title={sent ? 'Your request is with the studio' : 'What do you need?'}
      eyebrow={`Ask ${providerName} for something`}
    >
      <div className="tm-pt tm-pt--compact">
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
              <LoadingRegion label="Loading your projects.">
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {/*
              REQ-04: when nothing has been shared there is nothing to ask about, and the person is
              told so before filling anything in. The form below ships disabled in this case, so
              Send cannot be reached and then refused.
            */}
            {noProjectShared ? (
              <InlineAlert tone="warning" title="There is nothing to ask about yet" live>
                {providerName} has not shared a project with you yet. When they do, it appears here
                and you can send a request about it. Until then there is nothing for a request to be
                attached to.
              </InlineAlert>
            ) : null}

            {/*
              REQ-15: opened from an item's "Ask about this", so the item it is about is named here
              and already written into the description — the form is no longer a blank general one
              that never mentions what the person clicked.
            */}
            {aboutItemTitle && !noProjectShared ? (
              <InlineAlert tone="neutral" title="You are asking about">
                {aboutItemTitle}
              </InlineAlert>
            ) : null}

            <form className="tm-pt-split tm-pt-split--aside" noValidate onSubmit={submit}>
              {/*
                The controls are not editable until this screen's data has arrived: server-rendered
                HTML has `isPending === true`, so the fieldset ships disabled and becomes editable
                only once React is live and the portal-projects query has answered. Otherwise a
                person could type before hydration and have the words wiped.
              */}
              <fieldset
                className="tm-fieldset tm-pt-col"
                disabled={projects.isPending || noProjectShared}
              >
                <div className="tm-pt-form">
                  <div className="tm-pt-form__title">
                    <Field
                      label="The request"
                      name="title"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      hint="One line. This is what the studio sees first."
                      required
                      {...errorFor(fieldErrors, 'title')}
                    />
                  </div>

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-request-description">
                      Why it matters
                      <span className="tm-field__required" aria-hidden="true">
                        {' '}
                        *
                      </span>
                    </label>
                    <textarea
                      id="tm-request-description"
                      name="description"
                      className="tm-field__control tm-field__control--multiline"
                      rows={3}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      aria-describedby="tm-request-description-hint"
                      aria-invalid={fieldErrors.has('description') ? true : undefined}
                      required
                    />
                    <span className="tm-field__hint" id="tm-request-description-hint">
                      What you are trying to achieve, and what happens if it does not get done. The
                      studio judges the request on this.
                    </span>
                    {fieldErrors.get('description') ? (
                      <span className="tm-field__error">{fieldErrors.get('description')}</span>
                    ) : null}
                  </div>

                  <div className="tm-pt-form__pair">
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

                    {/*
                      The project is a real choice only when this client has more than one. With
                      exactly one it is stated rather than offered: a select with a single option
                      looks like a decision and is not.
                    */}
                    {available.length > 1 ? (
                      <div className="tm-field">
                        <label className="tm-field__label" htmlFor="tm-request-project">
                          Which project
                          <span className="tm-field__required" aria-hidden="true">
                            {' '}
                            *
                          </span>
                        </label>
                        <select
                          id="tm-request-project"
                          className="tm-field__control"
                          value={chosenProjectId}
                          onChange={(event) => setProjectId(event.target.value)}
                          required
                        >
                          {/*
                            Nothing is pre-selected (WRK-09): the first project is not a safe default,
                            and a silent default is how a request lands against the wrong project.
                          */}
                          <option value="" disabled>
                            Choose a project
                          </option>
                          {available.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                        <span className="tm-field__hint">
                          Pick the project this is about. {providerName} has shared more than one
                          with you.
                        </span>
                      </div>
                    ) : singleProject ? (
                      <div className="tm-field">
                        <span className="tm-field__label">Which project</span>
                        <p className="tm-pt-fixed">{chosenProject?.name}</p>
                        <span className="tm-field__hint">
                          The only project {providerName} has shared with you.
                        </span>
                      </div>
                    ) : null}
                  </div>

                  <div className="tm-pt-form__pair">
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
                  </div>

                  <p className="tm-pt-eyebrow">⊘ Visible to the studio and your team</p>
                </div>

                {failure ? (
                  <InlineAlert tone="danger" title="Could not send the request" live>
                    {failure}
                  </InlineAlert>
                ) : null}

                <div className="tm-pt-form__actions">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={sending}
                    loadingLabel="Sending"
                    disabled={projects.isPending || noProjectShared}
                  >
                    Send request
                  </Button>
                </div>
              </fieldset>

              <div className="tm-pt-col">
                <section className="tm-pt-ink" aria-labelledby="tm-request-summary">
                  <h2 id="tm-request-summary" className="tm-pt-eyebrow">
                    What happens next
                  </h2>
                  <p className="tm-pt-ink__title">
                    {providerName} reads it, asks anything unclear, then either agrees a date or
                    tells you why not.
                  </p>
                  <p className="tm-pt-quiet">
                    A date you ask for is not a date you are given. Nothing is scheduled until the
                    studio commits, and your date stays visible either way.
                  </p>
                  <p className="tm-pt-quiet">
                    Asked for: {desiredDate === '' ? 'No date' : formatDay(desiredDate)}
                  </p>
                </section>

                <section className="tm-pt-card" aria-labelledby="tm-request-audience">
                  <h2 id="tm-request-audience" className="tm-pt-eyebrow">
                    Who will see this
                  </h2>
                  <p className="tm-pt-quiet">
                    {providerName}&rsquo;s delivery team, and your colleagues at {clientName}.
                    Nobody outside those two groups — no other client of {providerName} can see it.
                  </p>
                </section>
              </div>
            </form>
          </>
        )}
      </div>
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
    <div className="tm-pt-split tm-pt-split--aside">
      <section className="tm-pt-form" aria-labelledby="tm-request-sent">
        <h2 id="tm-request-sent" className="tm-pt-eyebrow">
          Sent
        </h2>
        <InlineAlert tone="success" title="Your request is with the studio" live>
          <p className="tm-pt-card__title">{request.title}</p>
        </InlineAlert>
        <p className="tm-pt-aside-row">
          <span className="tm-pt-tag">Asked for</span>
          <span className="tm-pt-quiet">
            {request.desiredAt === null ? 'No date' : formatDay(request.desiredAt)}
          </span>
        </p>
        {/*
          A confirmation has to lead somewhere, or the form is gone and the only way back is the
          browser's own button, which reads as though the request was lost.
        */}
        <div className="tm-pt-form__actions">
          <Link
            className="tm-pt-btn tm-pt-btn--ink"
            href={`/${organizationSlug}/portal/requests/${request.id}`}
          >
            See this request
          </Link>
          <Link className="tm-pt-btn" href={`/${organizationSlug}/portal/requests`}>
            All of your requests
          </Link>
        </div>
      </section>

      <section className="tm-pt-ink" aria-labelledby="tm-request-next">
        <h2 id="tm-request-next" className="tm-pt-ink__title">
          Nothing is scheduled yet
        </h2>
        <p className="tm-pt-quiet">
          The date above is the one you asked for. It is not a commitment and it has not been
          agreed. {providerName} will read the request, ask you anything they need, and then either
          agree a date or tell you why not — you will see whichever it is on this request.
        </p>
      </section>
    </div>
  );
}

function errorFor(errors: ReadonlyMap<string, string>, field: string): { error?: string } {
  const message = errors.get(field);
  return message === undefined ? {} : { error: message };
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The portal is not answering. Try again shortly.';
  return 'Something went wrong. Try again.';
}
