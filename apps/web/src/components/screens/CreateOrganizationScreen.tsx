'use client';

import { useState } from 'react';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { BackendPending } from './BackendPending';
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  describeSlugProblems,
  slugProblems,
  slugify,
} from '../../lib/slug';

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
  { value: 'en', label: 'English', direction: 'Left to right' },
  { value: 'ar', label: 'العربية', direction: 'Right to left' },
] as const;

/** ON-01's "work type", which decides the vocabulary and the default workflow. */
const WORK_TYPES = [
  {
    value: 'client-projects',
    name: 'Client projects with approvals',
    detail:
      'Design, build or campaign work delivered to external clients who review and approve versions.',
  },
  {
    value: 'retainer',
    name: 'Retainer and support work',
    detail:
      'Continuous requests from the same clients, with commitments made per cycle rather than per project.',
  },
  {
    value: 'internal',
    name: 'Internal programmes only',
    detail:
      'No external clients yet. Everything stays internal, and the portal can be switched on later.',
  },
] as const;

export interface CreateOrganizationScreenProps {
  signedInAs: string;
}

/**
 * **ON-01 Create organization.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Fields: organization name, timezone, default locale, work type.
 * Primary: Create organization. Result is transactional owner membership."
 *
 * The last sentence is the part that is not built. `TEN-001` never implemented organization
 * creation, and it cannot be done from the browser in pieces: creating the organization, the
 * workspace, and the founding owner membership has to be one transaction, or a failure
 * halfway leaves an organization nobody can administer. So the submit button is disabled and
 * says which ticket does it, and this screen does the half it can do honestly — collecting
 * and validating the input.
 *
 * The workspace address is derived from the name as it is typed, and stops being derived the
 * moment the person edits it. Continuing to overwrite an edited field is the behaviour that
 * makes slug fields infuriating.
 *
 * Availability is **not** claimed. The export draws a green "available" tick; there is no
 * endpoint that could check it, and a tick that checked nothing is worse than no tick.
 */
export function CreateOrganizationScreen({ signedInAs }: CreateOrganizationScreenProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [timezone, setTimezone] = useState(() => guessTimezone());
  const [locale, setLocale] = useState<string>(LOCALES[0].value);
  const [workType, setWorkType] = useState<string>(WORK_TYPES[0].value);

  const effectiveSlug = slugEdited ? slug : slugify(name);
  const slugError =
    name === '' && !slugEdited ? undefined : describeSlugProblems(slugProblems(effectiveSlug));

  return (
    <OnboardingShell
      current="ON-01"
      signedInAs={signedInAs}
      title="Set up your organization"
      description="This is the space your team works in. A client organization is created separately, later in this sequence."
    >
      <BackendPending ticket="TEN-001">
        Creating an organization is not implemented. It has to create the organization, its
        workspace and your owner membership in one transaction, and that transaction is not written
        yet. Everything below is collected and checked; nothing is saved.
      </BackendPending>

      <form className="tm-stack tm-stack--loose" onSubmit={(event) => event.preventDefault()}>
        <Field
          label="Organization name"
          name="name"
          value={name}
          maxLength={MAX_ORGANIZATION_NAME_LENGTH}
          onChange={(event) => setName(event.target.value)}
          hint="The name your team and your clients will see."
          required
        />

        <Field
          label="Workspace address"
          name="slug"
          value={effectiveSlug}
          onChange={(event) => {
            setSlugEdited(true);
            setSlug(event.target.value);
          }}
          dir="ltr"
          spellCheck={false}
          hint="Lowercase letters, numbers and hyphens. It appears in every link to this organization."
          {...(slugError === undefined ? {} : { error: slugError })}
        />

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
          <span className="tm-field__hint">
            Dates and deadlines are stored with a timezone. When a client is in another zone, both
            are shown on the deadline.
          </span>
        </div>

        <fieldset className="tm-fieldset">
          <legend className="tm-field__label">Default language</legend>
          <div className="tm-stack tm-stack--tight">
            {LOCALES.map((option) => (
              <label key={option.value} className="tm-choice">
                <input
                  className="tm-choice__input"
                  type="radio"
                  name="locale"
                  value={option.value}
                  checked={locale === option.value}
                  onChange={() => setLocale(option.value)}
                />
                <span className="tm-choice__name">{option.label}</span>
                <span className="tm-choice__detail">{option.direction}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="tm-fieldset">
          <legend className="tm-field__label">What does your team deliver?</legend>
          <p className="tm-prose">
            This sets the vocabulary, the default workflow and the client experience. You can change
            all of it later — nothing here is locked.
          </p>
          <div className="tm-stack tm-stack--tight">
            {WORK_TYPES.map((option) => (
              <label key={option.value} className="tm-choice">
                <input
                  className="tm-choice__input"
                  type="radio"
                  name="workType"
                  value={option.value}
                  checked={workType === option.value}
                  onChange={() => setWorkType(option.value)}
                />
                <span className="tm-choice__name">{option.name}</span>
                <span className="tm-choice__detail">{option.detail}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <InlineAlert tone="neutral">
          Your workspace address will be{' '}
          <strong>{effectiveSlug === '' ? '—' : effectiveSlug}</strong>. We cannot tell you yet
          whether it is taken; that check needs the endpoint TEN-001 delivers.
        </InlineAlert>

        <div className="tm-row">
          <Button type="submit" tone="ink" size="accessible" disabled>
            Create organization
          </Button>
        </div>
      </form>
    </OnboardingShell>
  );
}

/** The browser's timezone where it is known, `UTC` where it is not. */
function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
