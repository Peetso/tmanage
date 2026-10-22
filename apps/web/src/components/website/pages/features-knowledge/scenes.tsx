'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import { localeDirection } from '../../../../lib/i18n/direction';
import { formatDateTime, formatDay, formatNumber } from '../../../../lib/i18n/format';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { useT } from '../../../../lib/i18n/use-t';
import { IconOrb, cx } from '../../primitives';
import { WebIcon } from '../../WebIcon';

/**
 * Product scenes for /features/knowledge (shots/05-features-knowledge.png). Each one is real
 * TManage UI composed from packages/ui parts (StateCapsule, Badge, Avatar, InlineAlert, Button)
 * and the website's chip and orb classes — illustrations, so the body is `inert` and hidden from
 * assistive tech, with one sentence of alternative text in the caption.
 *
 * Every mock-up line reads from the `FeaturesKnowledgeScenes.*` keys, so the Arabic page shows
 * Arabic product UI. Names, IDs (DEC-41, DEC-29) and version tags stay Latin.
 */

type Vars = Readonly<Record<string, string | number>>;
type SceneText = (key: string, vars?: Vars) => string;

/** The scene text for `key` under `FeaturesKnowledgeScenes.`, with `{name}` placeholders filled. */
function useSceneText(): SceneText {
  const t = useT();
  return (key, vars) => {
    let text = t(`FeaturesKnowledgeScenes.${key}` as MessageKey);
    for (const [name, value] of Object.entries(vars ?? {})) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  };
}

interface SceneFormat {
  /** A count in the active locale's digits. */
  num(value: number): string;
  /**
   * A calendar day (or day and time, for an ISO instant with a time). Arabic formats `iso` with
   * the active locale; English keeps the design's own short form, `en`, so the English page is
   * unchanged.
   */
  day(iso: string, en: string, options?: Intl.DateTimeFormatOptions): string;
}

const DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

function useSceneFormat(): SceneFormat {
  const locale = useActiveLocale();
  const rtl = localeDirection(locale) === 'rtl';
  return {
    num: (value) => formatNumber(value, { locale }),
    day: (iso, en, options = DAY_MONTH) => {
      if (!rtl) return en;
      const ctx = { locale, timeZone: 'UTC' };
      return iso.includes('T')
        ? formatDateTime(`${iso}Z`, ctx, options)
        : formatDay(`${iso}T12:00:00Z`, ctx, options);
    },
  };
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
    <figure className={cx('tm-web-scene', 'tm-fk-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-scene__body tm-fk-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('tm-web-scene__mono', 'tm-fk-mono', className)}>{children}</p>;
}

/* ── Hero: the "Homepage direction" decision record ─────────────────────────── */

export function DecisionRecordScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('DecisionRecordScene.label')} className="tm-fk-scene--hero">
      <div className="tm-fk-window">
        <div className="tm-fk-window__bar">
          <span className="tm-fk-window__url" dir="ltr">
            tmanage.app / atlas / docs /<wbr /> homepage-direction
          </span>
        </div>
        <div className="tm-fk-window__body">
          <Mono>{s('hero.eyebrow')}</Mono>
          <p className="tm-fk-hero-doc__title">{s('hero.title')}</p>
          <div className="tm-fk-byline">
            <Avatar name="Maya Hassan" decorative className="tm-fk-avatar" />
            <span className="tm-fk-byline__text">{s('hero.byline', { minutes: f.num(26) })}</span>
            <StateCapsule state="done">{s('decided')}</StateCapsule>
          </div>
          <p className="tm-fk-hero-doc__text">{s('hero.text')}</p>
          <Mono>{s('hero.linked')}</Mono>
          <div className="tm-fk-links">
            <div className="tm-fk-link-row">
              <IconOrb icon="layers" tone="lime" />
              <span className="tm-fk-link-row__text">
                <span className="tm-fk-link-row__title">{s('concept')}</span>
                <span className="tm-fk-link-row__meta">{s('hero.conceptMeta')}</span>
              </span>
              <StateCapsule state="client">{s('hero.inClientReview')}</StateCapsule>
            </div>
            <div className="tm-fk-link-row">
              <IconOrb icon="flag" tone="outline" />
              <span className="tm-fk-link-row__text">
                <span className="tm-fk-link-row__title">
                  {s('hero.launchTitle', { date: f.day('2026-09-30', '30 Sep') })}
                </span>
                <span className="tm-fk-link-row__meta">
                  {s('hero.launchMeta', { n: f.num(6) })}
                </span>
              </span>
              <StateCapsule state="current">{s('hero.onTrack')}</StateCapsule>
            </div>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Docs: the Atlas project brief with live work embedded ──────────────────── */

const BRIEF_TASKS: readonly {
  key: string;
  state: 'done' | 'current' | 'client';
  stateKey: string;
  owner: string;
  client?: boolean;
  iso: string;
  en: string;
}[] = [
  {
    key: 'roomGrid',
    state: 'done',
    stateKey: 'done',
    owner: 'Lina Samir',
    iso: '2026-09-12',
    en: '12 Sep',
  },
  {
    key: 'widgetQa',
    state: 'current',
    stateKey: 'inProgress',
    owner: 'Omar Adel',
    iso: '2026-09-18',
    en: '18 Sep',
  },
  {
    key: 'copySignoff',
    state: 'client',
    stateKey: 'withClient',
    owner: 'Youssef Kamal',
    client: true,
    iso: '2026-09-22',
    en: '22 Sep',
  },
];

export function ProjectBriefScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('ProjectBriefScene.label')} className="tm-fk-scene--card">
      <div className="tm-fk-card">
        <div className="tm-fk-card__head">
          <IconOrb icon="doc" tone="outline" className="tm-fk-card__orb" />
          <span className="tm-fk-link-row__text">
            <span className="tm-fk-card__title">{s('brief.title')}</span>
            <span className="tm-fk-link-row__meta">{s('brief.meta', { minutes: f.num(2) })}</span>
          </span>
          <Badge>{s('internal')}</Badge>
        </div>
        <p className="tm-fk-card__text">{s('brief.text')}</p>
        <div className="tm-fk-embed">
          <div className="tm-fk-embed__head">
            <Mono>{s('brief.live', { tasks: f.num(3), milestones: f.num(1) })}</Mono>
            <Badge mono>{s('brief.synced')}</Badge>
          </div>
          {BRIEF_TASKS.map((task) => (
            <div key={task.key} className="tm-fk-task">
              <span className="tm-fk-task__title">{s(`task.${task.key}`)}</span>
              <span className="tm-fk-task__end">
                <StateCapsule state={task.state}>{s(`state.${task.stateKey}`)}</StateCapsule>
                <Avatar
                  name={task.owner}
                  audience={task.client ? 'client' : 'internal'}
                  decorative
                  className="tm-fk-avatar"
                />
                <span className="tm-fk-task__date">{f.day(task.iso, task.en)}</span>
              </span>
            </div>
          ))}
          <div className="tm-fk-task tm-fk-task--milestone">
            <IconOrb icon="flag" tone="lime" />
            <span className="tm-fk-link-row__text">
              <span className="tm-fk-task__title">{s('brief.launch')}</span>
              <span className="tm-fk-link-row__meta">
                {s('brief.launchMeta', { date: f.day('2026-09-30', '30 SEP') })}
              </span>
            </span>
            <StateCapsule state="future">{s('brief.upcoming')}</StateCapsule>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Decision register: DEC-41 ─────────────────────────────────────────────── */

const REJECTED_OPTIONS = ['opt1', 'opt2'] as const;

export function DecisionScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('DecisionScene.label')} className="tm-fk-scene--card">
      <div className="tm-fk-card">
        <div className="tm-fk-card__row">
          <span className="tm-fk-inline">
            <Badge mono>DEC-41</Badge>
            <StateCapsule state="done">{s('decided')}</StateCapsule>
          </span>
          <span className="tm-fk-quiet">
            {s('dec.effective', { date: f.day('2026-08-14', '14 Aug') })}
          </span>
        </div>
        <p className="tm-fk-card__title tm-fk-card__title--lg">{s('dec.title')}</p>
        <div className="tm-fk-byline">
          <Avatar name="Lina Samir" decorative className="tm-fk-avatar" />
          <span className="tm-fk-byline__text">{s('dec.byline')}</span>
        </div>
        <Mono>{s('dec.why')}</Mono>
        <p className="tm-fk-card__text tm-fk-card__text--tight">{s('dec.whyText')}</p>
        <Mono>{s('dec.rejectedTitle')}</Mono>
        <div className="tm-fk-options">
          {REJECTED_OPTIONS.map((option) => (
            <div key={option} className="tm-fk-option">
              <span className="tm-fk-link-row__text">
                <span className="tm-fk-option__title">{s(`dec.${option}`)}</span>
                <span className="tm-fk-quiet">{s(`dec.${option}Why`)}</span>
              </span>
              <StateCapsule state="archived">{s('dec.rejected')}</StateCapsule>
            </div>
          ))}
        </div>
        <div className="tm-fk-card__row">
          <Badge>{s('dec.supersedes')}</Badge>
          <span className="tm-fk-quiet">{s('dec.affects', { n: f.num(3) })}</span>
        </div>
      </div>
    </Scene>
  );
}

/* ── Governed versions: the approval invalidated by a new upload ─────────────── */

export function GovernedVersionScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('GovernedVersionScene.label')} className="tm-fk-scene--card">
      <div className="tm-fk-card tm-fk-card--governed">
        <div className="tm-fk-card__row">
          <span className="tm-fk-card__title">{s('gov.title')}</span>
          <StateCapsule state="waiting">{s('gov.waiting')}</StateCapsule>
        </div>
        <p className="tm-fk-quiet">{s('gov.meta')}</p>
        <div className="tm-fk-versions">
          <div className="tm-fk-version">
            <Badge mono className="tm-fk-version__tag">
              {s('gov.v3Tag', { date: f.day('2026-08-19', '19 Aug') })}
            </Badge>
            <span className="tm-fk-version__text">{s('gov.v3Text')}</span>
            <StateCapsule state="current" className="tm-fk-version__state">
              {s('gov.latest')}
            </StateCapsule>
          </div>
          <div className="tm-fk-version">
            <Badge mono className="tm-fk-version__tag">
              {s('gov.v2Tag', { date: f.day('2026-08-18', '18 Aug') })}
            </Badge>
            <span className="tm-fk-version__text">{s('gov.v2Text')}</span>
            <StateCapsule state="archived" className="tm-fk-version__state">
              {s('gov.superseded')}
            </StateCapsule>
          </div>
        </div>
        <InlineAlert tone="warning">{s('gov.alert')}</InlineAlert>
        <div className="tm-fk-actions">
          <Button tone="ink" size="feature" tabIndex={-1}>
            {s('gov.requestReview')}
          </Button>
          <Button tone="outline" size="feature" tabIndex={-1}>
            {s('gov.compare')}
          </Button>
        </div>
      </div>
    </Scene>
  );
}

/* ── Publication preview ────────────────────────────────────────────────────── */

export function PublicationPreviewScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  const checks = [s('pub.check1'), s('pub.check2'), s('pub.check3', { days: f.num(7) })];
  return (
    <Scene label={t('PublicationPreviewScene.label')} className="tm-fk-scene--card">
      <div className="tm-fk-card">
        <span>
          <Badge tone="client">{s('pub.badge')}</Badge>
        </span>
        <p className="tm-fk-card__title tm-fk-card__title--section">
          {s('pub.title', { n: f.num(2) })}
        </p>
        <div className="tm-fk-byline">
          <span className="tm-fk-inline tm-fk-inline--tight">
            <Avatar name="Youssef Kamal" audience="client" decorative className="tm-fk-avatar" />
            <Avatar name="Salma Riad" audience="client" decorative className="tm-fk-avatar" />
          </span>
          <span className="tm-fk-byline__text">Youssef Kamal, Salma Riad · Atlas</span>
        </div>
        <ul className="tm-fk-checks">
          {checks.map((line) => (
            <li key={line}>
              <WebIcon name="check" size={16} />
              {line}
            </li>
          ))}
        </ul>
        <div className="tm-fk-actions">
          <Button tone="outline" size="feature" tabIndex={-1}>
            {s('pub.back')}
          </Button>
          <Button tone="lime" size="feature" tabIndex={-1}>
            {s('pub.publish')}
          </Button>
        </div>
      </div>
    </Scene>
  );
}

/* ── Permission-aware search ────────────────────────────────────────────────── */

export function PermissionSearchScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  const results: readonly {
    kind: string;
    title: string;
    audience: 'client' | 'internal';
    meta: string;
  }[] = [
    {
      kind: s('kind.deliverable'),
      title: s('concept'),
      audience: 'client',
      meta: s('res1.meta'),
    },
    {
      kind: s('kind.decision'),
      title: s('res2.title'),
      audience: 'internal',
      meta: s('res2.meta', { date: f.day('2026-08-11', '11 Aug') }),
    },
    {
      kind: s('kind.doc'),
      title: s('res3.title'),
      audience: 'internal',
      meta: s('res3.meta', { date: f.day('2026-08-16', '16 Aug') }),
    },
  ];
  return (
    <Scene label={t('PermissionSearchScene.label')} className="tm-fk-scene--search">
      <div className="tm-fk-search">
        <div className="tm-fk-search__field">
          <WebIcon name="search" size={16} />
          <span className="tm-fk-search__query">{s('search.query')}</span>
          <Badge mono>⌘K</Badge>
        </div>
        {results.map((result) => (
          <div key={result.title} className="tm-fk-result">
            <span className="tm-fk-inline tm-fk-inline--wrap tm-fk-result__head">
              <Badge mono>{result.kind}</Badge>
              <span className="tm-fk-result__title">{result.title}</span>
              <Badge
                tone={result.audience === 'client' ? 'client' : 'neutral'}
                className="tm-fk-result__tag"
              >
                {result.audience === 'client' ? s('search.clientVisible') : s('search.internal')}
              </Badge>
            </span>
            <span className="tm-fk-quiet">{result.meta}</span>
          </div>
        ))}
        <InlineAlert tone="neutral" className="tm-fk-search__note">
          {s('search.note', { n: f.num(6) })}
        </InlineAlert>
      </div>
    </Scene>
  );
}

/* ── CTA band crop: the client's approval sheet ─────────────────────────────── */

const CONFIRMING = ['confirm1', 'confirm2', 'confirm3', 'confirm4'] as const;

export function ClientApprovalScene() {
  const t = useT();
  const s = useSceneText();
  const f = useSceneFormat();
  return (
    <Scene label={t('ClientApprovalScene.label')} className="tm-fk-scene--approve">
      <div className="tm-fk-approve">
        <div className="tm-fk-approve__inner">
          <Mono>{s('appr.deciding')}</Mono>
          <p className="tm-fk-approve__hash">
            <span>v2 · 8f2c·d41a</span>
            <span className="tm-fk-approve__time">
              {f.day('2026-08-13T09:12:00', '13 Aug 09:12', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
              })}
            </span>
          </p>
          <p className="tm-fk-approve__text">{s('appr.text')}</p>
          <hr className="tm-fk-approve__rule" />
          <Mono>{s('appr.confirming')}</Mono>
          <ul className="tm-fk-confirm">
            {CONFIRMING.map((key) => (
              <li key={key}>
                <span className="tm-fk-confirm__box" />
                {s(`appr.${key}`)}
              </li>
            ))}
          </ul>
          <Button tone="lime" size="feature" tabIndex={-1} className="tm-fk-approve__primary">
            {s('appr.approve', { version: f.num(2) })}
          </Button>
          <Button tone="outline" size="feature" tabIndex={-1} className="tm-fk-approve__secondary">
            {s('appr.changes')}
          </Button>
        </div>
      </div>
    </Scene>
  );
}
