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
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { formatDay } from '../../lib/client-request-presentation';
import './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { usePortalPreview } from '../../lib/portal-preview';

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
  const describe = useDescribeApiError(PORTAL_LINES);
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const t = useT();
  // 2026-10-31 live-test fix (Figma 446:37829): staff previewing the portal see the form as the
  // client does, with a notice and Send disabled — only a client can send a request.
  const preview = usePortalPreview(organizationSlug);

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
      setFailure(t('NewClientRequestScreen.sayWhatYouNeed'));
      return;
    }
    if (description.trim() === '') {
      setFailure(t('NewClientRequestScreen.tellWhyMatters'));
      return;
    }
    if (preview) return;
    if (noProjectShared) {
      setFailure(t('NewClientRequestScreen.noProjectShared'));
      return;
    }
    if (chosenProjectId === '') {
      setFailure(t('NewClientRequestScreen.chooseProjectFirst'));
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
        setFailure(t('NewClientRequestScreen.portalNotAnswering'));
      } else {
        setFailure(t('NewClientRequestScreen.genericError'));
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
      title={sent ? t('NewClientRequestScreen.titleSent') : t('NewClientRequestScreen.titleAsk')}
      eyebrow={`${t('NewClientRequestScreen.askPrefix')} ${providerName} ${t('NewClientRequestScreen.askSuffix')}`}
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
              <InlineAlert tone="danger" title={t('NewClientRequestScreen.loadProjectsError')} live>
                {describe(projects.error)}
              </InlineAlert>
            ) : null}

            {projects.isPending ? (
              <LoadingRegion label={t('NewClientRequestScreen.loadingProjects')}>
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {/*
              REQ-04: when nothing has been shared there is nothing to ask about, and the person is
              told so before filling anything in. The form below ships disabled in this case, so
              Send cannot be reached and then refused.
            */}
            {noProjectShared ? (
              <InlineAlert
                tone="warning"
                title={t('NewClientRequestScreen.nothingToAskTitle')}
                live
              >
                {providerName} {t('NewClientRequestScreen.notSharedBody')}
              </InlineAlert>
            ) : null}

            {/*
              REQ-15: opened from an item's "Ask about this", so the item it is about is named here
              and already written into the description — the form is no longer a blank general one
              that never mentions what the person clicked.
            */}
            {aboutItemTitle && !noProjectShared ? (
              <InlineAlert tone="neutral" title={t('NewClientRequestScreen.askingAboutTitle')}>
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
                {preview ? (
                  <InlineAlert
                    tone="client"
                    title={t('NewClientRequestScreen.previewTitle' as MessageKey)}
                  >
                    {t('NewClientRequestScreen.previewBody' as MessageKey)}
                  </InlineAlert>
                ) : null}
                <div className="tm-pt-form">
                  <div className="tm-pt-form__title">
                    <Field
                      label={t('NewClientRequestScreen.requestLabel')}
                      name="title"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      hint={t('NewClientRequestScreen.requestHint')}
                      required
                      {...errorFor(fieldErrors, 'title')}
                    />
                  </div>

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-request-description">
                      {t('NewClientRequestScreen.whyItMatters')}
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
                      {t('NewClientRequestScreen.whyItMattersHint')}
                    </span>
                    {fieldErrors.get('description') ? (
                      <span className="tm-field__error">{fieldErrors.get('description')}</span>
                    ) : null}
                  </div>

                  <div className="tm-pt-form__pair">
                    <Field
                      label={t('NewClientRequestScreen.whenLabel')}
                      name="desiredAt"
                      type="date"
                      value={desiredDate}
                      onChange={(event) => setDesiredDate(event.target.value)}
                      dir="ltr"
                      hint={t('NewClientRequestScreen.whenHint')}
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
                          {t('NewClientRequestScreen.whichProject')}
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
                            {t('NewClientRequestScreen.chooseProject')}
                          </option>
                          {available.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                        <span className="tm-field__hint">
                          {t('NewClientRequestScreen.pickProject')} {providerName}{' '}
                          {t('NewClientRequestScreen.sharedMoreThanOne')}
                        </span>
                      </div>
                    ) : singleProject ? (
                      <div className="tm-field">
                        <span className="tm-field__label">
                          {t('NewClientRequestScreen.whichProject')}
                        </span>
                        <p className="tm-pt-fixed">{chosenProject?.name}</p>
                        <span className="tm-field__hint">
                          {t('NewClientRequestScreen.onlyProjectPrefix')} {providerName}{' '}
                          {t('NewClientRequestScreen.onlyProjectSuffix')}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  <div className="tm-pt-form__pair">
                    <Field
                      label={t('NewClientRequestScreen.categoryLabel')}
                      name="category"
                      value={category}
                      onChange={(event) => setCategory(event.target.value)}
                      hint={t('NewClientRequestScreen.categoryHint')}
                      {...errorFor(fieldErrors, 'category')}
                    />
                    <Field
                      label={t('NewClientRequestScreen.urgencyLabel')}
                      name="urgencyReason"
                      value={urgencyReason}
                      onChange={(event) => setUrgencyReason(event.target.value)}
                      hint={t('NewClientRequestScreen.urgencyHint')}
                      {...errorFor(fieldErrors, 'urgencyReason')}
                    />
                  </div>

                  <p className="tm-pt-eyebrow">{t('NewClientRequestScreen.visibleToStudio')}</p>
                </div>

                {failure ? (
                  <InlineAlert tone="danger" title={t('NewClientRequestScreen.sendError')} live>
                    {failure}
                  </InlineAlert>
                ) : null}

                <div className="tm-pt-form__actions">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={sending}
                    loadingLabel={t('NewClientRequestScreen.sending')}
                    disabled={projects.isPending || noProjectShared || preview}
                  >
                    {t('NewClientRequestScreen.sendRequest')}
                  </Button>
                </div>
              </fieldset>

              <div className="tm-pt-col">
                <section className="tm-pt-ink" aria-labelledby="tm-request-summary">
                  <h2 id="tm-request-summary" className="tm-pt-eyebrow">
                    {t('NewClientRequestScreen.whatHappensNext')}
                  </h2>
                  <p className="tm-pt-ink__title">
                    {providerName} {t('NewClientRequestScreen.readsItSuffix')}
                  </p>
                  <p className="tm-pt-quiet">{t('NewClientRequestScreen.dateWishQuiet')}</p>
                  <p className="tm-pt-quiet">
                    {t('NewClientRequestScreen.askedForColon')}{' '}
                    {desiredDate === ''
                      ? t('NewClientRequestScreen.noDate')
                      : formatDay(desiredDate)}
                  </p>
                </section>

                <section className="tm-pt-card" aria-labelledby="tm-request-audience">
                  <h2 id="tm-request-audience" className="tm-pt-eyebrow">
                    {t('NewClientRequestScreen.whoWillSee')}
                  </h2>
                  <p className="tm-pt-quiet">
                    {providerName}&rsquo;s {t('NewClientRequestScreen.audiencePart1')} {clientName}.{' '}
                    {t('NewClientRequestScreen.audiencePart2')} {providerName}{' '}
                    {t('NewClientRequestScreen.audiencePart3')}
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
  const t = useT();
  return (
    <div className="tm-pt-split tm-pt-split--aside">
      <section className="tm-pt-form" aria-labelledby="tm-request-sent">
        <h2 id="tm-request-sent" className="tm-pt-eyebrow">
          {t('NewClientRequestScreen.sent')}
        </h2>
        <InlineAlert tone="success" title={t('NewClientRequestScreen.titleSent')} live>
          <p className="tm-pt-card__title">{request.title}</p>
        </InlineAlert>
        <p className="tm-pt-aside-row">
          <span className="tm-pt-tag">{t('NewClientRequestScreen.askedForTag')}</span>
          <span className="tm-pt-quiet">
            {request.desiredAt === null
              ? t('NewClientRequestScreen.noDate')
              : formatDay(request.desiredAt)}
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
            {t('NewClientRequestScreen.seeThisRequest')}
          </Link>
          <Link className="tm-pt-btn" href={`/${organizationSlug}/portal/requests`}>
            {t('NewClientRequestScreen.allYourRequests')}
          </Link>
        </div>
      </section>

      <section className="tm-pt-ink" aria-labelledby="tm-request-next">
        <h2 id="tm-request-next" className="tm-pt-ink__title">
          {t('NewClientRequestScreen.nothingScheduledYet')}
        </h2>
        <p className="tm-pt-quiet">
          {t('NewClientRequestScreen.nothingScheduledPart1')} {providerName}{' '}
          {t('NewClientRequestScreen.nothingScheduledPart2')}
        </p>
      </section>
    </div>
  );
}

function errorFor(errors: ReadonlyMap<string, string>, field: string): { error?: string } {
  const message = errors.get(field);
  return message === undefined ? {} : { error: message };
}
