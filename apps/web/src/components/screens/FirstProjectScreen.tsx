'use client';

import { useState } from 'react';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { BackendPending } from './BackendPending';

export interface FirstProjectScreenProps {
  signedInAs: string;
  /** Who the project can be owned by. Passed in — there is no people endpoint yet. */
  owners: readonly { readonly id: string; readonly name: string }[];
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
 * Nothing is created. `PROJ-001` built the repositories; the create-project endpoint and the
 * organization this project would belong to are both unwritten.
 */
export function FirstProjectScreen({ signedInAs, owners }: FirstProjectScreenProps) {
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<'client' | 'internal'>('client');
  const [ownerId, setOwnerId] = useState<string>(owners[0]?.id ?? '');
  const [targetDate, setTargetDate] = useState('');

  const dateProblem = describeDateProblem(targetDate);

  return (
    <OnboardingShell
      current="ON-03"
      signedInAs={signedInAs}
      title="Create your first project"
      description="One project is enough to start. Milestones, deliverables and the client portal all hang off it."
    >
      <BackendPending ticket="PROJ-002">
        Creating a project is not implemented. `PROJ-001` built the repositories underneath it; the
        endpoint and the organization it would belong to are both still to come.
      </BackendPending>

      <form className="tm-stack tm-stack--loose" onSubmit={(event) => event.preventDefault()}>
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

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-owner">
            Project owner
          </label>
          <select
            id="tm-owner"
            className="tm-field__control"
            value={ownerId}
            onChange={(event) => setOwnerId(event.target.value)}
          >
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </select>
          <span className="tm-field__hint">
            The person accountable for the project. It can be changed at any time.
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

        <div className="tm-row">
          <Button type="submit" tone="ink" size="accessible" disabled>
            Continue to milestones
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
