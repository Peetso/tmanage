'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { createOrganization } from '../../lib/api/organizations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  describeSlugProblems,
  slugProblems,
  slugify,
} from '../../lib/slug';
import { useHydrated } from '../../lib/use-hydrated';

/**
 * The timezone list.
 *
 * `Intl.supportedValuesOf('timeZone')` where the runtime has it, which is every browser this
 * application targets, falling back to a short list rather than to nothing. The fallback is
 * not a curated "popular timezones" list — that would quietly exclude someone — it is what
 * remains when the platform cannot enumerate them, and the field stays a free-text-backed
 * select so a value outside it can still be reached by a later ticket.
 */
function timezones(): readonly string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      return intl.supportedValuesOf('timeZone');
    } catch {
      // fall through
    }
  }
  return ['UTC', 'Africa/Cairo', 'Europe/London', 'America/New_York', 'Asia/Dubai'];
}

/** `19-SEED-DATA-AND-COPY` ships English and Arabic. Nothing else is translated yet. */
const LOCALES = [
  { value: 'en', label: 'English', short: 'LTR' },
  { value: 'ar', label: 'العربية', short: 'RTL' },
] as const;

/** ON-01's "work type", which decides the vocabulary and the default workflow. */
const WORK_TYPES = [
  {
    value: 'client-projects',
    name: 'Client projects with approvals',
    detail:
      'Design, build or campaign work delivered to external clients who review and approve versions.',
    vocabulary: 'Deliverable · Milestone · Approval · Portal',
    workflow: 'delivery with client review',
  },
  {
    value: 'retainer',
    name: 'Retainer and support work',
    detail:
      'Continuous requests from the same clients, with commitments made per cycle rather than per project.',
    vocabulary: 'Request · Cycle · Commitment · Portal',
    workflow: 'intake and commitment',
  },
  {
    value: 'internal',
    name: 'Internal programmes only',
    detail:
      'No external clients yet. Everything stays internal, and the portal can be switched on later.',
    vocabulary: 'Work · Milestone · Decision',
    workflow: 'internal delivery',
  },
] as const;

export interface CreateOrganizationScreenProps {
  signedInAs: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Called with the new organization's slug once it exists. */
  onCreated?: (slug: string) => void;
}

/**
 * **ON-01 Create organization.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Fields: organization name, timezone, default locale, work type.
 * Primary: Create organization. Result is transactional owner membership."
 *
 * The last sentence is now true. `TEN-001`'s provisioning transaction creates the
 * organization, its first workspace and the founding owner membership together, or creates
 * nothing — a failure halfway would leave an organization nobody can administer.
 *
 * The workspace address is derived from the name as it is typed, and stops being derived the
 * moment the person edits it. Continuing to overwrite an edited field is the behaviour that
 * makes slug fields infuriating.
 *
 * Availability is still **not** claimed before submitting. The export draws a green
 * "available" tick and there is no endpoint that checks one; a tick that checked nothing is
 * worse than no tick. What there is instead is a real answer on submit — the unique key
 * decides, and a 409 comes back naming the field. That is the honest version of the same
 * affordance: it costs one attempt and it cannot be wrong.
 *
 * The slug is sent exactly as it appears in the field. The server refuses capitals rather
 * than folding them, so the address a person is shown here is the address they get.
 */
export function CreateOrganizationScreen({
  signedInAs,
  client,
  onCreated,
}: CreateOrganizationScreenProps) {
  const api = client ?? browserApiClient();

  // No query gates this form — nothing is fetched before it is shown — so the controls hang on
  // the hydration signal instead: disabled in the server render, enabled once React is live, so
  // a name or address typed on a cold page is not wiped when hydration re-applies the empty state.
  const hydrated = useHydrated();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [timezone, setTimezone] = useState(() => guessTimezone());
  const [locale, setLocale] = useState<string>(LOCALES[0].value);
  const [workType, setWorkType] = useState<string>(WORK_TYPES[0].value);

  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [serverSlugError, setServerSlugError] = useState<string | undefined>(undefined);

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const localSlugError =
    name === '' && !slugEdited ? undefined : describeSlugProblems(slugProblems(effectiveSlug));
  const slugError = localSlugError ?? serverSlugError;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    setServerSlugError(undefined);

    if (name.trim() === '') {
      setFailure('Enter an organization name.');
      return;
    }
    if (localSlugError !== undefined || effectiveSlug === '') {
      setFailure('Fix the workspace address first.');
      return;
    }

    setCreating(true);
    try {
      const created = await createOrganization(api, {
        name: name.trim(),
        slug: effectiveSlug,
        timezone,
        defaultLocale: locale,
      });
      onCreated?.(created.slug);
    } catch (error) {
      // A taken address is a field error, not a banner: the person has to change one input,
      // and the message belongs beside it. Everything else is a banner, because there is no
      // one field to attach it to.
      if (error instanceof ApiRequestError) {
        const slugMessage = error.fieldErrors().get('slug');
        if (slugMessage !== undefined) {
          setServerSlugError(slugMessage);
        } else {
          setFailure(error.message);
        }
      } else {
        setFailure(describe(error));
      }
    } finally {
      setCreating(false);
    }
  }

  const addressLabel = effectiveSlug === '' ? '—' : effectiveSlug;
  const trimmedName = name.trim();

  return (
    <OnboardingShell
      current="ON-01"
      signedInAs={signedInAs}
      title={trimmedName === '' ? 'Set up your organization' : `Set up ${trimmedName}`}
    >
      <OnboardingScreenStyles />
      <form className="tm-ob-flow-form" noValidate onSubmit={submit}>
        <fieldset className="tm-fieldset tm-ob-flow-form" disabled={!hydrated}>
          <section className="tm-ob-section" aria-labelledby="tm-ob-deliver-title">
            <h2 id="tm-ob-deliver-title" className="tm-ob-section__title">
              What does your team deliver?
            </h2>
            <p className="tm-ob-lede">
              This sets the vocabulary, the default workflow and the client experience. You can
              change all of it later — nothing here is locked.
            </p>
            <fieldset className="tm-fieldset tm-ob-options">
              <legend className="tm-visually-hidden">What does your team deliver?</legend>
              {WORK_TYPES.map((option) => {
                const selected = workType === option.value;
                return (
                  <label key={option.value} className="tm-ob-option">
                    <input
                      type="radio"
                      name="workType"
                      value={option.value}
                      checked={selected}
                      onChange={() => setWorkType(option.value)}
                    />
                    <span className="tm-ob-option__head" aria-hidden="true">
                      <span className="tm-ob-eyebrow">{selected ? 'Selected' : 'Option'}</span>
                      {selected ? <span className="tm-ob-option__check">✓</span> : null}
                    </span>
                    <span className="tm-ob-option__name">{option.name}</span>
                    <span className="tm-ob-option__detail">{option.detail}</span>
                    <span className="tm-ob-option__foot">
                      <span className="tm-ob-option__vocab">{option.vocabulary}</span>
                      <span className="tm-ob-option__workflow">workflow: {option.workflow}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          </section>

          <section className="tm-ob-sheet" aria-labelledby="tm-ob-org-title">
            <h2 id="tm-ob-org-title" className="tm-ob-eyebrow">
              Your organization
            </h2>
            <div className="tm-ob-grid-2">
              <Field
                label="Organization name"
                name="name"
                value={name}
                maxLength={MAX_ORGANIZATION_NAME_LENGTH}
                onChange={(event) => {
                  setName(event.target.value);
                  // While the address is still derived, editing the name changes it too.
                  if (!slugEdited) setServerSlugError(undefined);
                }}
                required
              />

              <Field
                label="Workspace address"
                name="slug"
                className="tm-ob-mono-field"
                value={effectiveSlug}
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value);
                  // The server said *this* address was taken. Editing it makes that answer
                  // stale, and leaving it on screen would mark a different address as
                  // unavailable on no evidence.
                  setServerSlugError(undefined);
                }}
                dir="ltr"
                spellCheck={false}
                hint="Lowercase letters, numbers and hyphens."
                {...(slugError === undefined ? {} : { error: slugError })}
              />
            </div>

            <div className="tm-ob-grid-2">
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-timezone">
                  Timezone
                </label>
                <select
                  id="tm-timezone"
                  className="tm-field__control"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                >
                  {timezones().map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </div>

              <fieldset className="tm-fieldset tm-field">
                <legend className="tm-field__label tm-ob-legend">
                  Interface language and direction
                </legend>
                <div className="tm-ob-pills">
                  {LOCALES.map((option) => (
                    <label key={option.value} className="tm-ob-pill" lang={option.value}>
                      <input
                        type="radio"
                        name="locale"
                        value={option.value}
                        checked={locale === option.value}
                        onChange={() => setLocale(option.value)}
                      />
                      {option.label} · {option.short}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="tm-ob-note">
              <span className="tm-ob-glyph" aria-hidden="true">
                i
              </span>
              <p>
                Dates and deadlines are stored with a timezone. When a client is in another zone,
                both are shown on the deadline. Your workspace address will be{' '}
                <strong className="tm-ob-mono">{addressLabel}</strong>; whether it is free is
                decided when you create the organization.
              </p>
            </div>

            {failure ? (
              <InlineAlert tone="danger" title="Could not create the organization" live>
                {failure}
              </InlineAlert>
            ) : null}

            <div className="tm-ob-actions">
              <Button
                type="submit"
                tone="ink"
                size="feature"
                className="tm-ob-go"
                loading={creating}
                loadingLabel="Creating"
              >
                <span className="tm-ob-go__orb" aria-hidden="true">
                  ▸
                </span>
                Create organization
              </Button>
              <span className="tm-ob-keys" aria-hidden="true">
                ↑ ↓ to choose · Enter to create
              </span>
            </div>
          </section>
        </fieldset>
      </form>
    </OnboardingShell>
  );
}

/**
 * Turn a non-API failure into a sentence.
 *
 * An `ApiRequestError` never reaches here: the caller renders its message verbatim, or
 * attaches its field error to the field, because the API has already decided how specific
 * it is willing to be.
 */
function describe(error: unknown): string {
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/** The browser's timezone where it is known, `UTC` where it is not. */
function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The onboarding screens' own paint, ported from `TManage Screens - Onboarding.dc.html`
 * (ON-01 … ON-10) onto the design tokens.
 *
 * It travels with the screens rather than in `globals.css` because the screen group owns only
 * these files; React hoists a `<style href precedence>` into the head once, however many
 * screens render it. The integrator may move it into the stylesheet verbatim.
 */
export function OnboardingScreenStyles() {
  return (
    <style href="tm-onboarding-screens" precedence="default">
      {ONBOARDING_SCREEN_CSS}
    </style>
  );
}

const ONBOARDING_SCREEN_CSS = `
.tm-ob-flow-form { display: flex; flex-direction: column; gap: var(--s8); }
.tm-ob-section { display: flex; flex-direction: column; gap: var(--s3); }
.tm-ob-section__title {
  margin: 0; font-size: var(--t-heading-page); line-height: var(--t-heading-page-line);
  font-weight: 500; letter-spacing: -0.02em; color: var(--ink-950);
}
.tm-ob-lede {
  margin: 0 0 var(--s3); max-inline-size: 660px; font-size: var(--t-body-lg);
  line-height: var(--t-body-lg-line); color: var(--ink-650); text-wrap: pretty;
}
.tm-ob-eyebrow {
  margin: 0; font-family: var(--font-mono); font-size: 10px; line-height: 14px; font-weight: 500;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-500);
}
.tm-ob-mono { font-family: var(--font-mono); font-weight: 500; color: var(--ink-950); }
.tm-ob-sheet {
  display: flex; flex-direction: column; gap: 18px; min-inline-size: 0; padding: 28px;
  border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-feature);
  background: var(--paper-0); color: var(--ink-800);
}
.tm-ob-sheet--card { gap: 12px; padding: 20px; border-radius: var(--r-card); }
.tm-ob-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
.tm-ob-sheet .tm-field__control { min-block-size: 50px; padding-inline: 16px; border-color: var(--line-300); }
.tm-ob-sheet .tm-field__control:focus-visible {
  outline: none; border: var(--b-expressive) solid var(--ink-950); box-shadow: 0 0 0 3px var(--lime-500);
}
.tm-ob-mono-field .tm-field__control { font-family: var(--font-mono); }
.tm-ob-legend { padding: 0; margin-block-end: 6px; }
.tm-ob-rule { block-size: 1px; margin: 0; border: 0; background: var(--paper-150); }
.tm-ob-pills { display: flex; flex-wrap: wrap; gap: 8px; }
.tm-ob-pill {
  position: relative; display: inline-flex; align-items: center; gap: 8px; min-block-size: 44px;
  padding: 0 18px; border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-capsule);
  background: var(--paper-0); color: var(--ink-800); font-size: var(--t-caption);
  line-height: var(--t-caption-line); font-weight: 500; white-space: nowrap; cursor: pointer;
}
.tm-ob-pill[lang='ar'] { font-family: var(--font-arabic); }
.tm-ob-pill input, .tm-ob-option input, .tm-ob-tcard input {
  position: absolute; inset: 0; inline-size: 100%; block-size: 100%; margin: 0; opacity: 0; cursor: pointer;
}
.tm-ob-pill:has(input:checked) {
  border-color: var(--tm-ink-absolute); background: var(--tm-ink-absolute); color: var(--tm-paper-absolute);
}
.tm-ob-pill--client:has(input:checked) {
  border: var(--b-structural) solid var(--client-500); background: var(--paper-0); color: var(--ink-800);
}
.tm-ob-pill:not(:has(input:checked)) .tm-ob-pill__ring { display: none; }
.tm-ob-pill__ring {
  display: grid; place-items: center; inline-size: 18px; block-size: 18px; border-radius: var(--r-capsule);
  border: var(--b-structural) solid var(--client-500); color: var(--client-500);
  font: 600 8px/1 var(--font-mono);
}
.tm-ob-pill:has(input:focus-visible), .tm-ob-option:has(input:focus-visible),
.tm-ob-tcard:has(input:focus-visible) { box-shadow: var(--focus-ring); }
.tm-ob-pill:has(input:disabled), .tm-ob-option:has(input:disabled), .tm-ob-tcard:has(input:disabled) { cursor: default; }

.tm-ob-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.tm-ob-option {
  position: relative; display: flex; flex-direction: column; gap: 14px; min-block-size: 278px;
  padding: 26px; border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-feature);
  background: var(--paper-0); color: var(--ink-800); cursor: pointer;
}
.tm-ob-option:has(input:checked) { border-color: var(--lime-500); background: var(--lime-500); color: var(--tm-on-lime); }
.tm-ob-option__head { display: flex; align-items: center; justify-content: space-between; min-block-size: 28px; }
.tm-ob-option:has(input:checked) .tm-ob-eyebrow { color: var(--tm-on-lime); }
.tm-ob-option__check {
  display: grid; place-items: center; inline-size: 28px; block-size: 28px; border-radius: var(--r-capsule);
  background: var(--tm-ink-absolute); color: var(--lime-500); font: 600 12px/1 var(--font-mono);
}
.tm-ob-option__name { font-size: 22px; line-height: 28px; font-weight: 600; color: var(--ink-950); }
.tm-ob-option__detail { font-size: var(--t-ui-md); line-height: 21px; color: var(--ink-650); text-wrap: pretty; }
.tm-ob-option__foot { display: flex; flex-direction: column; gap: 6px; margin-block-start: auto; }
.tm-ob-option__vocab { font-size: 11px; line-height: 16px; font-weight: 500; color: var(--ink-800); }
.tm-ob-option__workflow { font-family: var(--font-mono); font-size: 11px; line-height: 16px; color: var(--ink-500); }
.tm-ob-option:has(input:checked) :is(.tm-ob-option__name, .tm-ob-option__detail, .tm-ob-option__vocab, .tm-ob-option__workflow) {
  color: var(--tm-on-lime);
}

.tm-ob-note {
  display: flex; gap: 12px; padding: 14px; border: var(--b-quiet) solid var(--line-300);
  border-radius: var(--r-compact); background: var(--paper-50); color: var(--ink-650);
  font-size: var(--t-caption); line-height: var(--t-caption-line);
}
.tm-ob-note p { margin: 0; }
.tm-ob-note--warning { border: var(--b-structural) solid var(--warning-600); background: var(--paper-0); }
.tm-ob-glyph {
  flex-shrink: 0; display: grid; place-items: center; inline-size: 22px; block-size: 22px;
  border: var(--b-structural) solid var(--ink-500); border-radius: var(--r-capsule);
  color: var(--ink-500); font: 600 10px/1 var(--font-mono);
}
.tm-ob-glyph--warning { border: var(--b-expressive) solid var(--warning-600); color: var(--warning-600); }
.tm-ob-glyph--danger { border: var(--b-expressive) solid var(--danger-600); color: var(--danger-600); }
.tm-ob-glyph--ink { border-color: var(--tm-ink-absolute); background: var(--tm-ink-absolute); color: var(--lime-500); }

.tm-ob-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 14px; margin-block-start: auto; }
.tm-ob-cta { flex: 1; min-block-size: 48px; }
.tm-button.tm-ob-go { gap: 12px; padding-block: 6px; padding-inline: 6px 24px; }
.tm-ob-go__orb {
  display: grid; place-items: center; inline-size: 36px; block-size: 36px; border-radius: var(--r-capsule);
  background: var(--lime-500); color: var(--tm-ink-absolute); font: 500 15px/1 var(--font-mono);
}
.tm-ob-keys {
  margin-inline-start: auto; font-family: var(--font-mono); font-size: 11px; line-height: 16px;
  letter-spacing: 0.02em; text-transform: uppercase; color: var(--ink-500);
}
.tm-ob-link {
  border-block-end: var(--b-quiet) solid var(--line-300); color: var(--ink-650);
  font-size: var(--t-ui-sm); line-height: var(--t-ui-sm-line); font-weight: 500; text-decoration: none;
}
.tm-ob-link:hover { border-block-end-color: var(--lime-600); color: var(--ink-950); }

.tm-ob-track { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 0; padding: 0; list-style: none; }
.tm-ob-capsule {
  display: inline-flex; align-items: center; gap: 8px; min-block-size: 40px; padding: 0 14px;
  border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-capsule); background: var(--paper-0);
  color: var(--ink-800); font-size: var(--t-caption); line-height: var(--t-caption-line); font-weight: 500;
  white-space: nowrap;
}
.tm-ob-capsule--tall { min-block-size: 44px; }
.tm-ob-capsule--ink { border-color: var(--tm-ink-absolute); background: var(--tm-ink-absolute); color: var(--tm-paper-absolute); }
.tm-ob-capsule--lime { border-color: var(--lime-500); background: var(--lime-500); color: var(--tm-on-lime); font-weight: 600; }
.tm-ob-capsule--future { border-style: dashed; background: transparent; color: var(--ink-500); }
.tm-ob-capsule--grow { flex: 1; }
.tm-ob-arrows > li { display: inline-flex; align-items: center; gap: 5px; }
.tm-ob-arrows > li + li::before {
  content: '→'; font: 500 11px/1 var(--font-mono); color: var(--ink-500);
}
[dir='rtl'] .tm-ob-arrows > li + li::before { content: '←'; }
.tm-ob-avatar {
  flex-shrink: 0; display: grid; place-items: center; inline-size: 28px; block-size: 28px;
  border-radius: var(--r-capsule); background: var(--ink-800); color: var(--paper-50);
  font-size: 10px; line-height: 1; font-weight: 600; text-transform: uppercase;
}

@media (max-width: 60rem) {
  .tm-ob-grid-2, .tm-ob-options { grid-template-columns: minmax(0, 1fr); }
  .tm-ob-option { min-block-size: 0; padding: 22px; }
  .tm-ob-sheet { padding: 20px; border-radius: var(--r-card); }
  .tm-ob-section__title { font-size: var(--t-heading-section); line-height: var(--t-heading-section-line); }
  .tm-ob-keys { display: none; }
}
`;
