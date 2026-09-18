'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { BackendPending } from './BackendPending';
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

  return (
    <OnboardingShell
      current="ON-03"
      signedInAs={signedInAs}
      title="Create your first project"
      description="One project is enough to start. Milestones, deliverables and the client portal all hang off it."
    >
      <BackendPending ticket="this screen's client link · a people directory, unscheduled">
        The project itself is created. Choosing a client and choosing an owner are not saved yet. A
        project is shared with a client by linking it to a client organization, and this step does
        not do that linking yet; nothing in this system lists the people in your organization
        either, so there is nobody else to choose. The owner will be you.
      </BackendPending>

      {workspaces.isError ? (
        <InlineAlert tone="danger" title="Could not load this organization" live>
          {workspaces.error instanceof ApiRequestError
            ? workspaces.error.message
            : 'The API did not answer. Is it running?'}
        </InlineAlert>
      ) : null}

      <form className="tm-stack tm-stack--loose" noValidate onSubmit={submit}>
        <Field
          label="Project name"
          name="projectName"
          value={name}
          onChange={(event) => setName(event.target.value)}
          hint="What your team calls it. Clients see this name too."
          required
        />

        <fieldset className="tm-fieldset">
          <legend className="tm-field__label">Who is this for</legend>
          <div className="tm-stack tm-stack--tight">
            <label className="tm-choice">
              <input
                className="tm-choice__input"
                type="radio"
                name="audience"
                value="client"
                checked={audience === 'client'}
                onChange={() => setAudience('client')}
              />
              <span className="tm-choice__name">A client</span>
              <span className="tm-choice__detail">
                A client organization and a portal can be set up for it in the next steps.
              </span>
            </label>
            <label className="tm-choice">
              <input
                className="tm-choice__input"
                type="radio"
                name="audience"
                value="internal"
                checked={audience === 'internal'}
                onChange={() => setAudience('internal')}
              />
              <span className="tm-choice__name">Internal only</span>
              <span className="tm-choice__detail">
                No portal. You can switch one on later without recreating the project.
              </span>
            </label>
          </div>
        </fieldset>

        {/*
          A statement rather than a picker.
          `22` §3 lists an owner field, and there is no endpoint that lists the people in an
          organization, and no ticket builds one. A select with one invented name in it would
          look like a choice and be a fiction; the API defaults the owner to the person
          creating the project, and this says so.
        */}
        <div className="tm-field">
          <span className="tm-field__label">Project owner</span>
          <p className="tm-prose">{signedInAs}</p>
          <span className="tm-field__hint">
            You, because there is nobody else in this organization yet. It can be changed at any
            time once you have invited your team.
          </span>
        </div>

        <Field
          label="Target date"
          name="targetDate"
          type="date"
          value={targetDate}
          onChange={(event) => setTargetDate(event.target.value)}
          dir="ltr"
          hint="A target, not a commitment. It stays a target until a milestone plan is confirmed."
          {...(dateProblem === undefined ? {} : { error: dateProblem })}
        />

        <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-project-summary">
          <h2 id="tm-project-summary" className="tm-eyebrow">
            What will be created
          </h2>
          <div className="tm-row">
            <StateCapsule state="future">
              {audience === 'client' ? 'For a client' : 'Internal'}
            </StateCapsule>
            <span className="tm-prose">Not saved yet</span>
          </div>
          <div className="tm-row">
            <StateCapsule state="future">Target</StateCapsule>
            <span className="tm-prose">
              {targetDate === '' ? 'No date yet' : formatDate(targetDate)}
            </span>
          </div>
          <InlineAlert tone="neutral" title="Default audience: internal">
            New content in this project starts internal. Publishing to the client is a separate,
            deliberate act with its own safety check.
          </InlineAlert>
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

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={creating}
            loadingLabel="Creating"
            disabled={workspaces.isPending}
          >
            Create project
          </Button>
        </div>
      </form>
    </OnboardingShell>
  );
}

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
