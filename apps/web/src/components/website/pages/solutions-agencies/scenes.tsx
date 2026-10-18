'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, StatusDot, type CapsuleState } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Mini product scenes for Solutions · Agencies & studios (WEB-08). Each one is composed from
 * packages/ui parts (StateCapsule, Badge, StatusDot, Avatar, Button) on the website's tokens —
 * illustrations, so the body is `inert` and hidden from assistive tech; `label` is the alt text.
 */
function AgScene({
  label,
  address,
  className,
  children,
}: {
  label: string;
  address?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-web-ag-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-ag-scene__body" aria-hidden="true" inert>
        {address ? (
          <div className="tm-web-ag-scene__bar">
            <span className="tm-web-ag-scene__dots">
              <span />
              <span />
              <span />
            </span>
            <span className="tm-web-ag-scene__address">{address}</span>
          </div>
        ) : null}
        {children}
      </div>
    </figure>
  );
}

interface PortfolioRow {
  client: string;
  project: string;
  state: CapsuleState;
  stateLabel: string;
  due: string;
  owner: string;
}

const PORTFOLIO: readonly PortfolioRow[] = [
  {
    client: 'Atlas Hospitality',
    project: 'Atlas Website Relaunch',
    state: 'client',
    stateLabel: 'Client review',
    due: '30 Sep',
    owner: 'Maya Hassan',
  },
  {
    client: 'Cedar Clinics',
    project: 'Brand identity sprint',
    state: 'current',
    stateLabel: 'In progress',
    due: '08 Oct',
    owner: 'Omar Adel',
  },
  {
    client: 'Harbor Foods',
    project: 'Autumn campaign production',
    state: 'waiting',
    stateLabel: 'Waiting',
    due: '14 Oct',
    owner: 'Lina Samir',
  },
  {
    client: 'Lumen Travel',
    project: 'Monthly retainer · October',
    state: 'current',
    stateLabel: 'In progress',
    due: '31 Oct',
    owner: 'Karim Nabil',
  },
  {
    client: 'Atlas Hospitality',
    project: 'Booking flow concepts',
    state: 'blocked',
    stateLabel: 'Blocked',
    due: '21 Oct',
    owner: 'Noor Fathy',
  },
];

/** Hero — the studio portfolio: every client project, its state, due date and owner. */
export function PortfolioScene() {
  return (
    <AgScene
      label="The Northstar Studio portfolio: five client projects across four clients, one in client review and one blocked."
      address="app.tmanage.com/northstar/portfolio"
      className="tm-web-ag-scene--portfolio"
    >
      <div className="tm-web-ag-portfolio">
        <div className="tm-web-ag-portfolio__head">
          <div>
            <p className="tm-web-scene__mono">Northstar Studio · Portfolio</p>
            <p className="tm-web-ag-portfolio__title">All client projects</p>
          </div>
          <span className="tm-web-ag-portfolio__chips">
            <span className="tm-web-chip tm-web-chip--on">Active · 5</span>
            <span className="tm-web-chip">Client · any</span>
          </span>
        </div>
        <div className="tm-web-ag-table">
          <div className="tm-web-ag-table__row tm-web-ag-table__row--head">
            <span className="tm-web-scene__mono">Client · project</span>
            <span className="tm-web-scene__mono">State</span>
            <span className="tm-web-scene__mono">Due</span>
            <span className="tm-web-scene__mono">Owner</span>
          </div>
          {PORTFOLIO.map((row) => (
            <div key={row.project} className="tm-web-ag-table__row">
              <span className="tm-web-ag-table__project">
                <span className="tm-web-ag-table__client">{row.client}</span>
                <span className="tm-web-ag-table__name">{row.project}</span>
                <span className="tm-web-ag-table__meta">
                  <Avatar name={row.owner} size="compact" decorative className="tm-web-ag-avatar" />
                  Due {row.due}
                </span>
              </span>
              <span>
                <StateCapsule state={row.state}>{row.stateLabel}</StateCapsule>
              </span>
              <span className="tm-web-scene__mono tm-web-ag-table__due">{row.due}</span>
              <span>
                <Avatar name={row.owner} size="compact" decorative className="tm-web-ag-avatar" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </AgScene>
  );
}

/** Row 1 — one workspace, one boundary per client organization. */
export function ClientBoundariesScene() {
  const clients = [
    { name: 'Atlas Hospitality', projects: '2 projects', people: 'Salma Riad, Youssef Kamal' },
    { name: 'Cedar Clinics', projects: '1 project', people: '3 client members' },
    { name: 'Harbor Foods', projects: '1 project', people: '2 client members' },
  ];
  return (
    <AgScene
      label="Three client organizations, each with its own portal that shows only its own projects."
      address="app.tmanage.com/northstar/clients"
    >
      <div className="tm-web-ag-panel">
        <p className="tm-web-scene__mono">Clients · 3 organizations</p>
        <ul className="tm-web-ag-clients">
          {clients.map((client, index) => (
            <li
              key={client.name}
              className={cx('tm-web-ag-client', index === 0 && 'tm-web-ag-client--open')}
            >
              <span className="tm-web-ag-client__tile">
                <WebIcon name="building" size={16} />
              </span>
              <span className="tm-web-ag-client__text">
                <span className="tm-web-ag-client__name">{client.name}</span>
                <span className="tm-web-ag-client__meta">
                  {client.projects} · {client.people}
                </span>
              </span>
              <Badge tone="client" className="tm-web-ag-client__badge">
                Own portal
              </Badge>
            </li>
          ))}
        </ul>
        <div className="tm-web-ag-boundary">
          <WebIcon name="lock" size={14} />
          <span>Atlas Hospitality sees Atlas projects only. Other clients do not exist there.</span>
        </div>
      </div>
    </AgScene>
  );
}

/** Row 2 — creative review bound to one version, with criteria and a decision trail. */
export function CreativeReviewScene() {
  return (
    <AgScene
      label="Homepage Concept v2 in client review: three criteria, the earlier version superseded and Salma Riad's approval recorded on v2."
      address="app.tmanage.com/northstar/deliverables/homepage-concept"
    >
      <div className="tm-web-ag-panel">
        <div className="tm-web-ag-review__head">
          <div>
            <p className="tm-web-scene__mono">DEL · Atlas relaunch</p>
            <p className="tm-web-ag-review__title">Homepage Concept v2</p>
          </div>
          <StateCapsule state="client">Client review</StateCapsule>
        </div>
        <div className="tm-web-ag-versions">
          <span className="tm-web-chip">v1 · replaced</span>
          <span className="tm-web-chip tm-web-chip--on">v2 · in review</span>
        </div>
        <ul className="tm-web-ag-criteria">
          <li>
            <WebIcon name="check" size={14} />
            Booking call to action stays above the fold
          </li>
          <li>
            <WebIcon name="check" size={14} />
            Uses the approved Atlas type scale
          </li>
          <li>
            <WebIcon name="check" size={14} />
            Room photos lead every page
          </li>
        </ul>
        <div className="tm-web-ag-trail">
          <p className="tm-web-ag-trail__item">
            <StatusDot tone="neutral">v1 · changes requested by Youssef Kamal</StatusDot>
          </p>
          <p className="tm-web-ag-trail__item">
            <StatusDot tone="client">v2 · sent to Salma Riad for approval</StatusDot>
          </p>
        </div>
        <div className="tm-web-ag-review__actions">
          <Button tone="outline" size="feature">
            Request changes
          </Button>
          <Button tone="ink" size="feature">
            Approve v2
          </Button>
        </div>
      </div>
    </AgScene>
  );
}

/** Row 3 — a retainer's recurring requests flowing into the monthly plan. */
export function RetainerPlanScene() {
  const requests: readonly { title: string; state: CapsuleState; label: string }[] = [
    { title: 'Weekly social set · week 41', state: 'done', label: 'Done' },
    { title: 'Newsletter layout · October', state: 'current', label: 'In progress' },
    { title: 'Landing page for the autumn offer', state: 'waiting', label: 'Desired 20 Oct' },
    { title: 'Weekly social set · week 42', state: 'future', label: 'Planned' },
  ];
  return (
    <AgScene
      label="The Lumen Travel October retainer plan: four recurring requests, eleven of sixteen agreed days committed."
      address="app.tmanage.com/northstar/retainers/lumen-october"
    >
      <div className="tm-web-ag-panel">
        <div className="tm-web-ag-review__head">
          <div>
            <p className="tm-web-scene__mono">Retainer · Lumen Travel</p>
            <p className="tm-web-ag-review__title">October plan</p>
          </div>
          <StateCapsule state="current">This month</StateCapsule>
        </div>
        <div className="tm-web-ag-meter">
          <div className="tm-web-ag-meter__label">
            <span>Agreed days committed</span>
            <span className="tm-web-scene__mono">11 / 16</span>
          </div>
          <div className="tm-web-ag-meter__track">
            <span className="tm-web-ag-meter__fill" />
          </div>
        </div>
        <ul className="tm-web-ag-requests">
          {requests.map((request) => (
            <li key={request.title} className="tm-web-ag-request">
              <span className="tm-web-ag-request__title">{request.title}</span>
              <StateCapsule state={request.state}>{request.label}</StateCapsule>
            </li>
          ))}
        </ul>
      </div>
    </AgScene>
  );
}
