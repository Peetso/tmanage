'use client';

import type { ReactNode } from 'react';
import { Avatar, Button, StateCapsule } from '@tmanage/ui';
import { WebIcon } from './WebIcon';
import { cx } from './primitives';

/**
 * Web/Product visual — mini product scenes composed from packages/ui components (StateCapsule,
 * Avatar, Button) and the app's own field/chip classes, never screenshots or grey boxes. They are
 * illustrations: the whole scene is `inert` and hidden from assistive tech, and `label` gives it
 * one sentence of alternative text instead.
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
    <figure className={cx('tm-web-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

/** WK-02 "Delivery risk" saved view, cropped — the shared product-visual block (§07, §08). */
export function DeliveryRiskScene({
  label = 'The Delivery risk saved view: 214 items, a current milestone, one deliverable in client review and one blocked task.',
}: {
  label?: string;
}) {
  return (
    <Scene label={label} className="tm-web-scene--risk">
      <div className="tm-web-risk">
        <p className="tm-web-scene__mono">Work · Saved view</p>
        <p className="tm-web-risk__title">Delivery risk</p>
        <p className="tm-web-risk__meta">214 items · 3 blocked · 2 client waiting</p>
        <div className="tm-web-risk__filters">
          <span className="tm-web-risk__search">
            <WebIcon name="search" size={14} />
            Search work items
          </span>
          <span className="tm-web-chip tm-web-chip--on">Open</span>
          <span className="tm-web-chip">Owner · anyone</span>
          <span className="tm-web-chip">Density · Operational</span>
          <span className="tm-web-chip tm-web-chip--more">···</span>
        </div>
        <div className="tm-web-risk__bulk">
          <span>3 selected</span>
          <span>Set owner</span>
          <span>Commit date</span>
          <span>Move to milestone</span>
          <span>Publish to client</span>
        </div>
        <div className="tm-web-risk__table">
          <div className="tm-web-risk__row tm-web-risk__row--head">
            <span>Work item</span>
            <span>State</span>
          </div>
          <div className="tm-web-risk__row tm-web-risk__row--group">
            <span className="tm-web-scene__mono">Milestone · Homepage direction</span>
            <StateCapsule state="current">CURRENT · 4 DAYS</StateCapsule>
            <span className="tm-web-risk__count">6 items</span>
          </div>
          <div className="tm-web-risk__row tm-web-risk__row--live">
            <span className="tm-web-risk__item">DEL · Homepage Concept v2</span>
            <StateCapsule state="client">Client review</StateCapsule>
          </div>
          <div className="tm-web-risk__row tm-web-risk__row--live">
            <span className="tm-web-risk__item">TSK · Prepare mobile booking flow concepts</span>
            <StateCapsule state="blocked">Blocked</StateCapsule>
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
export function ObjectCard({
  title,
  meta,
  state = { tone: 'current', label: 'In progress' },
  owner,
  primary = 'Approve',
  secondary = 'Open',
}: ObjectCardProps) {
  return (
    <div className="tm-web-object">
      <div className="tm-web-object__head">
        <p className="tm-web-object__title">{title}</p>
        <StateCapsule state={state.tone}>{state.label}</StateCapsule>
      </div>
      <p className="tm-web-object__meta">{meta}</p>
      <div className="tm-web-object__foot">
        <Avatar name={owner} size="compact" decorative className="tm-web-object__avatar" />
        <span className="tm-web-object__actions">
          <Button tone="outline" size="feature">
            {secondary}
          </Button>
          <Button tone="ink" size="feature">
            {primary}
          </Button>
        </span>
      </div>
    </div>
  );
}

const DEFAULT_OBJECTS: readonly ObjectCardProps[] = [
  {
    title: 'Spring launch — brand refresh',
    meta: 'Northstar Studio · 14 work items · due 30 Sep',
    owner: 'Maya Hassan',
  },
  {
    title: 'Homepage Concept — version 2',
    meta: 'Atlas Hospitality · waiting on client approval',
    owner: 'Omar Adel',
  },
];

/** Two Card/Object compositions stacked on the sunken backdrop (§07, right). */
export function ObjectCardStack({
  cards = DEFAULT_OBJECTS,
  label = 'Two work objects in progress, each with an owner and Open and Approve actions.',
}: {
  cards?: readonly ObjectCardProps[];
  label?: string;
}) {
  return (
    <Scene label={label} className="tm-web-scene--stack">
      <div className="tm-web-object-stack">
        {cards.map((card) => (
          <ObjectCard key={card.title} {...card} />
        ))}
      </div>
    </Scene>
  );
}
