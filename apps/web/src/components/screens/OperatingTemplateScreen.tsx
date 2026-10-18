'use client';

import { useEffect, useRef, useState } from 'react';
import { DELIVERABLE_STATES, WORK_ITEM_STATES } from '@tmanage/domain';
import { Button, InlineAlert } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { OnboardingScreenStyles } from './CreateOrganizationScreen';
import { useHydrated } from '../../lib/use-hydrated';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { readOrgSettings, setOrgSetting } from '../../lib/api/org-settings';

/**
 * The four templates of ON-03, named as the approved design names them — "Delivery with client
 * review", "Intake and commitment", "Internal delivery", "Start from empty" — which describe a
 * template by what it enforces rather than by who uses it. (`22-SCREEN-BY-SCREEN` §3 calls the
 * same four "Agency delivery, Software studio, Consulting engagement, Blank later".) The values
 * are the API's `org_settings.operating_template` values.
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
    value: 'delivery-client-review',
    name: 'Delivery with client review',
    summary: 'Internal review required · client approval binds a version',
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
    value: 'intake-commitment',
    name: 'Intake and commitment',
    summary: 'Triage step · commitment per cycle',
    clientReview: true,
    rules: [
      'A request is triaged before it becomes committed work.',
      'Commitments belong to a cycle and are visible to the client.',
    ],
  },
  {
    value: 'internal-delivery',
    name: 'Internal delivery',
    summary: 'No publication step',
    clientReview: false,
    rules: [
      'Work cannot reach done before internal review passes.',
      'Milestones advance on evidence rather than on a date passing.',
    ],
  },
  {
    value: 'empty',
    name: 'Start from empty',
    summary: 'Define your own states later in Control Center',
    clientReview: false,
    rules: ['Nothing is enforced until you define it.'],
  },
] as const;

export interface OperatingTemplateScreenProps {
  signedInAs: string;
  /** The organization the template is saved to. */
  organizationSlug: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Moves on to the next step of the sequence. */
  onContinue?: () => void;
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
 * Composition is the export's ON-03 artboard: the template cards in a 250px column, the
 * workflow preview in a white sheet beside them — the states as a row of capsules joined by
 * arrows, the rules as a numbered list on ink discs.
 *
 * The choice is stored as the organization's `operating_template` setting. The card starts on
 * the template created with the organization (from ON-01's work type); "Use this template"
 * saves the chosen one, then moves the sequence on.
 */
export function OperatingTemplateScreen({
  signedInAs,
  organizationSlug,
  client,
  onContinue,
}: OperatingTemplateScreenProps) {
  const api = client ?? browserApiClient();
  // The template radios are controlled inputs in the server HTML with no query behind them, so a
  // choice made on a cold page would be re-applied to the default by hydration. The picker is
  // disabled until React is live: `false` in the server render, `true` on the first client render.
  const hydrated = useHydrated();

  const [chosen, setChosen] = useState<string>(TEMPLATES[0].value);
  const touched = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  // Start on the template already saved. A failed read leaves the default chosen: saving still
  // works, and the save is what reports a refusal.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const view = await readOrgSettings(api, organizationSlug);
        const saved = view.settings.find((entry) => entry.key === 'operating_template')?.value;
        if (live && !touched.current && TEMPLATES.some((option) => option.value === saved)) {
          setChosen(saved as string);
        }
      } catch {
        // Keep the default; the save reports any refusal.
      }
    })();
    return () => {
      live = false;
    };
    // Read once per organization; `api` is a fresh client per render when none is injected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationSlug]);

  async function saveTemplate() {
    setFailure(undefined);
    setSaving(true);
    try {
      await setOrgSetting(api, organizationSlug, 'operating_template', chosen);
      onContinue?.();
    } catch (error) {
      setFailure(
        error instanceof ApiRequestError ? error.message : 'The template could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }
  const template = TEMPLATES.find((candidate) => candidate.value === chosen) ?? TEMPLATES[0];

  return (
    <OnboardingShell current="ON-02" signedInAs={signedInAs} title="How work should move">
      <OnboardingScreenStyles />
      <style href="tm-onboarding-template" precedence="default">
        {TEMPLATE_CSS}
      </style>
      <p className="tm-ob-lede">
        The template is a workflow, not a theme. Here is exactly what each one does.
      </p>

      <div className="tm-ob-template">
        <fieldset className="tm-fieldset tm-ob-template__list" disabled={!hydrated}>
          <legend className="tm-visually-hidden">Operating template</legend>
          {TEMPLATES.map((option) => (
            <label
              key={option.value}
              className="tm-ob-tcard"
              data-blank={option.value === 'empty' ? 'true' : undefined}
            >
              <input
                type="radio"
                name="template"
                value={option.value}
                checked={chosen === option.value}
                onChange={() => {
                  touched.current = true;
                  setChosen(option.value);
                }}
              />
              <span className="tm-ob-tcard__name">{option.name}</span>
              <span className="tm-ob-tcard__detail">{option.summary}</span>
            </label>
          ))}
        </fieldset>

        <section
          className="tm-ob-sheet tm-ob-template__preview"
          aria-labelledby="tm-template-preview"
        >
          <h2 id="tm-template-preview" className="tm-ob-eyebrow">
            Workflow preview · what this template enforces
          </h2>

          <div className="tm-ob-template__machine">
            <p className="tm-ob-template__caption">
              Work items move through {WORK_ITEM_STATES.length} states:
            </p>
            <ol className="tm-ob-track tm-ob-arrows" aria-label="Work item states">
              {WORK_ITEM_STATES.map((state, index) => (
                <li key={state}>
                  <span
                    className={`tm-ob-capsule ${
                      index === WORK_ITEM_STATES.length - 1
                        ? 'tm-ob-capsule--future'
                        : 'tm-ob-capsule--ink'
                    }`}
                  >
                    {humanise(state)}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          {template.clientReview ? (
            <div className="tm-ob-template__machine">
              <p className="tm-ob-template__caption">
                Deliverables published to the client move through {DELIVERABLE_STATES.length}{' '}
                states:
              </p>
              <ol className="tm-ob-track tm-ob-arrows" aria-label="Deliverable states">
                {DELIVERABLE_STATES.map((state, index) => (
                  <li key={state}>
                    <span className={`tm-ob-capsule ${deliverablePaint(state, index)}`}>
                      {humanise(state)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="tm-ob-note">
              <span className="tm-ob-glyph" aria-hidden="true">
                i
              </span>
              <p>
                This template has no publication step, so nothing is projected to a client portal.
              </p>
            </div>
          )}

          <hr className="tm-ob-rule" />

          <ol className="tm-ob-template__rules" aria-label="What it enforces">
            {template.rules.map((rule, index) => (
              <li key={rule}>
                <span className="tm-ob-glyph tm-ob-glyph--ink" aria-hidden="true">
                  {index + 1}
                </span>
                <span>{rule}</span>
              </li>
            ))}
          </ol>

          {failure ? (
            <InlineAlert tone="danger" title="Could not save the template" live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-ob-actions">
            <Button
              tone="ink"
              size="feature"
              disabled={!hydrated}
              loading={saving}
              loadingLabel="Saving"
              onClick={() => void saveTemplate()}
            >
              Use this template
            </Button>
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}

/** ON-03's paint: the gate the client acts in is lime, the settled states quiet, the end dashed. */
function deliverablePaint(state: string, index: number): string {
  if (state === 'client_review') return 'tm-ob-capsule--lime';
  if (index === DELIVERABLE_STATES.length - 1) return 'tm-ob-capsule--future';
  if (state === 'approved') return '';
  return 'tm-ob-capsule--ink';
}

const TEMPLATE_CSS = `
.tm-ob-template { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 14px; align-items: stretch; }
.tm-ob-template__list { display: flex; flex-direction: column; gap: 10px; }
.tm-ob-tcard {
  position: relative; display: flex; flex-direction: column; gap: 6px; padding: 16px;
  border: var(--b-quiet) solid var(--line-300); border-radius: 20px; background: var(--paper-0); cursor: pointer;
}
.tm-ob-tcard:has(input:checked) { border: var(--b-structural) solid var(--ink-950); padding: 15.5px; }
.tm-ob-tcard[data-blank] { border-style: dashed; }
.tm-ob-tcard__name { font-size: var(--t-body-md); line-height: 21px; font-weight: 600; color: var(--ink-800); }
.tm-ob-tcard:has(input:checked) .tm-ob-tcard__name { color: var(--ink-950); }
.tm-ob-tcard__detail { font-size: var(--t-caption); line-height: var(--t-caption-line); color: var(--ink-650); }
.tm-ob-tcard[data-blank] :is(.tm-ob-tcard__name, .tm-ob-tcard__detail) { color: var(--ink-500); }
.tm-ob-template__preview { border-radius: var(--r-sheet); padding: 24px; }
.tm-ob-template__machine { display: flex; flex-direction: column; gap: 8px; }
.tm-ob-template__caption { margin: 0; font-size: var(--t-caption); line-height: var(--t-caption-line); color: var(--ink-650); }
.tm-ob-template__rules { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.tm-ob-template__rules li { display: flex; gap: 12px; font-size: var(--t-ui-md); line-height: var(--t-ui-md-line); color: var(--ink-800); }
@media (max-width: 60rem) {
  .tm-ob-template { grid-template-columns: minmax(0, 1fr); }
}
`;
/** `internal_review` reads as "Internal review". The stored value never changes. */
function humanise(state: string): string {
  const spaced = state.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
