'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';

/**
 * Product scenes for Solutions · Consultancies — small, real TManage screens composed from
 * packages/ui parts (StateCapsule, Badge, Avatar, Button) inside a browser-window frame. They are
 * illustrations: the body is `inert` and hidden from assistive tech, and `label` gives one
 * sentence of alternative text instead. Every visible string is a `ConsultanciesScenes.*` catalog
 * key; names, IDs and version tags stay Latin.
 */

/** `t()` scoped to `ConsultanciesScenes.*`. */
function useSceneT(): (key: string) => string {
  const t = useT();
  return (key) => t(`ConsultanciesScenes.${key}` as MessageKey);
}

function AppWindow({
  url,
  label,
  tone = 'surface',
  className,
  children,
}: {
  url: string;
  label: string;
  tone?: 'surface' | 'sunken';
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-consult-window', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-consult-window__frame" aria-hidden="true" inert>
        <div className="tm-consult-window__bar">
          <span className="tm-consult-window__dots">
            <span />
            <span />
            <span />
          </span>
          <span className="tm-consult-window__url">{url}</span>
        </div>
        <div className={cx('tm-consult-window__body', `tm-consult-window__body--${tone}`)}>
          {children}
        </div>
      </div>
    </figure>
  );
}

/* ── Hero: the decision register ──────────────────────────────────────────────── */

/** `key` names the `ConsultanciesScenes.dec<Key>Text/Date/Affects` keys. */
const DECISIONS = [
  { id: 'DEC-41', key: '41', owner: 'Lina Samir' },
  { id: 'DEC-40', key: '40', owner: 'Omar Adel' },
  { id: 'DEC-37', key: '37', owner: 'Omar Adel' },
  { id: 'DEC-33', key: '33', owner: 'Maya Hassan' },
] as const;

export function DecisionRegisterScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <AppWindow
      url="app.tmanage.com/decisions"
      label={t('ConsultanciesScenes.decisionRegisterAlt')}
      className="tm-consult-window--hero"
    >
      <div className="tm-consult-register">
        <div className="tm-consult-register__row tm-consult-register__row--head">
          <span>{s('colId')}</span>
          <span>{s('colStatement')}</span>
          <span>{s('colOwner')}</span>
          <span>{s('colEffective')}</span>
          <span>{s('colAffects')}</span>
        </div>
        {DECISIONS.map((decision, index) => (
          <div
            key={decision.id}
            className={cx(
              'tm-consult-register__row',
              index === 0 && 'tm-consult-register__row--selected',
            )}
          >
            <span className="tm-consult-mono">{decision.id}</span>
            <span className="tm-consult-register__text">
              <span className="tm-consult-clip">{s(`dec${decision.key}Text`)}</span>
            </span>
            <span className="tm-consult-register__owner">{decision.owner}</span>
            <span className="tm-consult-mono">{s(`dec${decision.key}Date`)}</span>
            <span className="tm-consult-register__affects">{s(`dec${decision.key}Affects`)}</span>
          </div>
        ))}
        <div className="tm-consult-register__row tm-consult-register__row--superseded">
          <span className="tm-consult-mono">DEC-29</span>
          <span className="tm-consult-register__text">
            <span className="tm-consult-clip">{s('dec29Text')}</span>
            <Badge mono>{s('supersededBy')}</Badge>
          </span>
          <span className="tm-consult-register__owner">Lina Samir</span>
          <span className="tm-consult-mono">{s('dec29Date')}</span>
          <span className="tm-consult-register__affects">—</span>
        </div>
        <div className="tm-consult-register__foot">
          <span className="tm-consult-mono">{s('registerCount')}</span>
          <StateCapsule state="client">{s('visibleToAtlas')}</StateCapsule>
        </div>
      </div>
    </AppWindow>
  );
}

/* ── Row 1: the engagement story (Work Story timeline) ────────────────────────── */

type StoryTone = 'done' | 'collapsed' | 'now' | 'next';

/** `key` names the `ConsultanciesScenes.story<Key>Meta/Title/Sub` keys. */
const STORY: readonly { tone: StoryTone; key: string; sub?: boolean }[] = [
  { tone: 'done', key: 'Scoped' },
  { tone: 'done', key: 'Discovery', sub: true },
  { tone: 'collapsed', key: 'Collapsed' },
  { tone: 'done', key: 'Published', sub: true },
  { tone: 'now', key: 'Now' },
  { tone: 'next', key: 'Next' },
];

export function EngagementStoryScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <AppWindow
      url="app.tmanage.com/engagements/story"
      label={t('ConsultanciesScenes.engagementStoryAlt')}
    >
      <ol className="tm-consult-story">
        {STORY.map((step) => (
          <li key={step.key} className={cx('tm-consult-story__step', `is-${step.tone}`)}>
            <span className="tm-consult-story__dot" />
            <span className="tm-consult-mono">{s(`story${step.key}Meta`)}</span>
            <span className="tm-consult-story__title">{s(`story${step.key}Title`)}</span>
            {step.sub ? (
              <span className="tm-consult-story__sub">{s(`story${step.key}Sub`)}</span>
            ) : null}
          </li>
        ))}
      </ol>
    </AppWindow>
  );
}

/* ── Row 2: one decision with its evidence and audit trail ────────────────────── */

export function DecisionDetailScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <AppWindow
      url="app.tmanage.com/decisions/detail"
      tone="sunken"
      label={t('ConsultanciesScenes.decisionDetailAlt')}
    >
      <div className="tm-consult-detail">
        <div className="tm-consult-detail__main">
          <p className="tm-consult-detail__crumbs">
            <span className="tm-consult-mono">{s('detailCrumb')}</span>
            <StateCapsule state="done">{s('detailActive')}</StateCapsule>
            <Badge tone="client">{s('detailClientVisible')}</Badge>
          </p>
          <p className="tm-consult-detail__title">{s('detailTitle')}</p>
          <div className="tm-consult-detail__card">
            <dl className="tm-consult-detail__facts">
              <div>
                <dt>{s('colOwner')}</dt>
                <dd>Omar Adel</dd>
              </div>
              <div>
                <dt>{s('colEffective')}</dt>
                <dd>{s('detailEffective')}</dd>
              </div>
              <div>
                <dt>{s('colAffects')}</dt>
                <dd>{s('detailAffects')}</dd>
              </div>
              <div>
                <dt>{s('detailSourceLabel')}</dt>
                <dd>{s('detailSource')}</dd>
              </div>
            </dl>
            <p className="tm-consult-mono">{s('detailRationaleLabel')}</p>
            <p className="tm-consult-detail__text">{s('detailRationale')}</p>
            <p className="tm-consult-mono">{s('detailEvidenceLabel')}</p>
            <div className="tm-consult-detail__evidence">
              <span>{s('evidenceUsability')}</span>
              <span>{s('evidenceUsabilityNote')}</span>
            </div>
            <div className="tm-consult-detail__evidence">
              <span>{s('evidenceFunnel')}</span>
              <span>{s('evidenceFunnelNote')}</span>
            </div>
          </div>
        </div>
        <div className="tm-consult-detail__side">
          <div className="tm-consult-detail__related">
            <p className="tm-consult-mono">{s('relatedLabel')}</p>
            <span>
              <WebIcon name="doc" size={14} />
              {s('relatedConcept')}
            </span>
            <span>
              <WebIcon name="work" size={14} />
              {s('relatedFlow')}
            </span>
            <span>
              <WebIcon name="flag" size={14} />
              {s('relatedFindings')}
            </span>
          </div>
          <div className="tm-consult-detail__audit">
            <p className="tm-consult-mono">{s('auditLabel')}</p>
            <span className="is-lime">
              <b>{s('audit1When')}</b>
              {s('audit1What')}
            </span>
            <span>
              <b>{s('audit2When')}</b>
              {s('audit2What')}
            </span>
            <span>
              <b>{s('audit3When')}</b>
              {s('audit3What')}
            </span>
          </div>
        </div>
      </div>
    </AppWindow>
  );
}

/* ── Row 3: the steering-committee health view ─────────────────────────────────── */

/** `key` names the `ConsultanciesScenes.health<Key>Name` keys; `label` a `state<Label>` key. */
const HEALTH = [
  {
    key: 'Atlas',
    client: 'Atlas Hospitality',
    done: 2,
    current: 1,
    left: 2,
    state: { tone: 'waiting', label: 'AtRisk' },
  },
  {
    key: 'Pricing',
    client: 'Northstar Studio',
    done: 1,
    current: 1,
    left: 3,
    state: { tone: 'current', label: 'OnTrack' },
  },
  {
    key: 'Operating',
    client: 'Atlas Hospitality',
    done: 3,
    current: 1,
    left: 1,
    state: { tone: 'done', label: 'Ahead' },
  },
] as const;

export function SteeringHealthScene() {
  const t = useT();
  const s = useSceneT();
  return (
    <AppWindow
      url="app.tmanage.com/insights/health"
      tone="sunken"
      label={t('ConsultanciesScenes.steeringHealthAlt')}
    >
      <div className="tm-consult-health">
        <div className="tm-consult-health__head">
          <p className="tm-consult-health__title">{s('healthTitle')}</p>
          <span className="tm-web-chip">{s('chipClients')}</span>
          <span className="tm-web-chip tm-web-chip--on">{s('chipThisWeek')}</span>
        </div>
        <div className="tm-consult-health__metrics">
          <div>
            <b>2</b>
            <span>{s('metricAtRisk')}</span>
          </div>
          <div>
            <b>6</b>
            <span>{s('metricWaiting')}</span>
          </div>
          <div>
            <b>9</b>
            <span>{s('metricCommitted')}</span>
          </div>
        </div>
        <div className="tm-consult-health__grid">
          <div className="tm-consult-health__table">
            {HEALTH.map((row) => (
              <div key={row.key} className="tm-consult-health__row">
                <span className="tm-consult-health__name">
                  <span className="tm-consult-clip">{s(`health${row.key}Name`)}</span>
                  <small className="tm-consult-clip">{row.client}</small>
                </span>
                <span className="tm-consult-health__bar">
                  {Array.from({ length: row.done }, (_, i) => (
                    <i key={`d${i}`} className="is-done" />
                  ))}
                  {Array.from({ length: row.current }, (_, i) => (
                    <i key={`c${i}`} className="is-current" />
                  ))}
                  {Array.from({ length: row.left }, (_, i) => (
                    <i key={`l${i}`} />
                  ))}
                </span>
                <StateCapsule state={row.state.tone}>{s(`state${row.state.label}`)}</StateCapsule>
              </div>
            ))}
          </div>
          <div className="tm-consult-health__draft">
            <p className="tm-consult-mono">{s('draftLabel')}</p>
            <p className="tm-consult-health__draft-title">{s('draftTitle')}</p>
            <div className="tm-consult-health__draft-by">
              <Avatar name="Omar Adel" size="compact" decorative />
              <span>Omar Adel</span>
            </div>
            <Button tone="ink" size="feature">
              {s('sendToPortal')}
            </Button>
          </div>
        </div>
      </div>
    </AppWindow>
  );
}
