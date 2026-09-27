'use client';

import { useMemo, useState } from 'react';
import { Field, InlineAlert } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { apiBaseUrl } from '../../lib/api/browser-client';
import {
  auditFilteredExportUrl,
  MAX_AUDIT_EXPORT_WINDOW_DAYS,
} from '../../lib/api/admin-audit-export';

export interface AuditExportScreenProps {
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
 * **Export audit log** — the ADM-09 filtered export (module 18, x197).
 *
 * A dedicated filter form over the audit trail's date-windowed CSV export, distinct from the audit
 * viewer (x115) and its whole-trail export link (x118). Four filters — a required from/to **day
 * window**, and an optional actor and action — and a single download control that targets
 * `GET .../audit/export.csv`, gated on `audit.export`.
 *
 * Three decisions worth stating:
 *
 * 1. **Authorization is the API's.** The export sits behind `audit.export` — a stronger grant than
 *    the `audit.read` the viewer uses — so a caller without it receives the API's refusal when the
 *    browser fetches the file; the screen never guesses a capability of its own.
 * 2. **The export is a browser download, not a fetch.** The control is a plain `<a download>` whose
 *    `href` carries the filters; the browser requests the CSV with the session cookie and the API's
 *    `Content-Disposition: attachment` saves it, so no bytes are proxied through the app.
 * 3. **The window is validated on both sides.** The API is the authority (a missing, inverted or
 *    over-wide window is a 400), but the screen also refuses to offer the link for an inverted or
 *    over-wide window and says why, so the operator is not sent to a download that will 400.
 */
export function AuditExportScreen({
  organizationSlug,
  organizationName,
  baseUrl,
}: AuditExportScreenProps) {
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');

  const windowError = useMemo(() => {
    if (fromDay === '' || toDay === '') return null;
    const fromMs = Date.parse(startOfDay(fromDay));
    const toMs = Date.parse(endOfDay(toDay));
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 'Enter a valid from and to date.';
    if (fromMs > toMs) return 'The "to" date must not be earlier than the "from" date.';
    if (toMs - fromMs > MAX_AUDIT_EXPORT_WINDOW_DAYS * MS_PER_DAY) {
      return `The window must not exceed ${MAX_AUDIT_EXPORT_WINDOW_DAYS} days. Narrow it and try again.`;
    }
    return null;
  }, [fromDay, toDay]);

  const ready = fromDay !== '' && toDay !== '' && windowError === null;

  const href = useMemo(() => {
    if (!ready) return null;
    return auditFilteredExportUrl(baseUrl ?? apiBaseUrl(), organizationSlug, {
      from: startOfDay(fromDay),
      to: endOfDay(toDay),
      ...(actor.trim() === '' ? {} : { actor: actor.trim() }),
      ...(action.trim() === '' ? {} : { action: action.trim() }),
    });
  }, [ready, baseUrl, organizationSlug, fromDay, toDay, actor, action]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Export audit log"
      description="Download a CSV of the audit trail for a bounded date window."
    >
      <form className="tm-stack tm-stack--tight" aria-label="Audit export filters">
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
        <Field
          label="Actor ID"
          value={actor}
          onChange={(event) => setActor(event.currentTarget.value)}
          hint="Optional. Limit the export to one user's actions."
        />
        <Field
          label="Action"
          value={action}
          onChange={(event) => setAction(event.currentTarget.value)}
          hint="Optional. An exact action name, e.g. membership.revoked."
        />

        {windowError ? <InlineAlert tone="danger">{windowError}</InlineAlert> : null}

        <div className="tm-row tm-row--wrap">
          {href ? (
            <a
              className="tm-button tm-button--ink tm-button--compact"
              href={href}
              download="audit-export.csv"
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
    </AppShell>
  );
}
