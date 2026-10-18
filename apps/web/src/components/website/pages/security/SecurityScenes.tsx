'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, Checkbox, InlineAlert } from '@tmanage/ui';
import { cx } from '../../primitives';

/**
 * Security page product visuals — cropped clones of the admin offboarding run, the audit log,
 * the publication safety check and the client approval card, composed from packages/ui
 * components. Each scene is an illustration: inert, hidden from assistive tech, with one
 * sentence of alternative text in the caption.
 */
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

/* ── Offboarding run (AD offboarding, step 3 of 3) ─────────────────────────────── */

const OFFBOARDING_STEPS: readonly {
  title: string;
  note: string;
  state: 'done' | 'now' | 'next';
}[] = [
  {
    title: '14 work items moved',
    note: '9 to Lina Samir, 5 to Omar Adel · owners notified in Inbox',
    state: 'done',
  },
  {
    title: 'Homepage direction milestone reassigned to Omar Adel',
    note: 'Committed date 18 Aug unchanged · client sees no change',
    state: 'done',
  },
  {
    title: '6 automations repointed to Maya Hassan',
    note: 'None paused · next run 15:00 today',
    state: 'done',
  },
  {
    title: 'Deploy runbook given to Omar Adel as editor',
    note: 'Karim keeps read access until 22 Aug',
    state: 'done',
  },
  {
    title: 'Revoking 3 sessions and 1 personal device',
    note: 'Running now · he will be signed out within a minute',
    state: 'now',
  },
  {
    title: 'Account becomes read-only on 22 Aug, closed on 21 Sep',
    note: 'His name stays on everything he did',
    state: 'next',
  },
];

export function OffboardingScene() {
  return (
    <Scene
      label="The offboarding run for Karim Nabil: four of six steps done, sessions being revoked, and an immutable receipt for the audit log."
      className="tm-sec-scene--window"
    >
      <div className="tm-sec-window">
        <WindowBar crumb="Control center / Offboarding / Karim Nabil · Step 3 of 3 · RUN-OFF-0347" />
        <div className="tm-sec-window__body tm-sec-split">
          <div className="tm-sec-split__main">
            <p className="tm-web-scene__mono">Started 09:44 · 4 of 6 steps done</p>
            <p className="tm-sec-scene__title">Handing over Karim’s work</p>
            <ol className="tm-sec-card tm-sec-steps">
              {OFFBOARDING_STEPS.map((step) => (
                <li key={step.title} className={cx('tm-sec-step', `tm-sec-step--${step.state}`)}>
                  <span className="tm-sec-step__mark">{step.state === 'done' ? '✓' : null}</span>
                  <span className="tm-sec-step__text">
                    <span className="tm-sec-step__title">{step.title}</span>
                    <span className="tm-sec-step__note">{step.note}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="tm-sec-split__side">
            <div className="tm-sec-card tm-sec-receipt">
              <p className="tm-web-scene__mono">Receipt · Immutable</p>
              <p className="tm-sec-card__title">Offboarding of Karim Nabil</p>
              <KeyValues
                rows={[
                  ['Requested', 'Maya Hassan · today 09:44'],
                  ['Moved', '14 items · 1 milestone · 2 documents'],
                  ['Unchanged', 'every committed date, every approval'],
                  ['Revoked', '3 sessions · 1 unmanaged device'],
                  ['Hash', 'c30d·1f56'],
                ]}
              />
              <p className="tm-sec-scene__note">
                The receipt is written to the audit log as its own entry so a future reader can see
                exactly what moved.
              </p>
              <span className="tm-sec-actions">
                <Button tone="ink" size="compact">
                  Download receipt
                </Button>
                <Button tone="outline" size="compact">
                  Open in audit log
                </Button>
              </span>
            </div>
            <p className="tm-sec-card tm-sec-scene__note">
              A transfer can be undone for 24 hours. After that it stays in the history.
            </p>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Audit log (AD audit viewer) ───────────────────────────────────────────────── */

type AuditClass = 'Client' | 'Content' | 'Policy';

const AUDIT_ROWS: readonly {
  when: string;
  what: string;
  note: string;
  id: string;
  kind: AuditClass;
}[] = [
  {
    when: 'Today 09:40',
    what: 'Maya Hassan turned off “who did what” for Atlas Hospitality',
    note: 'client visibility default · was on since 4 Jul',
    id: 'EV-9C41',
    kind: 'Client',
  },
  {
    when: 'Today 08:02',
    what: 'Automation “Remind reviewer” notified Youssef Kamal',
    note: 'enabled by Maya Hassan · run RUN-4806',
    id: 'EV-9C38',
    kind: 'Content',
  },
  {
    when: 'Yest 18:12',
    what: 'Omar Adel added stage “Content migration” to Website relaunch',
    note: 'template edit · 3 seeded items',
    id: 'EV-9C11',
    kind: 'Policy',
  },
  {
    when: 'Yest 11:30',
    what: 'Youssef Kamal approved Homepage Concept v2',
    note: 'version 8f2c·d41a · signed from a trusted device',
    id: 'EV-9BF7',
    kind: 'Client',
  },
  {
    when: '13 Aug 18:04',
    what: 'Maya Hassan required two-factor for approval authority',
    note: 'security policy · affected 2 people',
    id: 'EV-9A12',
    kind: 'Policy',
  },
  {
    when: '12 Aug 14:09',
    what: 'Omar Adel moved the Content migration forecast to 8 Sep',
    note: 'committed date 1 Sep unchanged · reason recorded',
    id: 'EV-9A88',
    kind: 'Content',
  },
  {
    when: '11 Aug 09:15',
    what: 'Maya Hassan set chat retention to 24 months',
    note: 'first deletion pass queued for 1 Sep',
    id: 'EV-9A31',
    kind: 'Policy',
  },
];

export function AuditLogScene() {
  return (
    <Scene
      label="The audit log: 612 events with who changed what, an event id and a class, and the detail of one client-visibility change."
      className="tm-sec-scene--window tm-sec-scene--dense"
    >
      <div className="tm-sec-window">
        <WindowBar crumb="Control center / Audit log">
          <span className="tm-web-chip">Last 30 days</span>
          <span className="tm-web-chip">Policy changes</span>
          <span className="tm-web-chip tm-sec-chip--ink">Export signed CSV</span>
        </WindowBar>
        <div className="tm-sec-window__body tm-sec-split">
          <div className="tm-sec-split__main tm-sec-card tm-sec-audit">
            <p className="tm-sec-audit__count">
              <span className="tm-sec-scene__title">612 events</span>
              <span className="tm-sec-scene__note">41 policy · 108 access · 463 content</span>
            </p>
            <div className="tm-sec-audit__table">
              <div className="tm-sec-audit__row tm-sec-audit__row--head">
                <span className="tm-web-scene__mono">When</span>
                <span className="tm-web-scene__mono">Who · what changed</span>
                <span className="tm-web-scene__mono">Event</span>
                <span className="tm-web-scene__mono">Class</span>
              </div>
              {AUDIT_ROWS.map((row, index) => (
                <div
                  key={row.id}
                  className={cx('tm-sec-audit__row', index === 0 && 'tm-sec-audit__row--on')}
                >
                  <span className="tm-web-scene__mono">{row.when}</span>
                  <span className="tm-sec-step__text">
                    <span className="tm-sec-step__title">{row.what}</span>
                    <span className="tm-sec-step__note">{row.note}</span>
                  </span>
                  <span className="tm-web-scene__mono">{row.id}</span>
                  <Badge tone={row.kind === 'Client' ? 'client' : 'neutral'}>{row.kind}</Badge>
                </div>
              ))}
            </div>
          </div>
          <div className="tm-sec-split__side tm-sec-card tm-sec-receipt">
            <p className="tm-web-scene__mono">Event EV-9C41</p>
            <p className="tm-sec-card__title">Client visibility changed</p>
            <KeyValues
              rows={[
                ['Actor', 'Maya Hassan · Owner'],
                ['Target', 'Atlas Hospitality'],
                ['Before', '“who did what” on'],
                ['After', '“who did what” off'],
                ['Device', 'managed laptop'],
                ['Hash', 'a71e·0c94'],
              ]}
            />
            <p className="tm-sec-scene__note">
              Audit entries cannot be edited or deleted, not even by an owner. Export them as a
              signed file.
            </p>
            <span className="tm-sec-actions">
              <Button tone="outline" size="compact">
                Copy hash
              </Button>
            </span>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Publication safety check (DOC publish preview + portal projection) ────────── */

const RECIPIENTS: readonly { name: string; role: string; chip: string; lime?: boolean }[] = [
  {
    name: 'Youssef Kamal',
    role: 'Client Reviewer · approval authority · action required',
    chip: 'Will be asked to approve',
    lime: true,
  },
  { name: 'Salma Riad', role: 'Client Admin · watcher · notified', chip: 'Can view' },
  { name: 'Dina Ashraf', role: 'Client Viewer · not included by the project policy', chip: '' },
];

export function PublicationScene() {
  return (
    <Scene
      label="The safety check before publishing Homepage Concept v2: two client reviewers, the internal content excluded, one warning, and the true client projection beside it."
      className="tm-sec-scene--window tm-sec-scene--publish"
    >
      <div className="tm-sec-window tm-sec-window--plain">
        <div className="tm-sec-window__body tm-sec-split tm-sec-split--publish">
          <div className="tm-sec-split__main tm-sec-card tm-sec-publish">
            <p className="tm-web-scene__mono">Safety check before publication</p>
            <p className="tm-sec-scene__title">
              You’re about to publish Homepage Concept v2 to 2 client reviewers.
            </p>
            <p className="tm-sec-scene__note">
              Internal comments and cost fields will not be shared.
            </p>
            <p className="tm-web-scene__mono">Recipients</p>
            <ul className="tm-sec-recipients">
              {RECIPIENTS.map((person) => (
                <li key={person.name} className="tm-sec-recipient">
                  <Avatar name={person.name} audience="client" size="compact" decorative />
                  <span className="tm-sec-step__text">
                    <span className="tm-sec-step__title">{person.name}</span>
                    <span className="tm-sec-step__note">{person.role}</span>
                  </span>
                  {person.chip ? (
                    <span className={cx('tm-web-chip', person.lime && 'tm-sec-chip--lime')}>
                      {person.chip}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="tm-web-scene__mono">What is excluded from the projection</p>
            <span className="tm-sec-chips">
              <span className="tm-web-chip">4 internal comments</span>
              <span className="tm-web-chip">Cost field · production estimate</span>
              <span className="tm-web-chip">v1 history</span>
            </span>
            <InlineAlert tone="warning" title="One linked item points to internal-only content">
              The artifact links to “Booking provider decision (draft)”. The link will be removed
              from the client projection.
            </InlineAlert>
          </div>
          <div className="tm-sec-split__side tm-sec-projection">
            <span className="tm-web-chip tm-sec-chip--ink">True projection as Youssef Kamal</span>
            <div className="tm-sec-card tm-sec-portal">
              <p className="tm-web-scene__mono">Atlas Hospitality portal</p>
              <p className="tm-web-scene__mono">Action required from you</p>
              <p className="tm-sec-scene__title">Approve the homepage direction</p>
              <p className="tm-sec-scene__note">
                Reviewing takes about 10 minutes. Approve this week and we start the build on
                Monday.
              </p>
              <span className="tm-sec-actions">
                <Button tone="lime" size="compact">
                  Approve v2
                </Button>
                <Button tone="outline" size="compact">
                  Request changes
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

export function ApprovalScene() {
  return (
    <Scene
      label="A client approval card: the exact version being decided on, four things to confirm and the Approve version 2 button."
      className="tm-sec-scene--approval"
    >
      <div className="tm-sec-card tm-sec-approval">
        <p className="tm-web-scene__mono">What you are deciding on</p>
        <p className="tm-sec-version">
          <span className="tm-sec-version__id">v2 · 8f2c·d41a</span>
          <span className="tm-web-scene__mono">13 Aug 09:12</span>
        </p>
        <p className="tm-sec-scene__note">
          Your decision is recorded against this exact version. If the file changes, the approval
          stops being valid and we ask you again.
        </p>
        <hr className="tm-sec-rule" />
        <p className="tm-web-scene__mono">What you are confirming</p>
        <div className="tm-sec-checks">
          <Checkbox label="The brand feels right" readOnly tabIndex={-1} />
          <Checkbox label="Booking is easy to find" readOnly tabIndex={-1} />
          <Checkbox label="Arabic and English match" readOnly tabIndex={-1} />
          <Checkbox label="The phone layout works" readOnly tabIndex={-1} />
        </div>
        <Button tone="lime" size="accessible" className="tm-sec-approval__button">
          Approve version 2
        </Button>
        <Button tone="outline" size="accessible" className="tm-sec-approval__button">
          Request changes
        </Button>
      </div>
    </Scene>
  );
}
