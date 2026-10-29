'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, Checkbox, Field, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../../lib/api/browser-client';
import { submitContact } from '../../../../lib/api/contact';
import { ApiRequestError, NetworkError } from '../../../../lib/api/errors';
import type { ApiClient } from '../../../../lib/api/client';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useHydrated } from '../../../../lib/use-hydrated';
import { useFormProof } from '../../../../lib/form-proof';
import { WebIcon } from '../../WebIcon';

/**
 * Mirrors the column bounds of `0062_marketing_leads.sql` (and `contact.controller.ts`), so the
 * client rejects before the API does. The API stays the authority, including its per-address
 * rate limit, whose 429 is rendered as a calm "try again later".
 */
const MAX_NAME = 200;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 4000;
const MAX_SHORT = 200;
const MAX_NOTE = 3000;

export const TEAM_SIZES = ['1–10', '11–50', '51–200', '200+'] as const;

export interface DemoRequestFormProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

interface Draft {
  name: string;
  email: string;
  company: string;
  teamSize: string;
  role: string;
  note: string;
  updates: boolean;
}

const EMPTY: Draft = {
  name: '',
  email: '',
  company: '',
  teamSize: '',
  role: '',
  note: '',
  updates: false,
};

/**
 * The demo-request body. The public contact endpoint takes a name, an email and one message, so
 * the extra demo fields travel inside the message as labelled lines — no new API surface.
 */
export function composeDemoMessage(draft: Draft): string {
  const lines = [
    'Demo request',
    `Company: ${draft.company.trim()}`,
    `Team size: ${draft.teamSize}`,
    `Role: ${draft.role.trim() || '—'}`,
    `Product updates: ${draft.updates ? 'yes' : 'no'}`,
  ];
  const note = draft.note.trim();
  if (note !== '') lines.push('', 'Would like to see:', note);
  return lines.join('\n').slice(0, MAX_MESSAGE);
}

/**
 * WEB-17 form card (Figma node 308:42) — Full name, Work email, Company, Team size, Role, "What would you like to
 * see?", the optional updates choice and the one lime action. Posts to the existing
 * `POST /public/site/contact` through `submitContact`.
 */
export function DemoRequestForm({ client }: DemoRequestFormProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const hydrated = useHydrated();
  const noteId = useId();
  const errorId = `${noteId}-error`;

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState(false);
  // 52-21: the invisible form proof, fetched once when the form is shown.
  const formProof = useFormProof(api);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setFailure(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draft.name.trim();
    const email = draft.email.trim();
    const company = draft.company.trim();

    if (name === '' || email === '' || company === '' || draft.teamSize === '') {
      setFailure(t('DemoRequestForm.errorRequired'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFailure(t('DemoRequestForm.errorEmail'));
      return;
    }
    if (name.length > MAX_NAME || email.length > MAX_EMAIL) {
      setFailure(t('DemoRequestForm.errorTooLong'));
      return;
    }

    setSending(true);
    setFailure(undefined);
    try {
      const outcome = await submitContact(api, {
        name,
        email,
        message: composeDemoMessage(draft),
        ...(await formProof.fields()),
      });
      if (outcome.status === 'not_sent') {
        setFailure(t('DemoRequestForm.errorGeneric'));
        return;
      }
      setSent(true);
      setDraft(EMPTY);
    } catch (error) {
      setFailure(describe(error, t));
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="tm-web-contact-form tm-web-contact-form--done" id="book-demo-form">
        <span className="tm-web-contact-form__done-orb" aria-hidden="true">
          <WebIcon name="check" size={24} />
        </span>
        <InlineAlert tone="success" title={t('DemoRequestForm.doneTitle')} live>
          {t('DemoRequestForm.doneBody')}
        </InlineAlert>
        <div className="tm-web-contact-form__done-actions">
          <Button type="button" tone="outline" onClick={downloadCalendarHold}>
            {t('DemoRequestForm.doneAddCalendar')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="tm-web-contact-form" id="book-demo-form">
      {/* `noValidate` for the reason `SignInScreen` gives: errors use the design system. */}
      <form noValidate onSubmit={submit} aria-label={t('DemoRequestForm.formLabel')}>
        <fieldset className="tm-fieldset tm-web-contact-form__fields" disabled={!hydrated}>
          {/* 52-21 form proof: invisible; the submit adds the browser-computed proof. */}
          <input type="hidden" name="startedAt" value={formProof.issue?.startedAt ?? ''} />
          <input type="hidden" name="nonce" value={formProof.issue?.nonce ?? ''} />
          <Field
            label={t('DemoRequestForm.fieldName')}
            name="name"
            autoComplete="name"
            placeholder={t('DemoRequestForm.placeholderName')}
            maxLength={MAX_NAME}
            value={draft.name}
            onChange={(event) => set('name', event.target.value)}
            required
          />
          <Field
            label={t('DemoRequestForm.fieldEmail')}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            dir="ltr"
            placeholder={t('DemoRequestForm.placeholderEmail')}
            maxLength={MAX_EMAIL}
            value={draft.email}
            onChange={(event) => set('email', event.target.value)}
            required
          />
          <div className="tm-web-contact-form__pair">
            <Field
              label={t('DemoRequestForm.fieldCompany')}
              name="company"
              autoComplete="organization"
              placeholder={t('DemoRequestForm.placeholderCompany')}
              maxLength={MAX_SHORT}
              value={draft.company}
              onChange={(event) => set('company', event.target.value)}
              required
            />
            <Select
              label={t('DemoRequestForm.fieldTeamSize')}
              name="teamSize"
              className="tm-web-contact-form__select"
              value={draft.teamSize}
              onChange={(event) => set('teamSize', event.target.value)}
              required
            >
              <option value="" disabled>
                {t('DemoRequestForm.teamSizeSelect')}
              </option>
              {TEAM_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} {t('DemoRequestForm.people')}
                </option>
              ))}
            </Select>
          </div>
          <Field
            label={t('DemoRequestForm.fieldRole')}
            name="role"
            autoComplete="organization-title"
            placeholder={t('DemoRequestForm.placeholderRole')}
            maxLength={MAX_SHORT}
            value={draft.role}
            onChange={(event) => set('role', event.target.value)}
          />
          <div className="tm-field">
            <label className="tm-field__label" htmlFor={noteId}>
              {t('DemoRequestForm.noteLabel')}
            </label>
            <textarea
              id={noteId}
              name="note"
              className="tm-field__control tm-web-contact-form__note"
              rows={1}
              placeholder={t('DemoRequestForm.placeholderNote')}
              maxLength={MAX_NOTE}
              value={draft.note}
              onChange={(event) => set('note', event.target.value)}
              aria-describedby={failure ? errorId : undefined}
            />
          </div>
          <Checkbox
            className="tm-web-contact-form__choice"
            label={t('DemoRequestForm.updatesLabel')}
            name="updates"
            checked={draft.updates}
            onChange={(event) => set('updates', event.target.checked)}
          />

          {failure ? (
            <InlineAlert tone="danger" title={t('DemoRequestForm.failureTitle')} live>
              <span id={errorId}>{failure}</span>
            </InlineAlert>
          ) : null}

          <Button
            type="submit"
            tone="lime"
            size="feature"
            className="tm-web-contact-form__submit"
            loading={sending}
            loadingLabel={t('DemoRequestForm.submitting')}
          >
            {t('DemoRequestForm.submit')}
          </Button>
          <p className="tm-web-contact-form__caption">{t('DemoRequestForm.caption')}</p>
        </fieldset>
      </form>
    </div>
  );
}

/** Turn a thrown value into a sentence. The contact 400/429 messages carry no stored data. */
function describe(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) return t('DemoRequestForm.errorRateLimited');
    return error.message;
  }
  if (error instanceof NetworkError) return t('DemoRequestForm.errorNetwork');
  return t('DemoRequestForm.errorGeneric');
}

/**
 * "Add to calendar" — a 30-minute hold on the next business day at 10:00 local time, as an
 * iCalendar file the visitor's own calendar opens. The confirmed time arrives by email.
 */
/** iCalendar lines end in CR LF (RFC 5545 §3.1). */
const CRLF = String.fromCharCode(13, 10);

export function demoCalendarHold(now: Date = new Date()): string {
  const start = new Date(now);
  start.setHours(10, 0, 0, 0);
  do {
    start.setDate(start.getDate() + 1);
  } while (start.getDay() === 0 || start.getDay() === 6);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const stamp = (date: Date) =>
    date
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TManage//Book a demo//EN',
    'BEGIN:VEVENT',
    `UID:${stamp(now)}-demo@tmanage.app`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    'SUMMARY:TManage demo (time to be confirmed)',
    'DESCRIPTION:A 30-minute walkthrough of TManage. We will email you to confirm the time.',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join(CRLF);
}

function downloadCalendarHold() {
  const blob = new Blob([demoCalendarHold()], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'tmanage-demo.ics';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
