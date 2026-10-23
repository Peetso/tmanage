'use client';

import type { ReactNode } from 'react';
import { Avatar, Button, StateCapsule } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { WebIcon } from './WebIcon';
import { cx } from './primitives';

/**
 * Web/Product visual — mini product scenes composed from packages/ui components (StateCapsule,
 * Avatar, Button) and the app's own field/chip classes, never screenshots or grey boxes. They are
 * illustrations: the whole scene is `inert` and hidden from assistive tech, and `label` gives it
 * one sentence of alternative text instead. Every default word reads from the `ProductScenes.*`
 * catalog keys (live-check L3) so the scenes mirror in Arabic; callers may still pass their own.
 */

/** `ProductScenes.<key>` bound to the active locale. */
function useProductSceneT(): (key: string) => string {
  const t = useT();
  return (key) => t(`ProductScenes.${key}` as MessageKey);
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
    <figure className={cx('tm-web-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

/**
 * WK-02 "Delivery risk" saved view, cropped — the shared product-visual block (§07, §08).
 * `deliverable` overrides the deliverable row, for a page that keeps object titles in Latin.
 */
export function DeliveryRiskScene({
  label,
  deliverable,
}: {
  label?: string;
  deliverable?: string;
}) {
  const s = useProductSceneT();
  return (
    <Scene label={label ?? s('riskLabel')} className="tm-web-scene--risk">
      <div className="tm-web-risk">
        <p className="tm-web-scene__mono">{s('riskEyebrow')}</p>
        <p className="tm-web-risk__title">{s('riskTitle')}</p>
        <p className="tm-web-risk__meta">{s('riskMeta')}</p>
        <div className="tm-web-risk__filters">
          <span className="tm-web-risk__search">
            <WebIcon name="search" size={14} />
            {s('riskSearch')}
          </span>
          <span className="tm-web-chip tm-web-chip--on">{s('riskOpen')}</span>
          <span className="tm-web-chip">{s('riskOwnerAnyone')}</span>
          <span className="tm-web-chip">{s('riskDensity')}</span>
          <span className="tm-web-chip tm-web-chip--more">···</span>
        </div>
        <div className="tm-web-risk__bulk">
          <span>{s('riskSelected')}</span>
          <span>{s('riskSetOwner')}</span>
          <span>{s('riskCommitDate')}</span>
          <span>{s('riskMoveMilestone')}</span>
          <span>{s('riskPublish')}</span>
        </div>
        <div className="tm-web-risk__table">
          <div className="tm-web-risk__row tm-web-risk__row--head">
            <span>{s('riskColItem')}</span>
            <span>{s('riskColState')}</span>
          </div>
          <div className="tm-web-risk__row tm-web-risk__row--group">
            <span className="tm-web-scene__mono">{s('riskMilestone')}</span>
            <StateCapsule state="current">{s('riskCurrent')}</StateCapsule>
            <span className="tm-web-risk__count">{s('riskSixItems')}</span>
          </div>
          <div className="tm-web-risk__row tm-web-risk__row--live">
            <span className="tm-web-risk__item">{deliverable ?? s('riskDeliverable')}</span>
            <StateCapsule state="client">{s('riskClientReview')}</StateCapsule>
          </div>
          <div className="tm-web-risk__row tm-web-risk__row--live">
            <span className="tm-web-risk__item">{s('riskTask')}</span>
            <StateCapsule state="blocked">{s('riskBlocked')}</StateCapsule>
          </div>
        </div>
      </div>
    </Scene>
  );
}

export interface ObjectCardProps {
  title: string;
  meta: string;
  state?: { tone: 'current' | 'done' | 'client' | 'waiting' | 'blocked'; label: string };
  owner: string;
  primary?: string;
  secondary?: string;
}

/** Card/Object — one work object with its state capsule, owner and two actions. */
export function ObjectCard({ title, meta, state, owner, primary, secondary }: ObjectCardProps) {
  const s = useProductSceneT();
  const shownState: NonNullable<ObjectCardProps['state']> = state ?? {
    tone: 'current',
    label: s('objectInProgress'),
  };
  return (
    <div className="tm-web-object">
      <div className="tm-web-object__head">
        <p className="tm-web-object__title">{title}</p>
        <StateCapsule state={shownState.tone}>{shownState.label}</StateCapsule>
      </div>
      <p className="tm-web-object__meta">{meta}</p>
      <div className="tm-web-object__foot">
        <Avatar name={owner} size="compact" decorative className="tm-web-object__avatar" />
        <span className="tm-web-object__actions">
          <Button tone="outline" size="feature">
            {secondary ?? s('objectOpen')}
          </Button>
          <Button tone="ink" size="feature">
            {primary ?? s('objectApprove')}
          </Button>
        </span>
      </div>
    </div>
  );
}

/** The default pair, as `ProductScenes.object<n>Title` / `Meta` / `Owner` keys. */
const DEFAULT_OBJECTS = [1, 2] as const;

/** Two Card/Object compositions stacked on the sunken backdrop (§07, right). */
export function ObjectCardStack({
  cards,
  label,
}: {
  cards?: readonly ObjectCardProps[];
  label?: string;
}) {
  const s = useProductSceneT();
  const shown =
    cards ??
    DEFAULT_OBJECTS.map((n) => ({
      title: s(`object${n}Title`),
      meta: s(`object${n}Meta`),
      owner: s(`object${n}Owner`),
    }));
  return (
    <Scene label={label ?? s('stackLabel')} className="tm-web-scene--stack">
      <div className="tm-web-object-stack">
        {shown.map((card) => (
          <ObjectCard key={card.title} {...card} />
        ))}
      </div>
    </Scene>
  );
}
