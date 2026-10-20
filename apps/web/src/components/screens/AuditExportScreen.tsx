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
import { useT } from '../../lib/i18n/use-t';

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
  const t = useT();
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');

  const windowError = useMemo(() => {
    if (fromDay === '' || toDay === '') return null;
    const fromMs = Date.parse(startOfDay(fromDay));
    const toMs = Date.parse(endOfDay(toDay));
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return t('AuditExportScreen.errorInvalidDates');
    if (fromMs > toMs) return t('AuditExportScreen.errorToBeforeFrom');
    if (toMs - fromMs > MAX_AUDIT_EXPORT_WINDOW_DAYS * MS_PER_DAY) {
      return `${t('AuditExportScreen.windowMaxPrefix')} ${MAX_AUDIT_EXPORT_WINDOW_DAYS} ${t('AuditExportScreen.windowMaxSuffix')}`;
    }
    return null;
  }, [fromDay, toDay, t]);

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
      crumbs={[t('AuditExportScreen.crumbData')]}
      title={t('AuditExportScreen.title')}
      actions={
        <Link
          href={`/${organizationSlug}/admin/audit`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          {t('AuditExportScreen.openAuditLog')}
        </Link>
      }
    >
      <div className="tm-cc-split tm-cc-split--even">
        <section className="tm-cc-card" aria-labelledby="tm-audit-export-heading">
          <h2 id="tm-audit-export-heading" className="tm-cc-card__title">
            {t('AuditExportScreen.cardTitle')}
          </h2>
          <form className="tm-cc-form" aria-label={t('AuditExportScreen.filtersLabel')}>
            <div className="tm-cc-form__pair">
              <Field
                label={t('AuditExportScreen.from')}
                type="date"
                value={fromDay}
                onChange={(event) => setFromDay(event.currentTarget.value)}
                required
              />
              <Field
                label={t('AuditExportScreen.to')}
                type="date"
                value={toDay}
                onChange={(event) => setToDay(event.currentTarget.value)}
                required
              />
            </div>
            <Field
              label={t('AuditExportScreen.actorId')}
              value={actor}
              onChange={(event) => setActor(event.currentTarget.value)}
              hint={t('AuditExportScreen.actorHint')}
            />
            <Field
              label={t('AuditExportScreen.action')}
              value={action}
              onChange={(event) => setAction(event.currentTarget.value)}
              hint={t('AuditExportScreen.actionHint')}
            />

            {windowError ? <InlineAlert tone="danger">{windowError}</InlineAlert> : null}

            <hr className="tm-cc-rule" />
            <div className="tm-row tm-row--between tm-row--wrap">
              <p className="tm-cc-note">
                {t('AuditExportScreen.exportNotePrefix')} {MAX_AUDIT_EXPORT_WINDOW_DAYS}{' '}
                {t('AuditExportScreen.exportNoteSuffix')}
              </p>
              {href ? (
                <a
                  className="tm-button tm-button--ink tm-button--compact"
                  href={href}
                  download="audit-export.csv"
                >
                  {t('AuditExportScreen.exportCsv')}
                </a>
              ) : windowError ? null : (
                <InlineAlert tone="neutral">{t('AuditExportScreen.chooseDates')}</InlineAlert>
              )}
            </div>
          </form>
        </section>

        <section
          className="tm-cc-card tm-cc-card--quiet tm-cc-card--fill"
          aria-labelledby="tm-audit-export-contents"
        >
          <p className="tm-cc-eyebrow">{t('AuditExportScreen.whatFileHolds')}</p>
          <h2 id="tm-audit-export-contents" className="tm-cc-card__title">
            {t('AuditExportScreen.contentsTitle')}
          </h2>
          <ul className="tm-cc-rows">
            <li>
              <span className="tm-cc-rows__title">{t('AuditExportScreen.rowWhen')}</span>
              <span className="tm-cc-cell-mono">CSV</span>
            </li>
            <li>
              <span className="tm-cc-rows__title">{t('AuditExportScreen.rowObject')}</span>
              <span className="tm-cc-cell-mono">{t('AuditExportScreen.cellTypeId')}</span>
            </li>
            <li>
              <span className="tm-cc-rows__title">{t('AuditExportScreen.rowNarrowed')}</span>
              <span className="tm-cc-cell-mono">{t('AuditExportScreen.cellOptional')}</span>
            </li>
          </ul>
          <p className="tm-cc-card__body">{t('AuditExportScreen.cannotEdit')}</p>
        </section>
      </div>
    </ControlCenterShell>
  );
}
