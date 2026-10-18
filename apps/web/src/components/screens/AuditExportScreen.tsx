'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Field, InlineAlert } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
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

/** The first instant of a `YYYY-MM-DD` day, in UTC. */
function startOfDay(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/** The last instant of a `YYYY-MM-DD` day, in UTC. */
function endOfDay(day: string): string {
  return `${day}T23:59:59.999Z`;
}

/**
 * **Audit export** — ADM-10 "Your data leaves whenever you want" (x118 filtered export).
 *
 * The left card is the export bundle: a bounded date window (at most
 * `MAX_AUDIT_EXPORT_WINDOW_DAYS`) and two optional narrowings. When the window is valid the card's
 * action becomes a plain download link to `GET …/audit/export`, which the API gates on
 * `audit.export` and answers with `Content-Disposition: attachment` — no bytes pass through the app,
 * and a caller without the grant sees the API's refusal. The right card states what the file holds.
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
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="data"
      crumbs={['Data']}
      title="Your data leaves whenever you want"
      actions={
        <Link
          href={`/${organizationSlug}/admin/audit`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          Open audit log
        </Link>
      }
    >
      <div className="tm-cc-split tm-cc-split--even">
        <section className="tm-cc-card" aria-labelledby="tm-audit-export-heading">
          <h2 id="tm-audit-export-heading" className="tm-cc-card__title">
            Audit export
          </h2>
          <form className="tm-cc-form" aria-label="Audit export filters">
            <div className="tm-cc-form__pair">
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

            <hr className="tm-cc-rule" />
            <div className="tm-row tm-row--between tm-row--wrap">
              <p className="tm-cc-note">
                Exports are CSV and cover at most {MAX_AUDIT_EXPORT_WINDOW_DAYS} days.
              </p>
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
        </section>

        <section
          className="tm-cc-card tm-cc-card--quiet tm-cc-card--fill"
          aria-labelledby="tm-audit-export-contents"
        >
          <p className="tm-cc-eyebrow">What the file holds</p>
          <h2 id="tm-audit-export-contents" className="tm-cc-card__title">
            One row per audit event in the window
          </h2>
          <ul className="tm-cc-rows">
            <li>
              <span className="tm-cc-rows__title">When, who and what changed</span>
              <span className="tm-cc-cell-mono">CSV</span>
            </li>
            <li>
              <span className="tm-cc-rows__title">The object the change was made to</span>
              <span className="tm-cc-cell-mono">Type + id</span>
            </li>
            <li>
              <span className="tm-cc-rows__title">Narrowed to one actor or action</span>
              <span className="tm-cc-cell-mono">Optional</span>
            </li>
          </ul>
          <p className="tm-cc-card__body">
            Audit entries cannot be edited or deleted, including by an owner.
          </p>
        </section>
      </div>
    </ControlCenterShell>
  );
}
