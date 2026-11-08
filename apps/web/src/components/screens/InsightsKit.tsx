'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import '../../styles/screens/insights.css';
import { useT } from '../../lib/i18n/use-t';

/**
 * The shared visual pieces of the INS-01 … INS-06 frames (`TManage Screens - Insights and
 * Admin.dc.html`, `TManage Screens - Insights Extended.dc.html`): the section tab bar, the 72px
 * metric with its trend capsule, the mono-headed evidence card, the horizontal bar rows, the
 * outlined "pattern worth acting on" callout and the dark "what this is not" note.
 *
 * Purely presentational: every figure is passed in by a screen that read it from the API. Nothing
 * here fetches, and nothing here invents a number.
 */

export type InsightsTabId = 'overview' | 'health' | 'flow' | 'approvals' | 'workload' | 'adoption';

/**
 * INS-01's tab bar. The per-project tabs (health, flow, approvals) need a project; without one
 * they lead back to the overview, which is where a project is picked.
 */
export function InsightsTabs({
  organizationSlug,
  current,
  projectId,
}: {
  organizationSlug: string;
  current?: InsightsTabId;
  projectId?: string;
}) {
  const t = useT();
  const base = `/${organizationSlug}/insights`;
  const project = projectId ? `${base}/projects/${encodeURIComponent(projectId)}` : base;
  const tabs: readonly { id: InsightsTabId; label: string; href: string }[] = [
    { id: 'overview', label: t('InsightsKit.tabOverview'), href: base },
    { id: 'health', label: t('InsightsKit.tabProjectHealth'), href: project },
    {
      id: 'flow',
      label: t('InsightsKit.tabDeliveryFlow'),
      href: projectId ? `${project}#tm-delivery-flow` : base,
    },
    {
      id: 'approvals',
      label: t('InsightsKit.tabApprovalFlow'),
      href: projectId ? `${project}/approval-cycle` : base,
    },
    { id: 'workload', label: t('InsightsKit.tabWorkload'), href: `${base}/workload` },
    { id: 'adoption', label: t('InsightsKit.tabAdoption'), href: `${base}/adoption` },
  ];

  return (
    <nav className="tm-ins-tabs" aria-label={t('InsightsKit.sectionsNav')}>
      {tabs.map((tab) => {
        const active = tab.id === current;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            className="tm-ins-tabs__tab"
            {...(active ? { 'aria-current': 'page' as const } : {})}
          >
            {tab.label}
            {active ? <span className="tm-ins-tabs__dot" aria-hidden="true" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export type InsightsTone = 'danger' | 'warning' | 'lime' | 'quiet';

/** One of the three 72px headline figures: value, trend capsule, label, and the evidence line. */
export function InsightsMetric({
  value,
  badge,
  badgeTone = 'quiet',
  label,
  note,
}: {
  value: ReactNode;
  badge?: ReactNode;
  badgeTone?: InsightsTone;
  label: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="tm-ins-metric">
      <div className="tm-ins-metric__figure">
        <span className="tm-ins-metric__value">{value}</span>
        {badge !== undefined ? (
          <span className="tm-ins-badge" data-tone={badgeTone}>
            {badge}
          </span>
        ) : null}
      </div>
      <p className="tm-ins-metric__label">{label}</p>
      {note ? <p className="tm-ins-metric__note">{note}</p> : null}
    </div>
  );
}

export function InsightsMetrics({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="tm-ins-metrics" aria-label={label}>
      {children}
    </section>
  );
}

/** A white 24px card. `variant="callout"` is the 2px-ink outlined card, `note` the dark one. */
export function InsightsCard({
  children,
  variant = 'plain',
  className,
  labelledBy,
  label,
  id,
}: {
  children: ReactNode;
  variant?: 'plain' | 'callout' | 'note' | 'table';
  className?: string;
  labelledBy?: string;
  /** An accessible name when no visible heading labels the card. */
  label?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={['tm-ins-card', `tm-ins-card--${variant}`, className].filter(Boolean).join(' ')}
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
      {...(label && !labelledBy ? { 'aria-label': label } : {})}
    >
      {children}
    </section>
  );
}

/** The card heading row: the 18px title and the mono units at the end. */
export function InsightsCardHead({
  id,
  title,
  units,
  level = 'h2',
}: {
  id?: string;
  title: ReactNode;
  units?: ReactNode;
  level?: 'h2' | 'h3';
}) {
  const Heading = level;
  return (
    <div className="tm-ins-card__head">
      <Heading id={id} className="tm-ins-card__title">
        {title}
      </Heading>
      {units ? <span className="tm-ins-card__units">{units}</span> : null}
    </div>
  );
}

/** The dark "what this report will not do" note. Copy is the frame's own product statement. */
export function InsightsNote({
  eyebrow,
  children,
  action,
}: {
  eyebrow: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <aside className="tm-ins-card tm-ins-card--note" aria-label={eyebrow}>
      <p className="tm-ins-eyebrow">{eyebrow}</p>
      <p className="tm-ins-note__body">{children}</p>
      {action}
    </aside>
  );
}

export interface InsightsBar {
  key: string;
  label: ReactNode;
  value: number;
  display?: ReactNode;
  tone?: 'ink' | 'lime' | 'success' | 'warning' | 'danger';
  emphasis?: boolean;
}

/** Horizontal bar rows (INS-01 "Approval wait by stage", INS-04 outcomes, INS-06 decisions). */
export function InsightsBars({ bars, label }: { bars: readonly InsightsBar[]; label: string }) {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <ul className="tm-ins-bars" aria-label={label}>
      {bars.map((bar) => (
        <li key={bar.key} className="tm-ins-bars__row" data-emphasis={bar.emphasis || undefined}>
          <span className="tm-ins-bars__label">{bar.label}</span>
          <span className="tm-ins-bars__track" aria-hidden="true">
            {bar.value > 0 ? (
              <span
                className="tm-ins-bars__fill"
                data-tone={bar.tone ?? 'ink'}
                style={{ inlineSize: `${Math.round((bar.value / max) * 100)}%` }}
              />
            ) : null}
          </span>
          <span className="tm-ins-bars__value">{bar.display ?? bar.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The two-column body: the evidence table (1.3) beside the side cards (1). */
export function InsightsSplit({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="tm-ins-split">
      <div className="tm-ins-split__main">{main}</div>
      <div className="tm-ins-split__side">{side}</div>
    </div>
  );
}
