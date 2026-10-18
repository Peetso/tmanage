'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Avatar, Badge, Button, SearchField, StateCapsule, StatusDot } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { ArrowLink, IconOrb, cx } from '../../primitives';
import { ObjectCardStack } from '../../ProductScenes';
import { CalloutPin, CtaBand, ProductVisualFrame, SectionHeader, WebSection } from '../../sections';
import {
  CATEGORY_LABEL,
  CONNECTION_STEPS,
  INTEGRATIONS,
  INTEGRATION_FILTERS,
  SEARCH_HINTS,
  type Integration,
  type IntegrationFilter,
} from './integrations-data';
import './integrations.css';

/**
 * WEB-13 Integrations (`/integrations`). No Figma frame yet: designed in code from SITE-SPEC in
 * the visual language of the designed pages (Customers for hero + filter + grid, Security for
 * the ink band). Every value is a Limeframe token; product visuals are packages/ui compositions.
 */
export function IntegrationsPage() {
  const [filter, setFilter] = useState<IntegrationFilter['id']>('all');
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return INTEGRATIONS.filter(
      (item) =>
        (filter === 'all' || item.category === filter) &&
        (q === '' ||
          item.name.toLowerCase().includes(q) ||
          item.line.toLowerCase().includes(q) ||
          CATEGORY_LABEL[item.category].toLowerCase().includes(q)),
    );
  }, [filter, query]);
  const typed = query.trim();

  return (
    <>
      <WebSection className="tm-web-int-hero" aria-labelledby="int-hero-title">
        <div className="tm-web-int-hero__grid">
          <div className="tm-web-int-hero__text">
            <SectionHeader
              as="h1"
              size="page"
              id="int-hero-title"
              eyebrow="INTEGRATIONS"
              title="Connect the tools you keep. Retire the ones you don't need."
              lede="Calendars, storage, sign-in and developer tools — each connection shows exactly what it can read and do."
            />
            <form
              className="tm-web-int-search"
              role="search"
              onSubmit={(event) => event.preventDefault()}
            >
              <SearchField
                label="Search integrations"
                placeholder="Search integrations"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-controls="int-grid"
                aria-describedby="int-search-hint"
              />
              <p className="tm-web-int-search__hint" id="int-search-hint" aria-live="polite">
                {typed === '' ? (
                  <>
                    <span>Try</span>
                    {SEARCH_HINTS.map((hint) => (
                      <button
                        key={hint}
                        type="button"
                        className="tm-web-chip tm-web-int-chip"
                        onClick={() => setQuery(hint)}
                      >
                        {hint}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <span>
                      {visible.length === 1 ? '1 match' : `${visible.length} matches`} for “{typed}”
                    </span>
                    <button
                      type="button"
                      className="tm-web-chip tm-web-int-chip"
                      onClick={() => setQuery('')}
                    >
                      Clear
                    </button>
                  </>
                )}
              </p>
            </form>
          </div>
          <ConnectionPreviewScene />
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-web-int-catalogue" aria-labelledby="int-grid-title">
        <h2 id="int-grid-title" className="tm-visually-hidden">
          All integrations
        </h2>
        <div className="tm-web-int-filters">
          <div className="tm-web-int-filters__chips" role="group" aria-label="Filter by category">
            {INTEGRATION_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cx(
                  'tm-web-chip',
                  'tm-web-int-chip',
                  filter === item.id && 'tm-web-chip--on',
                )}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="tm-web-int-filters__meta">
            <span className="tm-web-int-filters__count" aria-live="polite">
              {visible.length === INTEGRATIONS.length
                ? `${INTEGRATIONS.length} integrations`
                : `${visible.length} of ${INTEGRATIONS.length} integrations`}
            </span>
            <ArrowLink href="/contact" underline={false}>
              Suggest an integration
            </ArrowLink>
          </p>
        </div>

        {visible.length > 0 ? (
          <ul className="tm-web-int-grid" id="int-grid">
            {visible.map((item) => (
              <li key={item.name}>
                <IntegrationCard item={item} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="tm-web-int-empty" id="int-grid">
            <IconOrb icon="search" tone="tint" />
            <p className="tm-web-int-empty__title">No integration matches “{query.trim()}”.</p>
            <p className="tm-web-int-empty__body">
              Try another word, or tell us what you would connect — the list follows real requests.
            </p>
            <ArrowLink href="/contact">Suggest an integration</ArrowLink>
          </div>
        )}
      </WebSection>

      <WebSection className="tm-web-int-how-section" aria-labelledby="int-how-title">
        <div className="tm-web-int-how">
          <div className="tm-web-int-how__head">
            <SectionHeader
              tone="ink"
              id="int-how-title"
              eyebrow="HOW CONNECTIONS WORK"
              title="Nothing connects without showing its work."
              lede="Each connection is reviewed before it starts, acts as someone you chose, and leaves a record you can read."
            />
            <ArrowLink href="/security" tone="ink" underline={false}>
              How we handle your data
            </ArrowLink>
          </div>
          <ol className="tm-web-int-steps">
            {CONNECTION_STEPS.map((step, index) => (
              <li key={step.title} className="tm-web-int-step">
                <CalloutPin n={index + 1} />
                <h3 className="tm-web-int-step__title">{step.title}</h3>
                <p className="tm-web-int-step__body">{step.body}</p>
                {index < CONNECTION_STEPS.length - 1 ? (
                  <span className="tm-web-int-step__arrow" aria-hidden="true">
                    <WebIcon name="arrow-right" size={16} />
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-web-int-build" aria-labelledby="int-build-title">
        <div className="tm-web-feature tm-web-int-build__row">
          <div className="tm-web-feature__text">
            <SectionHeader
              id="int-build-title"
              eyebrow="BUILD YOUR OWN"
              title="Webhooks and an API for your own workflows."
              lede="Send events to the systems you already run, and act on requests and work items from your own scripts — with the same permissions a person would have."
              link={{ label: 'Read the developer guide', href: '/resources' }}
            />
          </div>
          <ProductVisualFrame>
            <WebhookLogScene />
          </ProductVisualFrame>
        </div>
      </WebSection>

      <CtaBand
        visual={
          <div className="tm-web-int-cta-visual">
            <ObjectCardStack />
          </div>
        }
      />
    </>
  );
}

function IntegrationCard({ item }: { item: Integration }) {
  return (
    <article className="tm-web-int-card">
      <div className="tm-web-int-card__head">
        <IconOrb icon={item.icon} tone="tint" />
        <StateCapsule state={item.status === 'available' ? 'done' : 'future'}>
          {item.status === 'available' ? 'Available' : 'Planned'}
        </StateCapsule>
      </div>
      <h3 className="tm-web-int-card__name">{item.name}</h3>
      <p className="tm-web-int-card__line">{item.line}</p>
    </article>
  );
}

/* ── Product scenes (illustrations; inert and hidden, with one sentence of alt text) ── */

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

const PREVIEW_ROWS: readonly { verb: 'Read' | 'Do'; text: string }[] = [
  { verb: 'Read', text: 'Busy and free times on your work calendar' },
  { verb: 'Do', text: 'Add milestone dates as all-day events' },
  { verb: 'Do', text: 'Create meetings from a request, with owners' },
];

/** Connection preview — the permission sheet a person sees before connecting Google Calendar. */
function ConnectionPreviewScene() {
  return (
    <Scene
      className="tm-web-int-preview-scene"
      label="A connection preview for Google Calendar: what it can read, what it can do, the person it acts as, and Cancel and Connect actions."
    >
      <div className="tm-web-int-preview">
        <div className="tm-web-int-preview__head">
          <IconOrb icon="calendar" tone="tint" />
          <div>
            <p className="tm-web-scene__mono">Connection preview</p>
            <p className="tm-web-int-preview__title">Google Calendar</p>
          </div>
          <StateCapsule state="waiting">Review</StateCapsule>
        </div>
        <ul className="tm-web-int-preview__rows">
          {PREVIEW_ROWS.map((row) => (
            <li key={row.text} className="tm-web-int-preview__row">
              <Badge mono>{row.verb === 'Read' ? 'CAN READ' : 'CAN DO'}</Badge>
              <span>{row.text}</span>
            </li>
          ))}
          <li className="tm-web-int-preview__row tm-web-int-preview__row--never">
            <Badge mono>NEVER</Badge>
            <span>See client portal content or private chats</span>
          </li>
        </ul>
        <div className="tm-web-int-preview__as">
          <span className="tm-web-scene__mono">Acts as</span>
          <span className="tm-web-int-preview__person">
            <Avatar name="Maya Hassan" size="compact" decorative />
            Maya Hassan · Owner
          </span>
        </div>
        <div className="tm-web-int-preview__foot">
          <StatusDot tone="live">Every run is kept in history</StatusDot>
          <span className="tm-web-int-preview__actions">
            <Button tone="outline" size="feature">
              Cancel
            </Button>
            <Button tone="ink" size="feature">
              Connect
            </Button>
          </span>
        </div>
      </div>
    </Scene>
  );
}

const WEBHOOK_EVENTS: readonly {
  time: string;
  event: string;
  target: string;
  state: 'done' | 'waiting' | 'blocked';
  label: string;
}[] = [
  {
    time: '09:42',
    event: 'request.created',
    target: 'Atlas Website Relaunch',
    state: 'done',
    label: 'Delivered',
  },
  {
    time: '10:15',
    event: 'approval.decided',
    target: 'Homepage Concept v2',
    state: 'done',
    label: 'Delivered',
  },
  {
    time: '11:03',
    event: 'milestone.moved',
    target: 'Homepage direction',
    state: 'waiting',
    label: 'Retry 2 of 5',
  },
  {
    time: '11:20',
    event: 'item.assigned',
    target: 'Lina Samir',
    state: 'done',
    label: 'Delivered',
  },
];

/** Webhook delivery history — the developer row's product visual. */
function WebhookLogScene() {
  return (
    <Scene
      className="tm-web-int-log-scene"
      label="A webhook delivery history: four events sent to an endpoint, three delivered and one retrying."
    >
      <div className="tm-web-int-log">
        <p className="tm-web-scene__mono">Webhook · Delivery history</p>
        <p className="tm-web-int-log__title">studio.example/hooks</p>
        <div className="tm-web-int-log__rows">
          {WEBHOOK_EVENTS.map((row) => (
            <div key={row.time} className="tm-web-int-log__row">
              <span className="tm-web-int-log__time">{row.time}</span>
              <span className="tm-web-int-log__event">
                <span className="tm-web-int-log__name">{row.event}</span>
                <span className="tm-web-int-log__target">{row.target}</span>
              </span>
              <StateCapsule state={row.state}>{row.label}</StateCapsule>
            </div>
          ))}
        </div>
      </div>
    </Scene>
  );
}
