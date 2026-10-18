'use client';

import { useMemo, useState } from 'react';
import { Field, InlineAlert } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { apiBaseUrl } from '../../lib/api/browser-client';
import { usageExportUrl, MAX_USAGE_EXPORT_WINDOW_DAYS } from '../../lib/api/billing-usage-export';
import '../../styles/screens/billing.css';

export interface UsageExportScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the real API origin. */
  baseUrl?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A `YYYY-MM-DD` day to the ISO instant at its start (UTC). */
function startOfDay(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/** A `YYYY-MM-DD` day to the ISO instant at its end (UTC), so the window includes the whole day. */
function endOfDay(day: string): string {
  return `${day}T23:59:59.999Z`;
}

/**
 * **Export usage** — the billing usage CSV export (module 19, x227).
 *
 * A dedicated filter form over the org's usage counters' date-windowed CSV export, distinct from the
 * usage-alerts screen (x200). A required from/to **day window** and a single download control that
 * targets `GET .../billing/usage/export.csv`, gated on `org.manage`.
 *
 * Three decisions worth stating:
 *
 * 1. **Authorization is the API's.** The export sits behind `org.manage`, so a caller without it
 *    receives the API's refusal when the browser fetches the file; the screen never guesses a
 *    capability of its own.
 * 2. **The export is a browser download, not a fetch.** The control is a plain `<a download>` whose
 *    `href` carries the window; the browser requests the CSV with the session cookie and the API's
 *    `Content-Disposition: attachment` saves it, so no bytes are proxied through the app.
 * 3. **The window is validated on both sides.** The API is the authority (a missing, inverted or
 *    over-wide window is a 400), but the screen also refuses to offer the link for an inverted or
 *    over-wide window and says why, so the operator is not sent to a download that will 400.
 */
export function UsageExportScreen({
  organizationSlug,
  organizationName,
  baseUrl,
}: UsageExportScreenProps) {
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');

  const windowError = useMemo(() => {
    if (fromDay === '' || toDay === '') return null;
    const fromMs = Date.parse(startOfDay(fromDay));
    const toMs = Date.parse(endOfDay(toDay));
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 'Enter a valid from and to date.';
    if (fromMs > toMs) return 'The "to" date must not be earlier than the "from" date.';
    if (toMs - fromMs > MAX_USAGE_EXPORT_WINDOW_DAYS * MS_PER_DAY) {
      return `The window must not exceed ${MAX_USAGE_EXPORT_WINDOW_DAYS} days. Narrow it and try again.`;
    }
    return null;
  }, [fromDay, toDay]);

  const ready = fromDay !== '' && toDay !== '' && windowError === null;

  const href = useMemo(() => {
    if (!ready) return null;
    return usageExportUrl(baseUrl ?? apiBaseUrl(), organizationSlug, {
      from: startOfDay(fromDay),
      to: endOfDay(toDay),
    });
  }, [ready, baseUrl, organizationSlug, fromDay, toDay]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow="Control center · Billing"
      title="Export usage"
      description="Download a CSV of the organization's usage counters for a bounded date window."
    >
      <div className="tm-bil">
        <form className="tm-bil-card tm-bil-main tm-bil-export" aria-label="Usage export filters">
          <h2 className="tm-bil-card__title">Date window</h2>
          <div className="tm-row tm-row--wrap tm-bil-request-fields">
            <Field
              label="From"
              type="date"
              value={fromDay}
              onChange={(event) => setFromDay(event.currentTarget.value)}
              required
            />
            <Field
              label="To"
              type="date"
              value={toDay}
              onChange={(event) => setToDay(event.currentTarget.value)}
              required
            />
          </div>

          {windowError ? <InlineAlert tone="danger">{windowError}</InlineAlert> : null}

          <div className="tm-row tm-row--wrap">
            {href ? (
              <a
                className="tm-button tm-button--ink tm-button--compact"
                href={href}
                download="usage-export.csv"
              >
                Export CSV
              </a>
            ) : windowError ? null : (
              <InlineAlert tone="neutral">
                Choose a from and to date to enable the export.
              </InlineAlert>
            )}
          </div>
        </form>
        <section className="tm-bil-card tm-bil-card--paper" aria-labelledby="tm-usage-export-note">
          <h2 id="tm-usage-export-note" className="tm-bil-eyebrow">
            What the file holds
          </h2>
          <p className="tm-bil-card__body">
            The organization&rsquo;s usage counters for the window, as a CSV a spreadsheet opens.
            The window can be at most {MAX_USAGE_EXPORT_WINDOW_DAYS} days.
          </p>
          <p className="tm-bil-card__foot">Only owners can export usage.</p>
        </section>
      </div>
    </AppShell>
  );
}
