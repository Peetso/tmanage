'use client';

import { useState } from 'react';
import { DELIVERABLE_STATES, WORK_ITEM_STATES } from '@tmanage/domain';
import { Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { BackendPending } from './BackendPending';

/**
 * The four templates `22-SCREEN-BY-SCREEN` §3 names for ON-02: "Agency delivery, Software
 * studio, Consulting engagement, Blank later."
 *
 * The export's onboarding artboard names the same four differently — "Delivery with client
 * review", "Intake and commitment", "Internal delivery", "Start from empty" — and describes
 * them by what they enforce rather than by who uses them. The specification's names are used
 * because tickets and the traceability matrix cite them; the export's *description* is used,
 * because "6 states · internal review required · client approval binds a version" is what a
 * person actually needs to choose between them. That split follows `40-DESIGN-SYSTEM` §1:
 * the export governs composition, the specification governs behaviour and identifiers.
 *
 * ## Why the state lists come from `@tmanage/domain`
 *
 * `WORK_ITEM_STATES` and `DELIVERABLE_STATES` are the real machines from
 * `23-ERD-AND-STATE-MACHINES` §5 and §7, imported rather than retyped. A template preview
 * that listed its own copy of the states would drift the first time a state was added, and
 * the person choosing a template would be shown a workflow the system does not run.
 */
const TEMPLATES = [
  {
    value: 'agency-delivery',
    name: 'Agency delivery',
    summary: 'Client work that is reviewed internally, then published for client approval.',
    /** `true` when the template runs the deliverable machine as well as the work machine. */
    clientReview: true,
    rules: [
      'Work cannot reach client review before internal review passes.',
      'The person who authored a version cannot pass its internal review.',
      'Publication runs a safety check and generates a client projection.',
      'An approval is bound to one version; a new version invalidates it.',
    ],
  },
  {
    value: 'software-studio',
    name: 'Software studio',
    summary: 'Continuous delivery against milestones, with internal review but no client gate.',
    clientReview: false,
    rules: [
      'Work cannot reach done before internal review passes.',
      'Milestones advance on evidence rather than on a date passing.',
    ],
  },
  {
    value: 'consulting-engagement',
    name: 'Consulting engagement',
    summary: 'Requests from the same client, committed per cycle rather than per project.',
    clientReview: true,
    rules: [
      'A request is triaged before it becomes committed work.',
      'Commitments belong to a cycle and are visible to the client.',
    ],
  },
  {
    value: 'blank',
    name: 'Blank later',
    summary: 'Define your own states in the Control Center once you have run a project.',
    clientReview: false,
    rules: ['Nothing is enforced until you define it.'],
  },
] as const;

export interface OperatingTemplateScreenProps {
  signedInAs: string;
}

/**
 * **ON-02 Choose operating template.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Options: Agency delivery, Software studio, Consulting
 * engagement, Blank later. Explain included states/milestones; template remains editable by
 * authorized admin."
 *
 * "Explain" is the requirement this screen exists to meet, so choosing a template shows the
 * states it runs and the rules it enforces, in words, before the choice is made. The export
 * puts it plainly on the artboard: "The template is a workflow, not a theme."
 *
 * Nothing is saved. Templates are part of `TEN-001`'s unbuilt provisioning; there is no table
 * that holds a chosen template and no endpoint that would write one.
 */
export function OperatingTemplateScreen({ signedInAs }: OperatingTemplateScreenProps) {
  const [chosen, setChosen] = useState<string>(TEMPLATES[0].value);
  const template = TEMPLATES.find((candidate) => candidate.value === chosen) ?? TEMPLATES[0];

  return (
    <OnboardingShell
      current="ON-02"
      signedInAs={signedInAs}
      title="How work should move"
      description="The template is a workflow, not a theme. Here is exactly what each one does. An authorized admin can change it later."
    >
      <BackendPending ticket="TEN-001">
        The chosen template is not stored. There is no column for it and no endpoint that would
        write one.
      </BackendPending>

      <fieldset className="tm-fieldset">
        <legend className="tm-field__label">Operating template</legend>
        <div className="tm-stack tm-stack--tight">
          {TEMPLATES.map((option) => (
            <label key={option.value} className="tm-choice">
              <input
                className="tm-choice__input"
                type="radio"
                name="template"
                value={option.value}
                checked={chosen === option.value}
                onChange={() => setChosen(option.value)}
              />
              <span className="tm-choice__name">{option.name}</span>
              <span className="tm-choice__detail">{option.summary}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <section className="tm-panel tm-stack" aria-labelledby="tm-template-preview">
        <h2 id="tm-template-preview" className="tm-eyebrow">
          What this template enforces
        </h2>

        <div className="tm-stack tm-stack--tight">
          <p className="tm-prose">Work items move through {WORK_ITEM_STATES.length} states:</p>
          <ol className="tm-flow tm-list" aria-label="Work item states">
            {WORK_ITEM_STATES.map((state) => (
              <li key={state}>
                <StateCapsule state="neutral">{humanise(state)}</StateCapsule>
              </li>
            ))}
          </ol>
        </div>

        {template.clientReview ? (
          <div className="tm-stack tm-stack--tight">
            <p className="tm-prose">
              Deliverables published to the client move through {DELIVERABLE_STATES.length} states:
            </p>
            <ol className="tm-flow tm-list" aria-label="Deliverable states">
              {DELIVERABLE_STATES.map((state) => (
                <li key={state}>
                  <StateCapsule state="client">{humanise(state)}</StateCapsule>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <InlineAlert tone="neutral">
            This template has no publication step, so nothing is projected to a client portal.
          </InlineAlert>
        )}

        <ol className="tm-stack tm-stack--tight tm-list tm-list--numbered">
          {template.rules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ol>
      </section>

      <div className="tm-row">
        <Button tone="ink" size="accessible" disabled>
          Use this template
        </Button>
      </div>
    </OnboardingShell>
  );
}

/** `internal_review` reads as "Internal review". The stored value never changes. */
function humanise(state: string): string {
  const spaced = state.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
