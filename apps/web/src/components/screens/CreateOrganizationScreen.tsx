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

  return (
    <OnboardingShell
      current="ON-01"
      signedInAs={signedInAs}
      title="Set up your organization"
      description="This is the space your team works in. A client organization is created separately, later in this sequence."
    >
      <form className="tm-stack tm-stack--loose" noValidate onSubmit={submit}>
        <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={!hydrated}>
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
              // The server said *this* address was taken. Editing it makes that answer stale,
              // and leaving it on screen would mark a different address as unavailable on no
              // evidence.
              setServerSlugError(undefined);
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
              This sets the vocabulary, the default workflow and the client experience. You can
              change all of it later — nothing here is locked.
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
            <strong>{effectiveSlug === '' ? '—' : effectiveSlug}</strong>. Whether it is free is
            decided when you create the organization; nothing checks it before then, because a tick
            that checked nothing would be worse than no tick.
          </InlineAlert>

          {failure ? (
            <InlineAlert tone="danger" title="Could not create the organization" live>
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
            >
              Create organization
            </Button>
          </div>
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
