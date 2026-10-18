'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { AppShell } from '../shell/AppShell';
import { OnboardingScreenStyles } from './CreateOrganizationScreen';
import { browserApiClient } from '../../lib/api/browser-client';
import { createProject, listWorkspaces } from '../../lib/api/projects';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
 *   internal.
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
}: FirstProjectScreenProps) {
  const api = client ?? browserApiClient();

  const [name, setName] = useState('');
  const [audience, setAudience] = useState<'client' | 'internal'>('client');
  const [targetDate, setTargetDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [serverDateError, setServerDateError] = useState<string | undefined>(undefined);

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

    if (name.trim() === '') {
      setFailure('Enter a project name.');
      return;
    }
    if (!workspaceId) {
      setFailure('This organization has no workspace to put a project in.');
      return;
    }

    setCreating(true);
    try {
      const created = await createProject(api, organizationSlug, {
        workspaceId,
        name: name.trim(),
        ...(targetDate === '' ? {} : { targetDate }),
      });
      onCreated?.(created.id);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const dateMessage = error.fieldErrors().get('targetDate');
        if (dateMessage !== undefined) {
          setServerDateError(dateMessage);
        } else {
          setFailure(error.message);
        }
      } else if (error instanceof NetworkError) {
        setFailure('The API did not answer. Is it running?');
      } else {
        setFailure('Something went wrong. Try again.');
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
        <InlineAlert tone="danger" title="Could not load this organization" live>
          {workspaces.error instanceof ApiRequestError
            ? workspaces.error.message
            : 'The API did not answer. Is it running?'}
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
            {mode === 'new' ? 'New project' : 'Your first project'}
          </legend>
          <Field
            label="Project name"
            name="projectName"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />

          <fieldset className="tm-fieldset tm-field">
            <legend className="tm-field__label tm-ob-legend">Who is this for</legend>
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
                A client
              </label>
              <label className="tm-ob-pill">
                <input
                  type="radio"
                  name="audience"
                  value="internal"
                  checked={audience === 'internal'}
                  onChange={() => setAudience('internal')}
                />
                Internal only
              </label>
            </div>
            <span className="tm-field__hint">
              {audience === 'client'
                ? 'The client organization and its portal are linked to the project after setup.'
                : 'No portal. You can switch one on later without recreating the project.'}
            </span>
          </fieldset>

          <div className="tm-ob-grid-2">
            {/*
              A statement rather than a picker.
              `22` §3 lists an owner field, and there is no endpoint that lists the people in an
              organization, and no ticket builds one. A select with one invented name in it would
              look like a choice and be a fiction; the API defaults the owner to the person
              creating the project, and this says so.
            */}
            <div className="tm-field">
              <span className="tm-field__label">Project owner</span>
              <div className="tm-ob-project__owner">
                <span className="tm-ob-avatar" aria-hidden="true">
                  {initialsOf(signedInAs || 'You')}
                </span>
                <span className="tm-ob-project__owner-name">{signedInAs || 'You'}</span>
              </div>
              <span className="tm-field__hint">
                {mode === 'new'
                  ? 'You, as the person creating it.'
                  : 'You, until your team has joined.'}
              </span>
            </div>

            <Field
              label="Target date"
              name="targetDate"
              type="date"
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
              dir="ltr"
              hint="A target, not a commitment, until a milestone plan is confirmed."
              {...(dateProblem === undefined ? {} : { error: dateProblem })}
            />
          </div>

          <div className="tm-field">
            <span className="tm-field__label">Default audience for new content</span>
            <div className="tm-ob-project__audience">
              <span className="tm-ob-project__square" aria-hidden="true">
                ■
              </span>
              <span>
                <strong>Default audience: internal</strong>
                <span className="tm-ob-project__audience-detail">
                  {' '}
                  — only your team can see new content until it is published.
                </span>
              </span>
              <span className="tm-ob-project__fixed" aria-hidden="true">
                Fixed
              </span>
            </div>
          </div>

          <hr className="tm-ob-rule" />

          <section className="tm-ob-project__preview" aria-labelledby="tm-project-summary">
            <h2 id="tm-project-summary" className="tm-ob-eyebrow">
              Live pulse track preview
            </h2>
            <ol className="tm-ob-track">
              <li className="tm-ob-capsule tm-ob-capsule--tall tm-ob-capsule--lime">
                START · TODAY
              </li>
              <li className="tm-ob-capsule tm-ob-capsule--tall tm-ob-capsule--grow">
                Milestones added next
              </li>
              <li className="tm-ob-capsule tm-ob-capsule--tall tm-ob-capsule--future">
                {targetDate === '' ? 'No target yet' : `Target ${formatDate(targetDate)}`}
              </li>
            </ol>
          </section>

          {workspaces.isPending ? (
            <LoadingRegion label="Loading this organization.">
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {failure ? (
            <InlineAlert tone="danger" title="Could not create the project" live>
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
              loadingLabel="Creating"
              disabled={workspaces.isPending}
            >
              Create project
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
        eyebrow="Projects"
        title="New project"
        description="Name it and, if you have one, give it a target date. You can add milestones, people and a client next."
      >
        {body}
      </AppShell>
    );
  }

  return (
    <OnboardingShell current="ON-03" signedInAs={signedInAs} title="Create your first project">
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
