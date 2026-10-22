'use client';

import type { ReactNode } from 'react';
import { Avatar, Button, Checkbox, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { cx } from '../../primitives';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';

/** Mono caption: the shared Web/Eyebrow text style, laid out as plain text inside scenes. */
const MONO = 'tm-web-eyebrow tm-inh-mono';

/** `t()` scoped to `SolutionsInhouseScenes.*`. */
function useSceneT(): (key: string) => string {
  const t = useT();
  return (key) => t(`SolutionsInhouseScenes.${key}` as MessageKey);
}

/**
 * Product scenes for Solutions · In-house teams — small clones of the real request inbox,
 * request-form builder, version review and workload screens, composed from packages/ui parts.
 * Each one is an illustration: `inert`, hidden from assistive tech, with one sentence of
 * alternative text in its caption. Every visible string is a `SolutionsInhouseScenes.*` catalog
 * key; names and version tags stay Latin.
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

/**
 * One inbox row; `key` names the `SolutionsInhouseScenes.inbox<Key>Title/From/Desired/Age` keys and
 * `label` a `state<Label>` key.
 */
interface InboxRow {
  key: string;
  state: { tone: CapsuleState; label: string };
  late?: boolean;
  declined?: boolean;
}

const INBOX: readonly InboxRow[] = [
  { key: 'Faq', state: { tone: 'current', label: 'NeedsTriage' }, late: true },
  { key: 'Dashboard', state: { tone: 'current', label: 'NeedsTriage' } },
  { key: 'Photo', state: { tone: 'waiting', label: 'Clarifying' } },
  { key: 'Newsletter', state: { tone: 'future', label: 'Deferred' } },
  { key: 'Loyalty', state: { tone: 'archived', label: 'Declined' }, declined: true },
];

/** REQ-01 request inbox — the hero visual. */
export function RequestInboxScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <WindowScene
      label={t('SolutionsInhouseScenes.requestInboxAlt')}
      url="app.tmanage.com/requests/inbox"
      className="tm-inh-window--hero"
    >
      <div className="tm-inh-inbox">
        <div className="tm-inh-inbox__row tm-inh-inbox__row--head">
          <span className={MONO}>{s('colRequest')}</span>
          <span className={MONO}>{s('colState')}</span>
          <span className={MONO}>{s('colDesired')}</span>
          <span className={cx(MONO, 'tm-inh-inbox__age')}>{s('colAge')}</span>
        </div>
        {INBOX.map((row, index) => (
          <div
            key={row.key}
            className={cx(
              'tm-inh-inbox__row',
              index === 0 && 'tm-inh-inbox__row--on',
              row.declined && 'tm-inh-inbox__row--muted',
            )}
          >
            <span className="tm-inh-inbox__request">
              <span className="tm-metric__label tm-inh-inbox__title">
                {s(`inbox${row.key}Title`)}
              </span>
              <span className={MONO}>{s(`inbox${row.key}From`)}</span>
            </span>
            <span>
              <StateCapsule state={row.state.tone}>{s(`state${row.state.label}`)}</StateCapsule>
            </span>
            <span className={cx(MONO, row.late && 'tm-inh-warn')}>
              {s(`inbox${row.key}Desired`)}
            </span>
            <span className={cx(MONO, 'tm-inh-inbox__age', row.late && 'tm-inh-warn')}>
              {s(`inbox${row.key}Age`)}
            </span>
          </div>
        ))}
        <p className={cx(MONO, 'tm-inh-inbox__foot')}>
          <span>{s('inboxCount')}</span>
          <span className="tm-inh-warn">{s('inboxLate')}</span>
        </p>
      </div>
    </WindowScene>
  );
}

/** `key` names the `SolutionsInhouseScenes.question<Key>/question<Key>Kind` keys. */
const QUESTIONS: readonly { key: string; on?: boolean }[] = [
  { key: 'Need' },
  { key: 'Why' },
  { key: 'When', on: true },
  { key: 'Attach' },
];

/** REQ request-form builder beside the requester's view of the same form. */
export function IntakeFormScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <WindowScene
      label={t('SolutionsInhouseScenes.intakeFormAlt')}
      url="app.tmanage.com/requests/forms"
    >
      <div className="tm-inh-intake">
        <div className="tm-inh-intake__builder">
          <p className="tm-inline-alert__title tm-inh-intake__heading">{s('builder')}</p>
          {QUESTIONS.map((item) => (
            <div key={item.key} className={cx('tm-inh-question', item.on && 'tm-inh-question--on')}>
              <span className="tm-inh-question__q">{s(`question${item.key}`)}</span>
              <span className={cx(MONO, item.on && 'tm-inh-warn')}>
                {s(`question${item.key}Kind`)}
              </span>
            </div>
          ))}
          <span className="tm-inh-question tm-inh-question--add">{s('addQuestion')}</span>
          <p className={cx(MONO, 'tm-inh-intake__foot')}>{s('builderFoot')}</p>
        </div>
        <div className="tm-inh-intake__view">
          <p className="tm-inh-intake__who">
            <Avatar name={s('marketingTeam')} size="compact" decorative />
            <span>{s('requesterView')}</span>
          </p>
          <p className="tm-inline-alert__title tm-inh-intake__title">{s('askTitle')}</p>
          <span className="tm-inh-input">{s('inputTitle')}</span>
          <span className="tm-inh-input tm-inh-input--area">{s('inputWhy')}</span>
          <span className="tm-inh-input tm-inh-input--date">
            <span>{s('inputDate')}</span>
            <span className="tm-inh-input__hint">{s('inputDateHint')}</span>
          </span>
          <Button tone="ink" size="default" className="tm-inh-full">
            {s('sendRequest')}
          </Button>
        </div>
      </div>
    </WindowScene>
  );
}

const CRITERIA = ['checkBrand', 'checkBooking', 'checkLanguages', 'checkPhone'] as const;

/** The guest review page: one exact version, explicit criteria, approve or request changes. */
export function StakeholderReviewScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <WindowScene
      label={t('SolutionsInhouseScenes.stakeholderReviewAlt')}
      url="portal.tmanage.com/review/homepage-v2"
      className="tm-inh-window--review"
    >
      <div className="tm-inh-review">
        <div className="tm-inh-review__card">
          <p className={MONO}>{s('decidingOn')}</p>
          <p className="tm-inh-review__version">
            <span className={cx(MONO, 'tm-inh-ink')}>v2 · 8f2c·d41a</span>
            <span className={MONO}>{s('versionDate')}</span>
          </p>
          <p className="tm-inh-small">{s('versionNote')}</p>
          <hr className="tm-inh-rule" />
          <p className={MONO}>{s('confirming')}</p>
          <div className="tm-inh-review__criteria">
            {CRITERIA.map((c) => (
              <Checkbox key={c} label={s(c)} />
            ))}
          </div>
          <Button tone="lime" size="feature" className="tm-inh-full">
            {s('approveVersion2')}
          </Button>
          <Button tone="outline" size="feature" className="tm-inh-full">
            {s('requestChanges')}
          </Button>
          <p className="tm-inh-small tm-inh-center tm-inh-balance">{s('changesNote')}</p>
        </div>
      </div>
    </WindowScene>
  );
}

/** One person's week; `key` names the `SolutionsInhouseScenes.load<Key>Summary/Note` keys. */
interface LoadRow {
  key: string;
  name: string;
  /** Committed hours per commitment, against a 32-hour week. */
  hours: readonly number[];
  over?: number;
  leave?: number;
}

const WEEK = 32;

const LOAD: readonly LoadRow[] = [
  { key: 'Omar', name: 'Omar Adel', hours: [9, 9, 8] },
  { key: 'Lina', name: 'Lina Samir', hours: [8, 8, 8, 8], over: 9 },
  { key: 'Karim', name: 'Karim Nabil', hours: [7, 7] },
  { key: 'Noor', name: 'Noor Fathy', hours: [11], leave: 7 },
];

/** Workload — committed hours against stated capacity, per person, with no score. */
export function WorkloadScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <WindowScene
      label={t('SolutionsInhouseScenes.workloadAlt')}
      url="app.tmanage.com/people/workload"
      className="tm-inh-window--load"
    >
      <div className="tm-inh-load">
        <p className={MONO}>{s('loadCrumb')}</p>
        <p className="tm-section-head__title tm-inh-load__title">{s('loadTitle')}</p>
        <div className="tm-inh-load__card">
          {LOAD.map((row) => {
            const used = row.hours.reduce((a, b) => a + b, 0);
            const free = Math.max(WEEK - used - (row.leave ?? 0), 0);
            return (
              <div key={row.name} className="tm-inh-load__person">
                <p className="tm-inh-load__who">
                  <Avatar name={row.name} size="compact" decorative />
                  <span className="tm-web-logos__name tm-inh-load__name">{row.name}</span>
                  <span className={cx(MONO, row.over !== undefined && 'tm-inh-warn')}>
                    {s(`load${row.key}Summary`)}
                  </span>
                </p>
                <div className={cx('tm-inh-bar', row.leave !== undefined && 'tm-inh-bar--leave')}>
                  {row.hours.map((h, i) => (
                    <span key={i} className="tm-inh-bar__seg" style={{ flexGrow: h }} />
                  ))}
                  {row.over ? (
                    <span
                      className="tm-inh-bar__seg tm-inh-bar__seg--over"
                      style={{ flexGrow: row.over }}
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
                {row.over ? (
                  <p className="tm-inh-small tm-inh-warn">{s(`load${row.key}Note`)}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </WindowScene>
  );
}
