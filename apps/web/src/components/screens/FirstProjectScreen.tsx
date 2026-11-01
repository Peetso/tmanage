'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { hasCapability, isInternalRole } from '@tmanage/domain';
import {
  Button,
  Checkbox,
  Combobox,
  Field,
  InlineAlert,
  LoadingRegion,
  Skeleton,
} from '@tmanage/ui';
import { OnboardingShell, type OnboardingStepId } from '../shell/OnboardingShell';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { OnboardingScreenStyles } from './CreateOrganizationScreen';
import { browserApiClient } from '../../lib/api/browser-client';
import { createProject, listWorkspaces } from '../../lib/api/projects';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  createClientOrganization,
  listClientOrganizationOptions,
  setProjectClient,
} from '../../lib/api/project-client';
import { listOrganizations } from '../../lib/api/organizations';
import { useProjectClientT } from '../projects/ShareWithClientDialog';

/** The picker's two rows that are not a client company. */
const CLIENT_INTERNAL = '__internal';
const CLIENT_NEW = '__new';

export interface FirstProjectScreenProps {
  signedInAs: string;
  /** The organization this project goes in. From the route, which the guard resolves. */
  organizationSlug: string;
  client?: ApiClient;
  /** Called with the new project's id once it exists. */
  onCreated?: (projectId: string) => void;
  /**
   * `onboarding` (default) is ON-03 inside the onboarding frame. `new` is the same form for
   * every project after the first, reached from "New project": it sits in the app shell so the
   * rail stays, and is titled for a project rather than a first project.
   */
  mode?: 'onboarding' | 'new';
  /** The organization's display name for the app shell's eyebrow (`new` mode only). */
  organizationName?: string;
  /** Onboarding steps already finished, for the stepper (`onboarding` mode only). */
  completedSteps?: readonly OnboardingStepId[];
}

/**
 * **ON-03 Create first project.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Fields: name, client/internal, project owner, target date,
 * timezone, template. Date is marked target until milestone plan confirmed."
 *
 * That last sentence is the whole reason this screen is careful about one word. A date
 * entered here is a **target**, not a commitment, and the screen says so beside the field and
 * again in the summary. The design language draws the distinction as well — the export's
 * pulse track separates "committed" from "forecast" from "desired" — and a screen that
 * collected a date and called it the launch date would have made a promise on the team's
 * behalf before anyone had planned the work.
 *
 * The default audience is Internal and is not editable here. `25-AUTHORIZATION-AND-TENANT-
 * ISOLATION-SPEC` makes audience the control that decides what a client can ever see, and a
 * project whose default audience was chosen on a setup screen — before any content exists —
 * is a project that can leak by default. Widening it is a deliberate act on the project
 * itself, later, by someone with the capability to do it.
 *
 * ## What is real, and what is still collected and dropped
 *
 * The project, its name and its target date are created for real as of `PROJ-001`. Two of the
 * fields the specification lists are not:
 *
 * - **Client or internal.** `projects` has no audience column; a project is shared with a
 *   client by linking it to a client organization in `project_clients`. `CLIENT-001` shipped
 *   that link and its endpoint, so the gap is this screen's rather than the API's: onboarding
 *   does not call it. The choice is collected, marked as not yet saved, and the default stays
 *   internal. `new` mode replaces the choice with a Client picker (BK1, Figma t5-c) that does
 *   save it: `POST /projects`, then `PUT projects/:id/client`.
 * - **The owner.** There is no endpoint that lists the people in an organization, and
 *   `28-SPRINT-TICKETS` schedules no ticket that builds one — so the API defaults the owner to
 *   whoever created the project, and this screen says so rather than offering a picker with one
 *   invented name in it.
 */
export function FirstProjectScreen({
  signedInAs,
  organizationSlug,
  client,
  onCreated,
  mode = 'onboarding',
  organizationName = '',
  completedSteps,
}: FirstProjectScreenProps) {
  const t = useT();
  const tc = useProjectClientT();
  const api = client ?? browserApiClient();

  const [name, setName] = useState('');
  const [audience, setAudience] = useState<'client' | 'internal'>('client');
  const [targetDate, setTargetDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [serverDateError, setServerDateError] = useState<string | undefined>(undefined);

  /*
    `new` mode: the Client picker (BK1 / PRJ-02, Figma t5-c). The project is created first and its
    client set after (`PUT projects/:id/client`), so a refusal of the second step — an archived
    company is a 422 — leaves a project that exists. The ids made so far are kept, so pressing
    Create again retries only the step that failed instead of making a second project or client.
  */
  const [clientChoice, setClientChoice] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [clientError, setClientError] = useState<string | undefined>(undefined);
  const [createdProjectId, setCreatedProjectId] = useState<string | undefined>(undefined);
  const [createdClientId, setCreatedClientId] = useState<string | undefined>(undefined);

  const clientOptions = useQuery({
    queryKey: ['client-organization-options', organizationSlug],
    queryFn: () => listClientOrganizationOptions(api, organizationSlug),
    enabled: mode === 'new',
  });
  // The caller's role, from the session's organization list, and only in `new` mode: onboarding
  // does not offer the picker. Its own key, because the shell's reads through the browser client
  // and this one through the injected `api`.
  const organizations = useQuery({
    queryKey: ['first-project', 'organizations'],
    queryFn: () => listOrganizations(api),
    staleTime: 5 * 60_000,
    enabled: mode === 'new',
  });
  const callerRole = organizations.data?.find((org) => org.slug === organizationSlug)?.role;
  const canAddClient =
    callerRole !== undefined &&
    isInternalRole(callerRole) &&
    hasCapability(callerRole, 'org.manage');
  const pickerOptions = [
    ...(clientOptions.data ?? []).map((option) => ({ value: option.id, label: option.name })),
    { value: CLIENT_INTERNAL, label: tc('ProjectClient.noClientOption') },
    ...(canAddClient ? [{ value: CLIENT_NEW, label: tc('ProjectClient.addClientOption') }] : []),
  ];
  const sharesWithClient =
    mode === 'new' && clientChoice !== '' && clientChoice !== CLIENT_INTERNAL;

  /**
   * The workspace the project goes in.
   *
   * Fetched rather than assumed. Provisioning creates exactly one, so in practice this is a
   * list of one — but an organization gains a second the moment anyone adds one, and a screen
   * that had hard-coded "the first" would then be filing projects in the wrong place silently.
   */
  const workspaces = useQuery({
    queryKey: ['workspaces', organizationSlug],
    queryFn: () => listWorkspaces(api, organizationSlug),
  });

  const workspaceId = workspaces.data?.[0]?.id;
  const localDateProblem = describeDateProblem(targetDate);
  const dateProblem = localDateProblem ?? serverDateError;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    setServerDateError(undefined);
    setClientError(undefined);

    if (name.trim() === '') {
      setFailure(t('FirstProjectScreen.nameRequired'));
      return;
    }
    if (!workspaceId) {
      setFailure(t('FirstProjectScreen.noWorkspace'));
      return;
    }

    if (sharesWithClient && clientChoice === CLIENT_NEW && newClientName.trim() === '') {
      setClientError(tc('ProjectClient.newClientNameRequired'));
      return;
    }

    setCreating(true);
    let step: 'project' | 'client' = 'project';
    try {
      let clientOrganizationId: string | undefined;
      if (sharesWithClient) {
        if (clientChoice === CLIENT_NEW) {
          step = 'client';
          clientOrganizationId =
            createdClientId ??
            (await createClientOrganization(api, organizationSlug, newClientName.trim())).id;
          setCreatedClientId(clientOrganizationId);
          step = 'project';
        } else {
          clientOrganizationId = clientChoice;
        }
      }

      const projectId =
        createdProjectId ??
        (
          await createProject(api, organizationSlug, {
            workspaceId,
            name: name.trim(),
            ...(targetDate === '' ? {} : { targetDate }),
          })
        ).id;
      setCreatedProjectId(projectId);

      if (clientOrganizationId !== undefined) {
        step = 'client';
        await setProjectClient(api, organizationSlug, projectId, clientOrganizationId);
      }
      onCreated?.(projectId);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const fields = error.fieldErrors();
        const dateMessage = fields.get('targetDate');
        if (step === 'client') {
          setClientError(fields.get('clientOrganizationId') ?? fields.get('name') ?? error.message);
        } else if (dateMessage !== undefined) {
          setServerDateError(dateMessage);
        } else {
          setFailure(error.message);
        }
      } else if (error instanceof NetworkError) {
        setFailure(t('FirstProjectScreen.apiNoAnswer'));
      } else {
        setFailure(t('FirstProjectScreen.genericError'));
      }
    } finally {
      setCreating(false);
    }
  }

  const body = (
    <>
      <OnboardingScreenStyles />
      <style href="tm-onboarding-project" precedence="default">
        {PROJECT_CSS}
      </style>

      {workspaces.isError ? (
        <InlineAlert tone="danger" title={t('FirstProjectScreen.loadErrorTitle')} live>
          {workspaces.error instanceof ApiRequestError
            ? workspaces.error.message
            : t('FirstProjectScreen.apiNoAnswer')}
        </InlineAlert>
      ) : null}

      <form className="tm-ob-project" noValidate onSubmit={submit}>
        {/*
          The controls take nothing until this screen's data has arrived. "Create project" has
          always carried `disabled={workspaces.isPending}`; the fields did not, so on a cold page
          a person could type a project name before React hydrated — the DOM held the word, no
          listener existed, `name` stayed `''`, and hydration re-applied `value=''` and wiped it.
          They then met "Enter a project name." over a field they had just filled in. The
          server-rendered HTML has `isPending === true`, so the controls ship disabled and become
          editable only once React is live and the workspaces query has answered. `isError` means
          `isPending === false`, so a failed load leaves the form editable and the alert above it
          explains itself.
        */}
        <fieldset className="tm-fieldset tm-ob-sheet" disabled={workspaces.isPending}>
          <legend className="tm-visually-hidden">
            {mode === 'new'
              ? t('FirstProjectScreen.legendNew')
              : t('FirstProjectScreen.legendFirst')}
          </legend>
          <Field
            label={t('FirstProjectScreen.projectNameLabel')}
            name="projectName"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />

          {mode === 'new' ? (
            <>
              <Combobox
                label={tc('ProjectClient.clientLabel')}
                name="clientOrganization"
                placeholder={tc('ProjectClient.clientPlaceholder')}
                options={pickerOptions}
                value={clientChoice}
                onValueChange={(value) => {
                  setClientChoice(value);
                  setClientError(undefined);
                }}
                emptyLabel={tc('ProjectClient.noMatches')}
                openOnFocus
                {...(clientError === undefined || clientChoice === CLIENT_NEW
                  ? {}
                  : { error: clientError })}
              />
              {clientOptions.isError ? (
                <InlineAlert tone="danger" title={tc('ProjectClient.optionsLoadError')} live>
                  {clientOptions.error instanceof ApiRequestError
                    ? clientOptions.error.message
                    : t('FirstProjectScreen.apiNoAnswer')}
                </InlineAlert>
              ) : null}
              {clientChoice === CLIENT_NEW ? (
                <Field
                  label={tc('ProjectClient.newClientNameLabel')}
                  name="newClientName"
                  value={newClientName}
                  onChange={(event) => setNewClientName(event.target.value)}
                  hint={tc('ProjectClient.newClientNameHint')}
                  {...(clientError === undefined ? {} : { error: clientError })}
                />
              ) : null}
              {sharesWithClient ? (
                <Checkbox
                  label={tc('ProjectClient.shareAfterFirstUpdate')}
                  hint={tc('ProjectClient.shareAfterFirstUpdateHint')}
                  checked
                  disabled
                  readOnly
                />
              ) : null}
            </>
          ) : (
            <fieldset className="tm-fieldset tm-field">
              <legend className="tm-field__label tm-ob-legend">
                {t('FirstProjectScreen.audienceLegend')}
              </legend>
              <div className="tm-ob-pills">
                <label className="tm-ob-pill tm-ob-pill--client">
                  <input
                    type="radio"
                    name="audience"
                    value="client"
                    checked={audience === 'client'}
                    onChange={() => setAudience('client')}
                  />
                  <span className="tm-ob-pill__ring" aria-hidden="true">
                    ◎
                  </span>
                  {t('FirstProjectScreen.audienceClient')}
                </label>
                <label className="tm-ob-pill">
                  <input
                    type="radio"
                    name="audience"
                    value="internal"
                    checked={audience === 'internal'}
                    onChange={() => setAudience('internal')}
                  />
                  {t('FirstProjectScreen.audienceInternal')}
                </label>
              </div>
              <span className="tm-field__hint">
                {audience === 'client'
                  ? t('FirstProjectScreen.audienceClientHint')
                  : t('FirstProjectScreen.audienceInternalHint')}
              </span>
            </fieldset>
          )}

          <div className="tm-ob-grid-2">
            {/*
              A statement rather than a picker.
              `22` §3 lists an owner field, and there is no endpoint that lists the people in an
              organization, and no ticket builds one. A select with one invented name in it would
              look like a choice and be a fiction; the API defaults the owner to the person
              creating the project, and this says so.
            */}
            <div className="tm-field">
              <span className="tm-field__label">{t('FirstProjectScreen.ownerLabel')}</span>
              <div className="tm-ob-project__owner">
                <span className="tm-ob-avatar" aria-hidden="true">
                  {/* No identity yet: one letter of "You", not "YO" (live test 2026-10-31). */}
                  {signedInAs && signedInAs !== 'You'
                    ? initialsOf(signedInAs)
                    : t('FirstProjectScreen.you').charAt(0).toUpperCase()}
                </span>
                <span className="tm-ob-project__owner-name">
                  {signedInAs || t('FirstProjectScreen.you')}
                </span>
              </div>
              <span className="tm-field__hint">
                {mode === 'new'
                  ? t('FirstProjectScreen.ownerHintNew')
                  : t('FirstProjectScreen.ownerHintFirst')}
              </span>
            </div>

            <Field
              label={t('FirstProjectScreen.targetDateLabel')}
              name="targetDate"
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
              dir="ltr"
              hint={t('FirstProjectScreen.targetDateHint')}
              {...(dateProblem === undefined ? {} : { error: dateProblem })}
            />
          </div>

          <div className="tm-field">
            <span className="tm-field__label">{t('FirstProjectScreen.defaultAudienceLabel')}</span>
            <div className="tm-ob-project__audience">
              <span className="tm-ob-project__square" aria-hidden="true">
                ■
              </span>
              <span>
                <strong>{t('FirstProjectScreen.defaultAudienceValue')}</strong>
                <span className="tm-ob-project__audience-detail">
                  {' '}
                  {t('FirstProjectScreen.defaultAudienceDetail')}
                </span>
              </span>
              <span className="tm-ob-project__fixed" aria-hidden="true">
                {t('FirstProjectScreen.fixed')}
              </span>
            </div>
          </div>

          <hr className="tm-ob-rule" />

          <section className="tm-ob-project__preview" aria-labelledby="tm-project-summary">
            <h2 id="tm-project-summary" className="tm-ob-eyebrow">
              {t('FirstProjectScreen.previewHeading')}
            </h2>
            <ol className="tm-ob-track">
              <li className="tm-ob-capsule tm-ob-capsule--tall tm-ob-capsule--lime">
                {t('FirstProjectScreen.capsuleStart')}
              </li>
              <li className="tm-ob-capsule tm-ob-capsule--tall tm-ob-capsule--grow">
                {t('FirstProjectScreen.capsuleMilestones')}
              </li>
              <li className="tm-ob-capsule tm-ob-capsule--tall tm-ob-capsule--future">
                {targetDate === ''
                  ? t('FirstProjectScreen.capsuleNoTarget')
                  : `${t('FirstProjectScreen.capsuleTargetPrefix')} ${formatDate(targetDate)}`}
              </li>
            </ol>
          </section>

          {workspaces.isPending ? (
            <LoadingRegion label={t('FirstProjectScreen.loadingOrg')}>
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {failure ? (
            <InlineAlert tone="danger" title={t('FirstProjectScreen.createErrorTitle')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-ob-actions">
            <Button
              type="submit"
              tone="ink"
              size="feature"
              className="tm-ob-cta"
              loading={creating}
              loadingLabel={t('FirstProjectScreen.creating')}
              disabled={workspaces.isPending}
            >
              {t('FirstProjectScreen.submit')}
            </Button>
          </div>
        </fieldset>
      </form>
    </>
  );

  if (mode === 'new') {
    return (
      <AppShell
        organizationSlug={organizationSlug}
        organizationName={organizationName}
        activeNavigationId="work"
        eyebrow={t('FirstProjectScreen.newEyebrow')}
        title={t('FirstProjectScreen.newTitle')}
        description={t('FirstProjectScreen.newDescription')}
      >
        {body}
      </AppShell>
    );
  }

  return (
    <OnboardingShell
      current="ON-03"
      signedInAs={signedInAs}
      {...(completedSteps === undefined ? {} : { completed: completedSteps })}
      title={t('FirstProjectScreen.onboardingTitle')}
    >
      {body}
    </OnboardingShell>
  );
}

/** "omar@northstar.studio" → "OM"; "Omar Adel" → "OA". Decoration only — the name is beside it. */
function initialsOf(identity: string): string {
  const local = identity.split('@')[0] ?? identity;
  const words = local.split(/[\s._-]+/).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : local.slice(0, 2);
  return letters.toUpperCase();
}

const PROJECT_CSS = `
.tm-ob-project { max-inline-size: 700px; }
.tm-ob-project > .tm-ob-sheet { gap: 16px; padding: 26px; }
.tm-ob-project__owner, .tm-ob-project__audience {
  display: flex; align-items: center; gap: 10px; min-block-size: 50px; padding: 0 14px;
  border-radius: var(--r-control); background: var(--paper-50); color: var(--ink-950);
  font-size: var(--t-ui-sm); line-height: var(--t-ui-sm-line); font-weight: 500;
}
.tm-ob-project__owner { border: var(--b-quiet) solid var(--line-300); }
.tm-ob-project__owner-name { min-inline-size: 0; overflow-wrap: anywhere; }
.tm-ob-project__audience strong { font-weight: 500; }
.tm-ob-project__audience-detail { color: var(--ink-650); font-weight: 400; }
.tm-ob-project__square {
  flex-shrink: 0; display: grid; place-items: center; inline-size: 20px; block-size: 20px;
  border: var(--b-structural) solid var(--ink-800); border-radius: var(--r-capsule);
  font: 600 9px/1 var(--font-mono); color: var(--ink-800);
}
.tm-ob-project__fixed {
  margin-inline-start: auto; font-family: var(--font-mono); font-size: 11px; line-height: 15px;
  text-transform: uppercase; color: var(--ink-500);
}
.tm-ob-project__preview { display: flex; flex-direction: column; gap: 10px; }
.tm-ob-project .tm-ob-track { flex-wrap: nowrap; }
@media (max-width: 40rem) {
  .tm-ob-project .tm-ob-track { flex-wrap: wrap; }
}
`;

/**
 * The one date rule this screen can enforce without a server: a target in the past.
 *
 * It is a warning-shaped refusal rather than a hard block in the copy, because a team
 * importing a project that is already late has a legitimate reason to enter one — but the
 * field says so rather than accepting it silently.
 */
function describeDateProblem(value: string): string | undefined {
  if (value === '') return undefined;
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return 'That is not a date we can read.';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (parsed.getTime() < today.getTime()) {
    return 'That date has passed. Enter it anyway if the project is already late, and set milestones to say why.';
  }
  return undefined;
}

function formatDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(parsed);
}
