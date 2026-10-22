'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, Checkbox, InlineAlert } from '@tmanage/ui';
import { cx } from '../../primitives';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';

/**
 * Security page product visuals — cropped clones of the admin offboarding run, the audit log,
 * the publication safety check and the client approval card, composed from packages/ui
 * components. Each scene is an illustration: inert, hidden from assistive tech, with one
 * sentence of alternative text in the caption. Every visible string is a `SecurityScenes.*`
 * catalog key; names, IDs, hashes and version tags stay Latin.
 */

type Values = Readonly<Record<string, string | number>>;

/** `t()` scoped to `SecurityScenes.*`, with `{name}` placeholders filled from `values`. */
function useSceneT(): (key: string, values?: Values) => string {
  const t = useT();
  return (key, values = {}) =>
    t(`SecurityScenes.${key}` as MessageKey).replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
    );
}

function Scene({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-web-scene', 'tm-sec-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

/** The product window chrome: ink tile and a mono breadcrumb, optional controls on the end. */
function WindowBar({ crumb, children }: { crumb: string; children?: ReactNode }) {
  return (
    <div className="tm-sec-window__bar">
      <span className="tm-sec-window__tile" />
      <span className="tm-web-scene__mono">{crumb}</span>
      {children ? <span className="tm-sec-window__controls">{children}</span> : null}
    </div>
  );
}

function KeyValues({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="tm-sec-kv">
      {rows.map(([key, value]) => (
        <div key={key} className="tm-sec-kv__row">
          <dt className="tm-web-scene__mono">{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Offboarding run (AD offboarding, the step now running) ────────────────────── */

type StepState = 'done' | 'now' | 'next';

/** The six offboarding steps; `id` names the `SecurityScenes.step<Id>Title/Note` keys. */
export const OFFBOARDING_STEPS: readonly { id: string; state: StepState }[] = [
  { id: 'Moved', state: 'done' },
  { id: 'Milestone', state: 'done' },
  { id: 'Automations', state: 'done' },
  { id: 'Runbook', state: 'done' },
  { id: 'Sessions', state: 'now' },
  { id: 'Readonly', state: 'next' },
];

/**
 * The progress both the breadcrumb and the panel read, so they cannot disagree: how many steps
 * are done, which step is running (1-based) and how many there are.
 */
export function offboardingProgress(steps: readonly { state: StepState }[] = OFFBOARDING_STEPS): {
  done: number;
  current: number;
  total: number;
} {
  const done = steps.filter((step) => step.state === 'done').length;
  const running = steps.findIndex((step) => step.state === 'now');
  return { done, current: running === -1 ? done : running + 1, total: steps.length };
}

export function OffboardingScene() {
  const t = useT();
  const s = useSceneT();
  const progress = offboardingProgress();
  return (
    <Scene label={t('SecurityScenes.offboardingAlt')} className="tm-sec-scene--window">
      <div className="tm-sec-window">
        <WindowBar crumb={s('offCrumb', progress)} />
        <div className="tm-sec-window__body tm-sec-split">
          <div className="tm-sec-split__main">
            <p className="tm-web-scene__mono">{s('offStarted', progress)}</p>
            <p className="tm-sec-scene__title">{s('offTitle')}</p>
            <ol className="tm-sec-card tm-sec-steps">
              {OFFBOARDING_STEPS.map((step) => (
                <li key={step.id} className={cx('tm-sec-step', `tm-sec-step--${step.state}`)}>
                  <span className="tm-sec-step__mark">{step.state === 'done' ? '✓' : null}</span>
                  <span className="tm-sec-step__text">
                    <span className="tm-sec-step__title">{s(`step${step.id}Title`)}</span>
                    <span className="tm-sec-step__note">{s(`step${step.id}Note`)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="tm-sec-split__side">
            <div className="tm-sec-card tm-sec-receipt">
              <p className="tm-web-scene__mono">{s('receiptEyebrow')}</p>
              <p className="tm-sec-card__title">{s('receiptTitle')}</p>
              <KeyValues
                rows={[
                  [s('kvRequested'), s('vRequested')],
                  [s('kvMoved'), s('vMoved')],
                  [s('kvUnchanged'), s('vUnchanged')],
                  [s('kvRevoked'), s('vRevoked')],
                  [s('kvHash'), 'c30d·1f56'],
                ]}
              />
              <p className="tm-sec-scene__note">{s('receiptNote')}</p>
              <span className="tm-sec-actions">
                <Button tone="ink" size="compact">
                  {s('downloadReceipt')}
                </Button>
                <Button tone="outline" size="compact">
                  {s('openInAudit')}
                </Button>
              </span>
            </div>
            <p className="tm-sec-card tm-sec-scene__note">{s('undoNote')}</p>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Audit log (AD audit viewer) ───────────────────────────────────────────────── */

type AuditClass = 'Client' | 'Content' | 'Policy';

/** `key` names the `SecurityScenes.audit<Key>When/What/Note` keys; `id` is the event id. */
const AUDIT_ROWS: readonly { key: string; id: string; kind: AuditClass }[] = [
  { key: 'Visibility', id: 'EV-9C41', kind: 'Client' },
  { key: 'Reminder', id: 'EV-9C38', kind: 'Content' },
  { key: 'Stage', id: 'EV-9C11', kind: 'Policy' },
  { key: 'Approved', id: 'EV-9BF7', kind: 'Client' },
  { key: 'TwoFactor', id: 'EV-9A12', kind: 'Policy' },
  { key: 'Forecast', id: 'EV-9A88', kind: 'Content' },
  { key: 'Retention', id: 'EV-9A31', kind: 'Policy' },
];

export function AuditLogScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <Scene
      label={t('SecurityScenes.auditLogAlt')}
      className="tm-sec-scene--window tm-sec-scene--dense"
    >
      <div className="tm-sec-window">
        <WindowBar crumb={s('auditCrumb')}>
          <span className="tm-web-chip">{s('chipLast30')}</span>
          <span className="tm-web-chip">{s('chipPolicy')}</span>
          <span className="tm-web-chip tm-sec-chip--ink">{s('chipExport')}</span>
        </WindowBar>
        <div className="tm-sec-window__body tm-sec-split">
          <div className="tm-sec-split__main tm-sec-card tm-sec-audit">
            <p className="tm-sec-audit__count">
              <span className="tm-sec-scene__title">{s('auditCount')}</span>
              <span className="tm-sec-scene__note">{s('auditBreakdown')}</span>
            </p>
            <div className="tm-sec-audit__table">
              <div className="tm-sec-audit__row tm-sec-audit__row--head">
                <span className="tm-web-scene__mono">{s('colWhen')}</span>
                <span className="tm-web-scene__mono">{s('colWho')}</span>
                <span className="tm-web-scene__mono">{s('colEvent')}</span>
                <span className="tm-web-scene__mono">{s('colClass')}</span>
              </div>
              {AUDIT_ROWS.map((row, index) => (
                <div
                  key={row.id}
                  className={cx('tm-sec-audit__row', index === 0 && 'tm-sec-audit__row--on')}
                >
                  <span className="tm-web-scene__mono">{s(`audit${row.key}When`)}</span>
                  <span className="tm-sec-step__text">
                    <span className="tm-sec-step__title">{s(`audit${row.key}What`)}</span>
                    <span className="tm-sec-step__note">{s(`audit${row.key}Note`)}</span>
                  </span>
                  <span className="tm-web-scene__mono">{row.id}</span>
                  <Badge tone={row.kind === 'Client' ? 'client' : 'neutral'}>
                    {s(`class${row.kind}`)}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
          <div className="tm-sec-split__side tm-sec-card tm-sec-receipt">
            <p className="tm-web-scene__mono">{s('eventEyebrow', { id: 'EV-9C41' })}</p>
            <p className="tm-sec-card__title">{s('eventTitle')}</p>
            <KeyValues
              rows={[
                [s('kvActor'), s('vActor')],
                [s('kvTarget'), 'Atlas Hospitality'],
                [s('kvBefore'), s('vBefore')],
                [s('kvAfter'), s('vAfter')],
                [s('kvDevice'), s('vDevice')],
                [s('kvHash'), 'a71e·0c94'],
              ]}
            />
            <p className="tm-sec-scene__note">{s('auditNote')}</p>
            <span className="tm-sec-actions">
              <Button tone="outline" size="compact">
                {s('copyHash')}
              </Button>
            </span>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Publication safety check (DOC publish preview + portal projection) ────────── */

/** `key` names the `SecurityScenes.recipient<Key>Role/Chip` keys. */
const RECIPIENTS: readonly { name: string; key: string; chip: boolean; lime?: boolean }[] = [
  { name: 'Youssef Kamal', key: 'Youssef', chip: true, lime: true },
  { name: 'Salma Riad', key: 'Salma', chip: true },
  { name: 'Dina Ashraf', key: 'Dina', chip: false },
];

export function PublicationScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <Scene
      label={t('SecurityScenes.publicationAlt')}
      className="tm-sec-scene--window tm-sec-scene--publish"
    >
      <div className="tm-sec-window tm-sec-window--plain">
        <div className="tm-sec-window__body tm-sec-split tm-sec-split--publish">
          <div className="tm-sec-split__main tm-sec-card tm-sec-publish">
            <p className="tm-web-scene__mono">{s('pubEyebrow')}</p>
            <p className="tm-sec-scene__title">{s('pubTitle')}</p>
            <p className="tm-sec-scene__note">{s('pubNote')}</p>
            <p className="tm-web-scene__mono">{s('recipients')}</p>
            <ul className="tm-sec-recipients">
              {RECIPIENTS.map((person) => (
                <li key={person.name} className="tm-sec-recipient">
                  <Avatar name={person.name} audience="client" size="compact" decorative />
                  <span className="tm-sec-step__text">
                    <span className="tm-sec-step__title">{person.name}</span>
                    <span className="tm-sec-step__note">{s(`recipient${person.key}Role`)}</span>
                  </span>
                  {person.chip ? (
                    <span className={cx('tm-web-chip', person.lime && 'tm-sec-chip--lime')}>
                      {s(`recipient${person.key}Chip`)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="tm-web-scene__mono">{s('excluded')}</p>
            <span className="tm-sec-chips">
              <span className="tm-web-chip">{s('chipComments')}</span>
              <span className="tm-web-chip">{s('chipCost')}</span>
              <span className="tm-web-chip">{s('chipHistory')}</span>
            </span>
            <InlineAlert tone="warning" title={s('alertTitle')}>
              {s('alertBody')}
            </InlineAlert>
          </div>
          <div className="tm-sec-split__side tm-sec-projection">
            <span className="tm-web-chip tm-sec-chip--ink">{s('projectionChip')}</span>
            <div className="tm-sec-card tm-sec-portal">
              <p className="tm-web-scene__mono">{s('portalEyebrow')}</p>
              <p className="tm-web-scene__mono">{s('portalAction')}</p>
              <p className="tm-sec-scene__title">{s('portalTitle')}</p>
              <p className="tm-sec-scene__note">{s('portalNote')}</p>
              <span className="tm-sec-actions">
                <Button tone="lime" size="compact">
                  {s('approveV2')}
                </Button>
                <Button tone="outline" size="compact">
                  {s('requestChanges')}
                </Button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Client approval card (CTA band visual) ────────────────────────────────────── */

const CHECKS = ['checkBrand', 'checkBooking', 'checkLanguages', 'checkPhone'] as const;

export function ApprovalScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <Scene label={t('SecurityScenes.approvalAlt')} className="tm-sec-scene--approval">
      <div className="tm-sec-card tm-sec-approval">
        <p className="tm-web-scene__mono">{s('decidingOn')}</p>
        <p className="tm-sec-version">
          <span className="tm-sec-version__id">v2 · 8f2c·d41a</span>
          <span className="tm-web-scene__mono">{s('versionDate')}</span>
        </p>
        <p className="tm-sec-scene__note">{s('versionNote')}</p>
        <hr className="tm-sec-rule" />
        <p className="tm-web-scene__mono">{s('confirming')}</p>
        <div className="tm-sec-checks">
          {CHECKS.map((key) => (
            <Checkbox key={key} label={s(key)} readOnly tabIndex={-1} />
          ))}
        </div>
        <Button tone="lime" size="accessible" className="tm-sec-approval__button">
          {s('approveVersion2')}
        </Button>
        <Button tone="outline" size="accessible" className="tm-sec-approval__button">
          {s('requestChanges')}
        </Button>
      </div>
    </Scene>
  );
}
