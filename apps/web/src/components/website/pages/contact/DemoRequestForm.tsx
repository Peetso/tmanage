'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, Checkbox, Field, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../../lib/api/browser-client';
import { submitContact } from '../../../../lib/api/contact';
import { ApiRequestError, NetworkError } from '../../../../lib/api/errors';
import type { ApiClient } from '../../../../lib/api/client';
import { useHydrated } from '../../../../lib/use-hydrated';
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
 * WEB-17 form card — Full name, Work email, Company, Team size, Role, "What would you like to
 * see?", the optional updates choice and the one lime action. Posts to the existing
 * `POST /public/site/contact` through `submitContact`.
 */
export function DemoRequestForm({ client }: DemoRequestFormProps) {
  const api = client ?? browserApiClient();
  const hydrated = useHydrated();
  const noteId = useId();
  const errorId = `${noteId}-error`;

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState(false);

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
      setFailure('Enter your name, work email, company and team size.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFailure('Enter a work email like name@company.com.');
      return;
    }
    if (name.length > MAX_NAME || email.length > MAX_EMAIL) {
      setFailure('One of the fields is too long. Please shorten it and try again.');
      return;
    }

    setSending(true);
    setFailure(undefined);
    try {
      await submitContact(api, { name, email, message: composeDemoMessage(draft) });
      setSent(true);
      setDraft(EMPTY);
    } catch (error) {
      setFailure(describe(error));
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
        <InlineAlert
          tone="success"
          title="Thanks — we'll be in touch within one business day."
          live
        >
          We will reply to your work email to confirm a time. Hold a slot for the call now.
        </InlineAlert>
        <div className="tm-web-contact-form__done-actions">
          <Button type="button" tone="outline" onClick={downloadCalendarHold}>
            Add to calendar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="tm-web-contact-form" id="book-demo-form">
      <div className="tm-web-contact-form__head">
        <h2 className="tm-web-contact-form__title">Book your demo</h2>
        <p className="tm-web-contact-form__sub">30 minutes · video call · English or Arabic</p>
      </div>

      {/* `noValidate` for the reason `SignInScreen` gives: errors use the design system. */}
      <form noValidate onSubmit={submit}>
        <fieldset className="tm-fieldset tm-web-contact-form__fields" disabled={!hydrated}>
          <Field
            label="Full name"
            name="name"
            autoComplete="name"
            maxLength={MAX_NAME}
            value={draft.name}
            onChange={(event) => set('name', event.target.value)}
            required
          />
          <Field
            label="Work email"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            dir="ltr"
            maxLength={MAX_EMAIL}
            value={draft.email}
            onChange={(event) => set('email', event.target.value)}
            required
          />
          <Field
            label="Company"
            name="company"
            autoComplete="organization"
            maxLength={MAX_SHORT}
            value={draft.company}
            onChange={(event) => set('company', event.target.value)}
            required
          />
          <Select
            label="Team size"
            name="teamSize"
            className="tm-web-contact-form__select"
            value={draft.teamSize}
            onChange={(event) => set('teamSize', event.target.value)}
            required
          >
            <option value="" disabled>
              Select your team size
            </option>
            {TEAM_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} people
              </option>
            ))}
          </Select>
          <Field
            label="Role"
            name="role"
            autoComplete="organization-title"
            maxLength={MAX_SHORT}
            value={draft.role}
            onChange={(event) => set('role', event.target.value)}
          />
          <div className="tm-field">
            <label className="tm-field__label" htmlFor={noteId}>
              What would you like to see?
            </label>
            <textarea
              id={noteId}
              name="note"
              className="tm-field__control tm-web-contact-form__note"
              rows={3}
              maxLength={MAX_NOTE}
              value={draft.note}
              onChange={(event) => set('note', event.target.value)}
              aria-describedby={failure ? errorId : undefined}
            />
          </div>
          <Checkbox
            className="tm-web-contact-form__choice"
            label="Send me product updates (optional)"
            name="updates"
            checked={draft.updates}
            onChange={(event) => set('updates', event.target.checked)}
          />

          {failure ? (
            <InlineAlert tone="danger" title="Could not send your request" live>
              <span id={errorId}>{failure}</span>
            </InlineAlert>
          ) : null}

          <Button
            type="submit"
            tone="lime"
            size="feature"
            className="tm-web-contact-form__submit"
            loading={sending}
            loadingLabel="Sending"
          >
            Book my demo
          </Button>
          <p className="tm-web-contact-form__caption">
            We reply within one business day. We never share your details.
          </p>
        </fieldset>
      </form>
    </div>
  );
}

/** Turn a thrown value into a sentence. The contact 400/429 messages carry no stored data. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) return 'Too many requests from this network. Please try again later.';
    return error.message;
  }
  if (error instanceof NetworkError) return 'We could not reach the server. Please try again.';
  return 'Something went wrong. Please try again.';
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
