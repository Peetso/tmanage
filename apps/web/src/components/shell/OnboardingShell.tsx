import type { ReactNode } from 'react';
import { LiveAnnouncer, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';

/**
 * The onboarding sequence, in the order `22-SCREEN-BY-SCREEN` §3 gives it.
 *
 * The screen ids here are the **specification's**, not the design export's. The export's
 * onboarding artboards number the same material differently — it opens with a "Welcome /
 * what do you deliver" step and inserts a milestones step — so its `ON-04` is the
 * specification's `ON-03`. The specification wins for identifiers because tickets, the
 * traceability matrix and the test catalog all cite it; the export wins for composition, per
 * `40-DESIGN-SYSTEM` §1. The mapping is recorded in `docs/implementation-status.md` so
 * neither document has to be edited to agree with the other.
 */
export const ONBOARDING_STEPS = [
  { id: 'ON-01', slug: 'organization', label: 'Organization' },
  { id: 'ON-02', slug: 'template', label: 'Operating template' },
  { id: 'ON-03', slug: 'project', label: 'First project' },
  { id: 'ON-04', slug: 'team', label: 'Team' },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]['id'];

export interface OnboardingShellProps {
  current: OnboardingStepId;
  /** The person's identity line — the export shows "Signed in as …" throughout. */
  signedInAs: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}

/**
 * The frame for the onboarding sequence — specification screens ON-01 to ON-04.
 *
 * The step list is an ordered list with `aria-current="step"` on the active entry, and each
 * completed step says the word "done" in text that is available to a screen reader. A
 * progress indicator that is only a row of coloured circles tells a non-visual reader
 * nothing, and the token export's third law — every state that uses colour also carries a
 * word and a shape — applies to progress as much as to a status capsule.
 *
 * Steps are not links. Nothing in this sequence can be jumped to: `ON-03` needs the
 * organization `ON-01` creates, and `ON-04` needs the project from `ON-03`. Rendering them
 * as links would offer a navigation that the API would then have to refuse.
 */
export function OnboardingShell({
  current,
  signedInAs,
  title,
  description,
  children,
}: OnboardingShellProps) {
  const currentIndex = ONBOARDING_STEPS.findIndex((step) => step.id === current);

  return (
    <LiveAnnouncer>
      <div className="tm-onboarding">
        <SkipLink targetId="tm-main" />

        <header className="tm-onboarding__header">
          <Wordmark />
          {/* Empty until an endpoint returns the signed-in person's own address; never a sample one. */}
          {signedInAs ? (
            <p className="tm-onboarding__identity tm-mono">Signed in as {signedInAs}</p>
          ) : null}
        </header>

        <div className="tm-onboarding__body">
          <nav className="tm-onboarding__steps" aria-label="Setup progress">
            <ol className="tm-onboarding__step-list">
              {ONBOARDING_STEPS.map((step, index) => {
                const state =
                  index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'future';
                return (
                  <li
                    key={step.id}
                    className="tm-onboarding__step"
                    data-state={state}
                    {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
                  >
                    <span className="tm-onboarding__step-index tm-mono" aria-hidden="true">
                      {state === 'done' ? '✓' : index + 1}
                    </span>
                    <span className="tm-onboarding__step-label">{step.label}</span>
                    <span className="tm-visually-hidden">
                      {state === 'done'
                        ? ' — done'
                        : state === 'current'
                          ? ' — current step'
                          : ' — not started'}
                    </span>
                  </li>
                );
              })}
            </ol>

            <p className="tm-onboarding__step-count tm-mono">
              Step {currentIndex + 1} of {ONBOARDING_STEPS.length}
            </p>
          </nav>

          <main id="tm-main" className="tm-onboarding__canvas" tabIndex={-1}>
            <h1 className="tm-onboarding__title">{title}</h1>
            {description ? <p className="tm-onboarding__description">{description}</p> : null}
            {children}
          </main>
        </div>
      </div>
    </LiveAnnouncer>
  );
}
