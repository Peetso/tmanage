'use client';

import type { ReactNode } from 'react';
import { Avatar, Button, Checkbox, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { cx } from '../../primitives';
import { useT } from '../../../../lib/i18n/use-t';

/** Mono caption: the shared Web/Eyebrow text style, laid out as plain text inside scenes. */
const MONO = 'tm-web-eyebrow tm-inh-mono';

/**
 * Product scenes for Solutions · In-house teams — small clones of the real request inbox,
 * request-form builder, version review and workload screens, composed from packages/ui parts.
 * Each one is an illustration: `inert`, hidden from assistive tech, with one sentence of
 * alternative text in its caption.
 */
function WindowScene({
  label,
  url,
  className,
  children,
}: {
  label: string;
  url: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-inh-window', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-inh-window__body" aria-hidden="true" inert>
        <div className="tm-inh-window__bar">
          <span className="tm-inh-window__dot" />
          <span className="tm-inh-window__dot" />
          <span className="tm-inh-window__dot" />
          <span className={MONO}>{url}</span>
        </div>
        <div className="tm-inh-window__content">{children}</div>
      </div>
    </figure>
  );
}

interface InboxRow {
  title: string;
  from: string;
  state: { tone: CapsuleState; label: string };
  desired: string;
  age: string;
  late?: boolean;
  declined?: boolean;
}

const INBOX: readonly InboxRow[] = [
  {
    title: 'Add Arabic booking FAQ before launch',
    from: 'Salma Riad · Marketing',
    state: { tone: 'current', label: 'Needs triage' },
    desired: '3 Sep',
    age: '2d',
    late: true,
  },
  {
    title: 'Add an analytics dashboard',
    from: 'Karim Nabil · Finance',
    state: { tone: 'current', label: 'Needs triage' },
    desired: 'not set',
    age: '4h',
  },
  {
    title: 'Change the launch hero photograph',
    from: 'Youssef Kamal · Marketing',
    state: { tone: 'waiting', label: 'Clarifying' },
    desired: '15 Sep',
    age: '1d',
  },
  {
    title: 'Multi-language newsletter signup',
    from: 'Noor Fathy · Operations',
    state: { tone: 'future', label: 'Deferred' },
    desired: '—',
    age: '6d',
  },
  {
    title: 'Rebuild the loyalty programme',
    from: 'Declined with reason · out of scope',
    state: { tone: 'archived', label: 'Declined' },
    desired: '—',
    age: '2w',
    declined: true,
  },
];

/** REQ-01 request inbox — the hero visual. */
export function RequestInboxScene() {
  const t = useT();
  return (
    <WindowScene
      label={t('SolutionsInhouseScenes.requestInboxAlt')}
      url="app.tmanage.com/requests/inbox"
      className="tm-inh-window--hero"
    >
      <div className="tm-inh-inbox">
        <div className="tm-inh-inbox__row tm-inh-inbox__row--head">
          <span className={MONO}>Request</span>
          <span className={MONO}>State</span>
          <span className={MONO}>Desired</span>
          <span className={cx(MONO, 'tm-inh-inbox__age')}>Age</span>
        </div>
        {INBOX.map((row, index) => (
          <div
            key={row.title}
            className={cx(
              'tm-inh-inbox__row',
              index === 0 && 'tm-inh-inbox__row--on',
              row.declined && 'tm-inh-inbox__row--muted',
            )}
          >
            <span className="tm-inh-inbox__request">
              <span className="tm-metric__label tm-inh-inbox__title">{row.title}</span>
              <span className={MONO}>{row.from}</span>
            </span>
            <span>
              <StateCapsule state={row.state.tone}>{row.state.label}</StateCapsule>
            </span>
            <span className={cx(MONO, row.late && 'tm-inh-warn')}>{row.desired}</span>
            <span className={cx(MONO, 'tm-inh-inbox__age', row.late && 'tm-inh-warn')}>
              {row.age}
            </span>
          </div>
        ))}
        <p className={cx(MONO, 'tm-inh-inbox__foot')}>
          <span>5 requests · 2 need triage</span>
          <span className="tm-inh-warn">1 past its desired date</span>
        </p>
      </div>
    </WindowScene>
  );
}

const QUESTIONS: readonly { q: string; kind: string; on?: boolean }[] = [
  { q: 'What do you need?', kind: 'Short text · required' },
  { q: 'Why does it matter?', kind: 'Long text' },
  { q: 'When would you like it?', kind: 'Date · labelled “desired, not a promise”', on: true },
  { q: 'Attach anything helpful', kind: 'Files · max 5' },
];

/** REQ request-form builder beside the requester's view of the same form. */
export function IntakeFormScene() {
  const t = useT();
  return (
    <WindowScene
      label={t('SolutionsInhouseScenes.intakeFormAlt')}
      url="app.tmanage.com/requests/forms"
    >
      <div className="tm-inh-intake">
        <div className="tm-inh-intake__builder">
          <p className="tm-inline-alert__title tm-inh-intake__heading">Builder</p>
          {QUESTIONS.map((item) => (
            <div key={item.q} className={cx('tm-inh-question', item.on && 'tm-inh-question--on')}>
              <span className="tm-inh-question__q">{item.q}</span>
              <span className={cx(MONO, item.on && 'tm-inh-warn')}>{item.kind}</span>
            </div>
          ))}
          <span className="tm-inh-question tm-inh-question--add">+ Add a question</span>
          <p className={cx(MONO, 'tm-inh-intake__foot')}>
            Submissions land in the team inbox as uncommitted requests
          </p>
        </div>
        <div className="tm-inh-intake__view">
          <p className="tm-inh-intake__who">
            <Avatar name="Marketing team" size="compact" decorative />
            <span>Requester view</span>
          </p>
          <p className="tm-inline-alert__title tm-inh-intake__title">
            Ask the Marketing team for something
          </p>
          <span className="tm-inh-input">A short title…</span>
          <span className="tm-inh-input tm-inh-input--area">Why it matters…</span>
          <span className="tm-inh-input tm-inh-input--date">
            <span>3 September 2026</span>
            <span className="tm-inh-input__hint">
              This is a wish, not a promise. We will confirm a date after review.
            </span>
          </span>
          <Button tone="ink" size="default" className="tm-inh-full">
            Send the request
          </Button>
        </div>
      </div>
    </WindowScene>
  );
}

const CRITERIA = [
  'The brand feels right',
  'Booking is easy to find',
  'Arabic and English match',
  'The phone layout works',
] as const;

/** The guest review page: one exact version, explicit criteria, approve or request changes. */
export function StakeholderReviewScene() {
  const t = useT();
  return (
    <WindowScene
      label={t('SolutionsInhouseScenes.stakeholderReviewAlt')}
      url="portal.tmanage.com/review/homepage-v2"
      className="tm-inh-window--review"
    >
      <div className="tm-inh-review">
        <div className="tm-inh-review__card">
          <p className={MONO}>What you are deciding on</p>
          <p className="tm-inh-review__version">
            <span className={cx(MONO, 'tm-inh-ink')}>v2 · 8f2c·d41a</span>
            <span className={MONO}>12 Aug 09:12</span>
          </p>
          <p className="tm-inh-small">
            Your decision is recorded against this exact version. If the file changes, the approval
            stops being valid and we ask you again.
          </p>
          <hr className="tm-inh-rule" />
          <p className={MONO}>What you are confirming</p>
          <div className="tm-inh-review__criteria">
            {CRITERIA.map((c) => (
              <Checkbox key={c} label={c} />
            ))}
          </div>
          <Button tone="lime" size="feature" className="tm-inh-full">
            Approve version 2
          </Button>
          <Button tone="outline" size="feature" className="tm-inh-full">
            Request changes
          </Button>
          <p className="tm-inh-small tm-inh-center tm-inh-balance">
            Requesting changes needs at least one specific point so the team can act on it.
          </p>
        </div>
      </div>
    </WindowScene>
  );
}

interface LoadRow {
  name: string;
  summary: string;
  /** Committed hours per commitment, against a 32-hour week. */
  hours: readonly number[];
  over?: { hours: number; note: string };
  leave?: number;
}

const WEEK = 32;

const LOAD: readonly LoadRow[] = [
  { name: 'Omar Adel', summary: '3 commitments · 26h of 32h', hours: [9, 9, 8] },
  {
    name: 'Lina Samir',
    summary: '5 commitments · 41h of 32h',
    hours: [8, 8, 8, 8],
    over: {
      hours: 9,
      note: 'Over her stated capacity by 9 hours. Two commitments have dates that could move without affecting a milestone.',
    },
  },
  { name: 'Karim Nabil', summary: '2 commitments · 14h of 32h', hours: [7, 7] },
  { name: 'Noor Fathy', summary: 'On leave Wed–Thu', hours: [11], leave: 7 },
];

/** Workload — committed hours against stated capacity, per person, with no score. */
export function WorkloadScene() {
  const t = useT();
  return (
    <WindowScene
      label={t('SolutionsInhouseScenes.workloadAlt')}
      url="app.tmanage.com/people/workload"
      className="tm-inh-window--load"
    >
      <div className="tm-inh-load">
        <p className={MONO}>Work · Workload · Week of 17 Aug</p>
        <p className="tm-section-head__title tm-inh-load__title">Commitments against capacity</p>
        <div className="tm-inh-load__card">
          {LOAD.map((row) => {
            const used = row.hours.reduce((a, b) => a + b, 0);
            const free = Math.max(WEEK - used - (row.leave ?? 0), 0);
            return (
              <div key={row.name} className="tm-inh-load__person">
                <p className="tm-inh-load__who">
                  <Avatar name={row.name} size="compact" decorative />
                  <span className="tm-web-logos__name tm-inh-load__name">{row.name}</span>
                  <span className={cx(MONO, row.over && 'tm-inh-warn')}>{row.summary}</span>
                </p>
                <div className={cx('tm-inh-bar', row.leave !== undefined && 'tm-inh-bar--leave')}>
                  {row.hours.map((h, i) => (
                    <span key={i} className="tm-inh-bar__seg" style={{ flexGrow: h }} />
                  ))}
                  {row.over ? (
                    <span
                      className="tm-inh-bar__seg tm-inh-bar__seg--over"
                      style={{ flexGrow: row.over.hours }}
                    />
                  ) : null}
                  {free > 0 ? (
                    <span
                      className="tm-inh-bar__seg tm-inh-bar__seg--free"
                      style={{ flexGrow: free }}
                    />
                  ) : null}
                  {row.leave ? (
                    <span
                      className="tm-inh-bar__seg tm-inh-bar__seg--leave"
                      style={{ flexGrow: row.leave }}
                    />
                  ) : null}
                </div>
                {row.over ? <p className="tm-inh-small tm-inh-warn">{row.over.note}</p> : null}
              </div>
            );
          })}
        </div>
      </div>
    </WindowScene>
  );
}
