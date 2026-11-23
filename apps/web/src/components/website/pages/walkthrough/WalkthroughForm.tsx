'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, Checkbox, Field, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../../lib/api/browser-client';
import type { ApiClient } from '../../../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../../../lib/api/errors';
import { submitWalkthrough } from '../../../../lib/api/walkthrough';
import { signupAttributionFromSearch } from '../../../../lib/signup-attribution';
import { useFormProof } from '../../../../lib/form-proof';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useHydrated } from '../../../../lib/use-hydrated';
import { WebIcon } from '../../WebIcon';

/**
 * LANE-Q — the "Book a walkthrough" form card (Figma: T-Manage Website, frame 760:17010 "WEB-38
 * Book a walkthrough"): name, work e-mail, company, team size, three preferred times in the
 * visitor's own time zone (shown, and changeable), the topics, the consent line, one lime action.
 *
 * The bounds mirror `0388_walkthrough_requests.sql` and `walkthrough-content.ts`, so the page
 * refuses before the API does; the API stays the authority (and the rate limit's 429 is a calm
 * "try again later"). The time zone is read from the browser after hydration (no effect: it is
 * derived in render), so the prerendered HTML never claims a zone it does not know.
 */

const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_COMPANY = 160;
const HORIZON_DAYS = 90;

export const WALKTHROUGH_TEAM_SIZES = ['1-10', '11-50', '51-200', '200+'] as const;
export const WALKTHROUGH_TOPICS = ['tour', 'switch', 'future'] as const;
type Topic = (typeof WALKTHROUGH_TOPICS)[number];

const TOPIC_LABEL: Readonly<Record<Topic, MessageKey>> = {
  tour: 'WalkthroughForm.topicTour',
  switch: 'WalkthroughForm.topicSwitch',
  future: 'WalkthroughForm.topicFuture',
};
const SLOT_LABEL: readonly MessageKey[] = [
  'WalkthroughForm.slotFirst',
  'WalkthroughForm.slotSecond',
  'WalkthroughForm.slotThird',
];

interface Draft {
  name: string;
  email: string;
  company: string;
  teamSize: string;
  slots: [string, string, string];
  topics: readonly Topic[];
  consent: boolean;
}

const EMPTY: Draft = {
  name: '',
  email: '',
  company: '',
  teamSize: '',
  slots: ['', '', ''],
  topics: ['tour'],
  consent: false,
};

/** `YYYY-MM-DDTHH:MM` of a local Date, the value a `datetime-local` input takes. */
function localValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zoneList(current: string): readonly string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const all =
    typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  return all.includes(current) ? all : [current, ...all];
}

/** The problem with the draft, or `null`: the page's own first check before the API's. */
export function walkthroughDraftProblem(draft: Draft, now: Date): MessageKey | null {
  if (
    draft.name.trim() === '' ||
    draft.email.trim() === '' ||
    draft.company.trim() === '' ||
    draft.teamSize === ''
  ) {
    return 'WalkthroughForm.errorRequired';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(draft.email.trim())) return 'WalkthroughForm.errorEmail';
  if (
    draft.name.trim().length > MAX_NAME ||
    draft.email.trim().length > MAX_EMAIL ||
    draft.company.trim().length > MAX_COMPANY
  ) {
    return 'WalkthroughForm.errorTooLong';
  }
  const nowValue = localValue(now);
  if (draft.slots.some((slot) => slot === '' || slot <= nowValue))
    return 'WalkthroughForm.errorSlots';
  if (new Set(draft.slots).size !== 3) return 'WalkthroughForm.errorSlotsDistinct';
  if (draft.topics.length === 0) return 'WalkthroughForm.errorTopics';
  if (!draft.consent) return 'WalkthroughForm.errorConsent';
  return null;
}

export interface WalkthroughFormProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

export function WalkthroughForm({ client }: WalkthroughFormProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const hydrated = useHydrated();
  const zoneSelectId = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [zoneChoice, setZoneChoice] = useState<string | null>(null);
  const [changingZone, setChangingZone] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [reference, setReference] = useState<string | null>(null);
  const formProof = useFormProof(api);
  const zone = zoneChoice ?? (hydrated ? browserZone() : 'UTC');
  const now = new Date();
  const min = hydrated ? localValue(new Date(now.getTime() + 60 * 60_000)) : undefined;
  const max = hydrated
    ? localValue(new Date(now.getTime() + HORIZON_DAYS * 86_400_000))
    : undefined;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setFailure(undefined);
  }

  function setSlot(index: number, value: string) {
    const slots = [...draft.slots] as [string, string, string];
    slots[index] = value;
    set('slots', slots);
  }

  function toggleTopic(topic: Topic, on: boolean) {
    const next = on ? [...draft.topics, topic] : draft.topics.filter((item) => item !== topic);
    set(
      'topics',
      WALKTHROUGH_TOPICS.filter((item) => next.includes(item)),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = walkthroughDraftProblem(draft, new Date());
    if (problem !== null) {
      setFailure(t(problem));
      return;
    }
    setSending(true);
    setFailure(undefined);
    try {
      const source = signupAttributionFromSearch(window.location.search)?.utm_source;
      // OUTREACH MANAGER: a campaign mail's link carries the recipient's signed invite; the API
      // verifies it and credits the booking (nothing else about it is trusted here).
      const invite = new URLSearchParams(window.location.search).get('invite');
      const website = (event.currentTarget.elements.namedItem('website') as HTMLInputElement | null)
        ?.value;
      const view = await submitWalkthrough(api, {
        name: draft.name.trim(),
        email: draft.email.trim(),
        company: draft.company.trim(),
        teamSize: draft.teamSize,
        timeZone: zone,
        slots: draft.slots,
        topics: draft.topics,
        consent: draft.consent,
        language: document.documentElement.lang.startsWith('ar') ? 'ar' : 'en',
        ...(source === undefined ? {} : { source }),
        ...(invite !== null && /^[A-Za-z0-9._~-]{1,512}$/u.test(invite) ? { invite } : {}),
        website: website ?? '',
        ...(await formProof.fields()),
      });
      setReference(view.reference);
      setDraft(EMPTY);
    } catch (error) {
      setFailure(describe(error, t));
    } finally {
      setSending(false);
    }
  }

  if (reference !== null) {
    return (
      <div className="tm-web-contact-form tm-web-contact-form--done" id="walkthrough-form">
        <span className="tm-web-contact-form__done-orb" aria-hidden="true">
          <WebIcon name="check" size={24} />
        </span>
        <InlineAlert tone="success" title={t('WalkthroughForm.doneTitle')} live>
          {t('WalkthroughForm.doneBody').replace('{reference}', reference)}
        </InlineAlert>
      </div>
    );
  }

  return (
    <div className="tm-web-contact-form" id="walkthrough-form">
      <form noValidate onSubmit={submit} aria-label={t('WalkthroughForm.formLabel')}>
        <fieldset className="tm-fieldset tm-web-contact-form__fields" disabled={!hydrated}>
          <input type="hidden" name="startedAt" value={formProof.issue?.startedAt ?? ''} />
          <input type="hidden" name="nonce" value={formProof.issue?.nonce ?? ''} />
          {/* The honeypot: hidden from people and from assistive technology. */}
          <div className="tm-web-walkthrough__trap" aria-hidden="true">
            <label>
              Website
              <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
            </label>
          </div>
          <Field
            label={t('WalkthroughForm.fieldName')}
            name="name"
            autoComplete="name"
            placeholder={t('WalkthroughForm.placeholderName')}
            maxLength={MAX_NAME}
            value={draft.name}
            onChange={(event) => set('name', event.target.value)}
            required
          />
          <Field
            label={t('WalkthroughForm.fieldEmail')}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            dir="ltr"
            placeholder={t('WalkthroughForm.placeholderEmail')}
            maxLength={MAX_EMAIL}
            value={draft.email}
            onChange={(event) => set('email', event.target.value)}
            required
          />
          <div className="tm-web-contact-form__pair">
            <Field
              label={t('WalkthroughForm.fieldCompany')}
              name="company"
              autoComplete="organization"
              placeholder={t('WalkthroughForm.placeholderCompany')}
              maxLength={MAX_COMPANY}
              value={draft.company}
              onChange={(event) => set('company', event.target.value)}
              required
            />
            <Select
              label={t('WalkthroughForm.fieldTeamSize')}
              name="teamSize"
              className="tm-web-contact-form__select"
              value={draft.teamSize}
              onChange={(event) => set('teamSize', event.target.value)}
              required
            >
              <option value="" disabled>
                {t('WalkthroughForm.teamSizeSelect')}
              </option>
              {WALKTHROUGH_TEAM_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} {t('WalkthroughForm.people')}
                </option>
              ))}
            </Select>
          </div>
          <fieldset className="tm-fieldset tm-web-walkthrough__group">
            <legend className="tm-field__label">{t('WalkthroughForm.slotsLegend')}</legend>
            {SLOT_LABEL.map((labelKey, index) => (
              <Field
                key={labelKey}
                label={t(labelKey)}
                type="datetime-local"
                name={`slot${String(index + 1)}`}
                dir="ltr"
                min={min}
                max={max}
                step={900}
                value={draft.slots[index]}
                onChange={(event) => setSlot(index, event.target.value)}
                required
              />
            ))}
            <p className="tm-web-walkthrough__zone">
              {t('WalkthroughForm.zoneHint').replace('{zone}', zone)}{' '}
              <button
                type="button"
                className="tm-web-walkthrough__zone-change"
                aria-expanded={changingZone}
                aria-controls={zoneSelectId}
                onClick={() => setChangingZone((open) => !open)}
              >
                {t('WalkthroughForm.zoneChange')}
              </button>
            </p>
            {changingZone ? (
              <div id={zoneSelectId}>
                <Select
                  label={t('WalkthroughForm.zoneLabel')}
                  name="timeZone"
                  dir="ltr"
                  value={zone}
                  onChange={(event) => setZoneChoice(event.target.value)}
                >
                  {zoneList(zone).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
          </fieldset>
          <fieldset className="tm-fieldset tm-web-walkthrough__group">
            <legend className="tm-field__label">{t('WalkthroughForm.topicsLegend')}</legend>
            {WALKTHROUGH_TOPICS.map((topic) => (
              <Checkbox
                key={topic}
                label={t(TOPIC_LABEL[topic])}
                name={`topic-${topic}`}
                checked={draft.topics.includes(topic)}
                onChange={(event) => toggleTopic(topic, event.target.checked)}
              />
            ))}
          </fieldset>
          <Checkbox
            label={t('WalkthroughForm.consentLabel')}
            name="consent"
            checked={draft.consent}
            onChange={(event) => set('consent', event.target.checked)}
            required
          />
          {failure ? (
            <InlineAlert tone="danger" title={t('WalkthroughForm.failureTitle')} live>
              {failure}
            </InlineAlert>
          ) : null}
          <Button
            type="submit"
            tone="lime"
            size="feature"
            className="tm-web-contact-form__submit"
            loading={sending}
            loadingLabel={t('WalkthroughForm.submitting')}
          >
            {t('WalkthroughForm.submit')}
          </Button>
          <p className="tm-web-contact-form__caption">{t('WalkthroughForm.caption')}</p>
        </fieldset>
      </form>
    </div>
  );
}

function describe(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) return t('WalkthroughForm.errorRateLimited');
    if (error.status === 422) return t('WalkthroughForm.errorInvalid');
    return t('WalkthroughForm.errorGeneric');
  }
  if (error instanceof NetworkError) return t('WalkthroughForm.errorNetwork');
  return t('WalkthroughForm.errorGeneric');
}
