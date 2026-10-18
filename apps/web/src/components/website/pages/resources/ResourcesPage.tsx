'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { Avatar, Badge, Button, Field, SearchField, StateCapsule, StatusDot } from '@tmanage/ui';
import { ArrowLink, ButtonLink, IconOrb, cx } from '../../primitives';
import { CtaBand, SectionHeader, WebSection } from '../../sections';
import { ResourceCard } from './ResourceCard';
import {
  ARTICLES,
  CATEGORY_LABEL,
  FEATURED_GUIDE,
  FEATURED_SIDE,
  RESOURCE_TABS,
  resourceHref,
  type ResourceTab,
} from './resources-data';
import './resources.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/**
 * WEB-15 Resources (`/resources`). No Figma frame yet: designed in code from SITE-SPEC in the
 * visual language of the designed pages (Customers for hero + featured ink panel + grid,
 * Pricing/Customers for the paper/150 band). Every value is a Limeframe token; product visuals
 * are packages/ui compositions. Every card opens its article at `/resources/[slug]`.
 */
/** The nav and footer link to `/resources#guides`, `#blog` and `#templates`: each opens its tab. */
const HASH_TABS: Readonly<Record<string, ResourceTab['id']>> = {
  guides: 'guide',
  blog: 'blog',
  templates: 'template',
};

export function ResourcesPage() {
  const [tab, setTab] = useState<ResourceTab['id']>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    function fromHash() {
      const next = HASH_TABS[window.location.hash.slice(1)];
      if (next) setTab(next);
    }
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ARTICLES.filter(
      (item) =>
        (tab === 'all' || item.category === tab) &&
        (q === '' ||
          item.title.toLowerCase().includes(q) ||
          item.line.toLowerCase().includes(q) ||
          CATEGORY_LABEL[item.category].toLowerCase().includes(q)),
    );
  }, [tab, query]);

  return (
    <>
      <WebSection className="tm-web-res-hero" aria-labelledby="res-hero-title">
        <div className="tm-web-res-hero__grid">
          <div className="tm-web-res-hero__text">
            <SectionHeader
              as="h1"
              size="page"
              id="res-hero-title"
              eyebrow="RESOURCES"
              title="Guides for calmer client delivery."
              lede="Practical playbooks, templates and product notes from the TManage team."
            />
            <form
              className="tm-web-res-search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                document.getElementById('res-library')?.scrollIntoView({ block: 'start' });
              }}
            >
              <SearchField
                label="Search guides and articles"
                placeholder="Search guides and articles"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-controls="res-grid"
              />
            </form>
          </div>
          <LibraryScene />
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-web-res-featured" aria-labelledby="res-feat-title">
        <h2 id="res-feat-title" className="tm-visually-hidden">
          Featured
        </h2>
        <div className="tm-web-res-featured__grid">
          <FeaturedGuide />
          <div className="tm-web-res-featured__side">
            {FEATURED_SIDE.map((item) => (
              <ResourceCard key={item.slug} item={item} variant="side" />
            ))}
          </div>
        </div>
      </WebSection>

      <WebSection className="tm-web-res-library" aria-labelledby="res-lib-title" id="res-library">
        <h2 id="res-lib-title" className="tm-visually-hidden">
          All articles
        </h2>
        {Object.keys(HASH_TABS).map((anchor) => (
          <span key={anchor} id={anchor} aria-hidden="true" />
        ))}
        <LibraryTabs active={tab} onChange={setTab} />
        <div
          role="tabpanel"
          id="res-panel"
          aria-labelledby={`res-tab-${tab}`}
          className="tm-web-res-panel"
        >
          <p className="tm-web-res-count" aria-live="polite">
            {visible.length} of {ARTICLES.length} articles
            {query.trim() !== '' ? ` matching “${query.trim()}”` : ''}
          </p>
          {visible.length > 0 ? (
            <ul className="tm-web-res-grid" id="res-grid">
              {visible.map((item) => (
                <li key={item.slug}>
                  <ResourceCard item={item} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="tm-web-res-empty" id="res-grid">
              <IconOrb icon="search" tone="tint" />
              <p className="tm-web-res-empty__title">Nothing here matches yet.</p>
              <p className="tm-web-res-empty__body">
                Try another word or another tab — or tell us what you would like us to write next.
              </p>
              <ArrowLink href="/contact">Suggest a topic</ArrowLink>
            </div>
          )}
        </div>
      </WebSection>

      <Newsletter />

      <CtaBand
        title="Bring the next client project into one story."
        lede="Start free with your team. Invite your client when the first deliverable is ready."
        primary={{ label: 'Start free', href: SIGN_UP_HREF }}
        secondary={{ label: 'Book a demo', href: '/contact' }}
        note="No credit card · Client users are always free"
        visual={<TemplateProjectScene />}
      />
    </>
  );
}

/* ── Category tabs (Tabs/Item on the product's segmented control) ───────────── */

function LibraryTabs({
  active,
  onChange,
}: {
  active: ResourceTab['id'];
  onChange: (id: ResourceTab['id']) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState({ start: false, end: false });
  const index = RESOURCE_TABS.findIndex((t) => t.id === active);

  /** Which edges still hide tabs — drives the fade that says "this row scrolls". */
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // scrollLeft runs negative under dir="rtl"; the distance from the start edge is its magnitude.
    const fromStart = Math.abs(el.scrollLeft);
    setMore({ start: fromStart > 1, end: max - fromStart > 1 });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  function select(next: number) {
    const target = RESOURCE_TABS[next];
    if (!target) return;
    onChange(target.id);
    refs.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const rtl = document.documentElement.dir === 'rtl';
    const step: Record<string, number> = {
      ArrowRight: rtl ? -1 : 1,
      ArrowLeft: rtl ? 1 : -1,
    };
    let next = index;
    if (event.key in step)
      next = (index + (step[event.key] ?? 0) + RESOURCE_TABS.length) % RESOURCE_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = RESOURCE_TABS.length - 1;
    else return;
    event.preventDefault();
    select(next);
    refs.current[next]?.focus();
  }

  return (
    <div
      ref={scroller}
      className="tm-web-res-tabs"
      data-more-start={more.start || undefined}
      data-more-end={more.end || undefined}
      onScroll={measure}
    >
      <div
        className="tm-segmented tm-web-res-tabs__list"
        role="tablist"
        aria-label="Resource categories"
      >
        {RESOURCE_TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`res-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            aria-controls="res-panel"
            tabIndex={t.id === active ? 0 : -1}
            onClick={() => select(i)}
            onKeyDown={onKeyDown}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Featured guide (ink panel) ─────────────────────────────────────────────── */

function FeaturedGuide() {
  const href = resourceHref(FEATURED_GUIDE);
  return (
    <article className="tm-web-res-guide" aria-labelledby="res-guide-title">
      <div className="tm-web-res-guide__text">
        <Badge mono className="tm-web-res-guide__badge">
          FEATURED GUIDE
        </Badge>
        <h3 id="res-guide-title" className="tm-web-res-guide__title">
          <Link href={href} className="tm-web-res-guide__link">
            {FEATURED_GUIDE.title}
          </Link>
        </h3>
        <p className="tm-web-res-guide__line">{FEATURED_GUIDE.line}</p>
        <ul className="tm-web-res-guide__points">
          {FEATURED_GUIDE.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <p className="tm-web-res-guide__meta">
          <span>{FEATURED_GUIDE.meta}</span>
          <span aria-hidden="true"> · </span>
          <span>Written by the TManage team</span>
        </p>
        <div className="tm-web-res-guide__actions">
          <ButtonLink href={href} tone="lime" size="accessible">
            Read the guide
          </ButtonLink>
          <ArrowLink href="#res-newsletter" tone="ink">
            Get new guides by email
          </ArrowLink>
        </div>
      </div>
      <ApprovalScene />
    </article>
  );
}

/* ── Newsletter band ────────────────────────────────────────────────────────── */

function Newsletter() {
  const [state, setState] = useState<'idle' | 'noted'>('idle');
  const statusId = useId();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('noted');
  }

  return (
    <WebSection
      tone="sunken"
      spacing="compact"
      className="tm-web-res-news"
      aria-labelledby="res-news-title"
      id="res-newsletter"
    >
      <div className="tm-web-res-news__grid">
        <SectionHeader id="res-news-title" title="One useful email a month." />
        <form className="tm-web-res-news__form" onSubmit={onSubmit} aria-describedby={statusId}>
          <div className="tm-web-res-news__row">
            <Field
              label="Work email"
              type="email"
              name="email"
              autoComplete="email"
              placeholder="you@studio.com"
              required
            />
            <Button type="submit" tone="ink" size="accessible">
              Subscribe
            </Button>
          </div>
          <p id={statusId} className="tm-web-res-news__caption" aria-live="polite">
            {state === 'noted'
              ? 'Sign-up opens with the first issue. Nothing was sent or stored.'
              : 'Unsubscribe in one click.'}
          </p>
        </form>
      </div>
    </WebSection>
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

const SEARCH_RESULTS: readonly {
  title: string;
  kind: string;
  meta: string;
  icon: 'book' | 'pencil' | 'layers';
}[] = [
  {
    title: 'How to run a client review in ten minutes',
    kind: 'GUIDE',
    meta: '7 min read',
    icon: 'book',
  },
  {
    title: 'Designing a portal clients actually open',
    kind: 'BLOG',
    meta: '8 min read',
    icon: 'pencil',
  },
  {
    title: 'Website relaunch template',
    kind: 'TEMPLATE',
    meta: '8 milestones',
    icon: 'layers',
  },
];

/** Hero — the library searched from inside TManage: a query, three results, who keeps it current. */
function LibraryScene() {
  return (
    <Scene
      className="tm-web-res-library-scene"
      label="The TManage resource library searched for “client review”: three results — a guide, a blog post and a template."
    >
      <div className="tm-web-res-doc">
        <div className="tm-web-res-doc__head">
          <IconOrb icon="book" tone="tint" />
          <div className="tm-web-res-doc__heading">
            <p className="tm-web-scene__mono">Resources · Library</p>
            <p className="tm-web-res-doc__title">Search the library</p>
          </div>
          <Badge mono>12</Badge>
        </div>
        <SearchField label="Search the library" value="client review" readOnly tabIndex={-1} />
        <p className="tm-web-scene__mono">3 results</p>
        <ul className="tm-web-res-doc__steps">
          {SEARCH_RESULTS.map((result, i) => (
            <li
              key={result.title}
              className={cx('tm-web-res-doc__step', i === 0 && 'tm-web-res-doc__step--on')}
            >
              <IconOrb icon={result.icon} tone={i === 0 ? 'lime' : 'tint'} size="compact" />
              <span className="tm-web-res-doc__text">
                <span className="tm-web-res-doc__name">{result.title}</span>
                <span className="tm-web-res-doc__sub">{result.meta}</span>
              </span>
              <Badge mono>{result.kind}</Badge>
            </li>
          ))}
        </ul>
        <div className="tm-web-res-doc__foot">
          <span className="tm-web-res-doc__people">
            <Avatar name="Maya Hassan" size="compact" decorative />
            <Avatar name="Omar Adel" size="compact" decorative />
            <span>Kept current by the TManage team</span>
          </span>
          <StatusDot tone="live">Updated monthly</StatusDot>
        </div>
      </div>
    </Scene>
  );
}

/** Featured guide — the approval the playbook teaches: one decision on one exact version. */
function ApprovalScene() {
  return (
    <Scene
      className="tm-web-res-approval-scene"
      label="An approval request in TManage: Homepage Concept v2 for Atlas Hospitality, version 1 with changes requested and version 2 approved by Salma Riad."
    >
      <div className="tm-web-res-approval">
        <div className="tm-web-res-approval__head">
          <div>
            <p className="tm-web-scene__mono">Approval · Atlas</p>
            <p className="tm-web-res-approval__title">Homepage Concept v2</p>
          </div>
          <StateCapsule state="client">Client</StateCapsule>
        </div>
        <div className="tm-web-res-approval__rows">
          <div className="tm-web-res-approval__row">
            <Badge mono>V1</Badge>
            <span className="tm-web-res-approval__who">
              <span>Youssef</span> <span>· 12 Aug</span>
            </span>
            <StateCapsule state="blocked">Changes</StateCapsule>
          </div>
          <div className="tm-web-res-approval__row tm-web-res-approval__row--on">
            <Badge mono>V2</Badge>
            <span className="tm-web-res-approval__who">
              <span>Salma</span> <span>· 18 Aug</span>
            </span>
            <StateCapsule state="done">Approved</StateCapsule>
          </div>
        </div>
        <p className="tm-web-res-approval__quote">
          <Avatar name="Salma Riad" size="compact" decorative />
          <span>“Approved — go ahead with this direction.”</span>
        </p>
      </div>
    </Scene>
  );
}

const TEMPLATE_MILESTONES: readonly {
  text: string;
  state: 'done' | 'current' | 'future';
  label: string;
}[] = [
  { text: 'Brief and discovery', state: 'done', label: 'Done' },
  { text: 'Homepage concept', state: 'current', label: 'Now' },
  { text: 'Client approval', state: 'future', label: 'Next' },
];

/** CTA — the relaunch template copied into a real project, every line wrapping instead of cropping. */
function TemplateProjectScene() {
  return (
    <Scene
      className="tm-web-res-template-scene"
      label="The Website relaunch template copied into the Atlas Website Relaunch project: three milestones, one done and one in progress."
    >
      <div className="tm-web-res-doc">
        <div className="tm-web-res-doc__head">
          <IconOrb icon="layers" tone="lime" />
          <div className="tm-web-res-doc__heading">
            <p className="tm-web-scene__mono">From template</p>
            <p className="tm-web-res-doc__title">Atlas Website Relaunch</p>
          </div>
        </div>
        <ol className="tm-web-res-doc__steps">
          {TEMPLATE_MILESTONES.map((step, i) => (
            <li key={step.text} className="tm-web-res-doc__step">
              <span className="tm-web-res-doc__n">{i + 1}</span>
              <span className="tm-web-res-doc__text">{step.text}</span>
              <StateCapsule state={step.state}>{step.label}</StateCapsule>
            </li>
          ))}
        </ol>
        <p className="tm-web-res-doc__foot">
          <span>8 milestones · 46 work items</span>
        </p>
      </div>
    </Scene>
  );
}
