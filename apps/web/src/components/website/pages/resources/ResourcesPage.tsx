'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import Link from '../../WebLink';
import { Badge, Button, Field, SearchField } from '@tmanage/ui';
import { ArrowLink, ButtonLink, IconOrb, cx } from '../../primitives';
import { CtaBand, WebSection } from '../../sections';
import {
  ARTICLES,
  CATEGORY_BADGE_KEY,
  FEATURED_GUIDE,
  FEATURED_SIDE,
  RESOURCE_TABS,
  filterResources,
  resourceHref,
  type Resource,
  type ResourceTab,
} from './resources-data';
import './resources.css';
import { useT } from '../../../../lib/i18n/use-t';

/**
 * WEB-15 Resources (`/resources`), built to the round-2 Figma frame 308:40: a centred hero with
 * search, the featured row (ink guide + two stacked cards), underline category tabs, the 3 × 3
 * article grid with thumbnails, the newsletter panel and the CTA band. Every card opens its
 * article at `/resources/[slug]`.
 */

/** The nav and footer link to `/resources#guides`, `#blog` and `#templates`: each opens its tab. */
const HASH_TABS: Readonly<Record<string, ResourceTab['id']>> = {
  guides: 'guide',
  blog: 'blog',
  templates: 'template',
};

export function ResourcesPage() {
  const t = useT();
  const [tab, setTab] = useState<ResourceTab['id']>('all');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    function fromHash() {
      const next = HASH_TABS[window.location.hash.slice(1)];
      if (next) setTab(next);
    }
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  // ⌘K / Ctrl+K focuses the library search, as the shortcut hint in the field says.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        const input = searchRef.current?.querySelector('input');
        if (!input) return;
        event.preventDefault();
        input.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const visible = useMemo(
    () =>
      filterResources(ARTICLES, tab, query, (item) => [
        t(item.titleKey),
        t(item.lineKey),
        t(CATEGORY_BADGE_KEY[item.category]),
      ]),
    [tab, query, t],
  );

  return (
    <>
      <WebSection className="tm-web-res-hero" aria-labelledby="res-hero-title">
        <div className="tm-web-res-hero__inner">
          <p className="tm-web-res-label">{t('ResourcesPage.eyebrow')}</p>
          <h1 id="res-hero-title" className="tm-web-res-hero__title">
            {t('ResourcesPage.heroTitle')}
          </h1>
          <p className="tm-web-res-hero__lede">{t('ResourcesPage.heroLede')}</p>
          <form
            ref={searchRef}
            className="tm-web-res-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              document.getElementById('res-library')?.scrollIntoView({ block: 'start' });
            }}
          >
            <SearchField
              label={t('ResourcesPage.searchLabel')}
              placeholder={t('ResourcesPage.searchLabel')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-controls="res-grid"
              aria-keyshortcuts="Meta+K Control+K"
            />
            <kbd className="tm-web-res-search__kbd" aria-hidden="true">
              ⌘K
            </kbd>
          </form>
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-web-res-featured" aria-labelledby="res-feat-title">
        <h2 id="res-feat-title" className="tm-web-res-label">
          {t('ResourcesPage.featured')}
        </h2>
        <div className="tm-web-res-featured__grid">
          <FeaturedGuide />
          <div className="tm-web-res-featured__side">
            {FEATURED_SIDE.map((item) => (
              <SideCard key={item.slug} item={item} />
            ))}
          </div>
        </div>
      </WebSection>

      <WebSection className="tm-web-res-library" aria-labelledby="res-lib-title" id="res-library">
        <h2 id="res-lib-title" className="tm-visually-hidden">
          {t('ResourcesPage.allArticles')}
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
          <p className="tm-visually-hidden" aria-live="polite">
            {visible.length} {t('ResourcesPage.countOf')} {ARTICLES.length}{' '}
            {t('ResourcesPage.countArticles')}
          </p>
          {visible.length > 0 ? (
            <ul className="tm-web-res-grid tm-web-res-grid--library" id="res-grid">
              {visible.map((item) => (
                <li key={item.slug}>
                  <ArticleCard item={item} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="tm-web-res-empty" id="res-grid">
              <IconOrb icon="search" tone="tint" />
              <p className="tm-web-res-empty__title">{t('ResourcesPage.emptyTitle')}</p>
              <p className="tm-web-res-empty__body">{t('ResourcesPage.emptyBody')}</p>
              <ArrowLink href="/contact">{t('ResourcesPage.suggestTopic')}</ArrowLink>
            </div>
          )}
        </div>
      </WebSection>

      <Newsletter />

      <CtaBand />
    </>
  );
}

/* ── Category tabs (Tabs/Item: text tabs on one hairline, the active one underlined) ──── */

function LibraryTabs({
  active,
  onChange,
}: {
  active: ResourceTab['id'];
  onChange: (id: ResourceTab['id']) => void;
}) {
  const t = useT();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = RESOURCE_TABS.findIndex((tab) => tab.id === active);

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
    <div className="tm-web-res-tabs" role="tablist" aria-label={t('ResourcesPage.tabsLabel')}>
      {RESOURCE_TABS.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`res-tab-${tab.id}`}
          type="button"
          role="tab"
          className="tm-web-res-tab"
          aria-selected={tab.id === active}
          aria-controls="res-panel"
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => select(i)}
          onKeyDown={onKeyDown}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  );
}

/* ── Cards ──────────────────────────────────────────────────────────────────── */

function CategoryBadge({ item }: { item: Resource }) {
  const t = useT();
  return (
    <Badge
      tone={item.category === 'update' ? 'client' : 'neutral'}
      mono={item.category === 'template'}
      className="tm-web-res-badge"
    >
      {t(CATEGORY_BADGE_KEY[item.category])}
    </Badge>
  );
}

/** The large ink card: the client approval playbook. */
function FeaturedGuide() {
  const t = useT();
  const href = resourceHref(FEATURED_GUIDE);
  return (
    <article className="tm-web-res-guide" aria-labelledby="res-guide-title">
      <IconOrb icon={FEATURED_GUIDE.icon} tone="lime" />
      <Badge className="tm-web-res-badge">{t(CATEGORY_BADGE_KEY[FEATURED_GUIDE.category])}</Badge>
      <h3 id="res-guide-title" className="tm-web-res-guide__title">
        <Link href={href} className="tm-web-res-guide__link">
          {t(FEATURED_GUIDE.titleKey)}
        </Link>
      </h3>
      <p className="tm-web-res-guide__line">{t(FEATURED_GUIDE.lineKey)}</p>
      <div className="tm-web-res-guide__meta-row">
        <ButtonLink href={href} tone="lime">
          {t('ResourcesPage.readGuide')}
        </ButtonLink>
        <span className="tm-web-res-guide__time">{t(FEATURED_GUIDE.metaKey)}</span>
      </div>
    </article>
  );
}

/** A stacked featured card: badge and orb on top, title, summary, then its meta line. */
function SideCard({ item }: { item: Resource }) {
  const t = useT();
  return (
    <article className="tm-web-res-side">
      <div className="tm-web-res-side__top">
        <CategoryBadge item={item} />
        <IconOrb icon={item.icon} tone="outline" />
      </div>
      <h3 className="tm-web-res-side__title">
        <Link href={resourceHref(item)} className="tm-web-res-stretch">
          {t(item.titleKey)}
        </Link>
      </h3>
      <p className="tm-web-res-side__line">{t(item.lineKey)}</p>
      {item.category === 'template' ? <p className="tm-web-res-time">{t(item.metaKey)}</p> : null}
    </article>
  );
}

/** A library card: sunken thumbnail with its orb, then badge, title, summary and read time. */
function ArticleCard({ item }: { item: Resource }) {
  const t = useT();
  return (
    <article className="tm-web-res-article-card">
      <div className="tm-web-res-article-card__thumb" aria-hidden="true">
        <IconOrb icon={item.icon} tone={item.orb} />
      </div>
      <div className="tm-web-res-article-card__body">
        <CategoryBadge item={item} />
        <h3 className="tm-web-res-article-card__title">
          <Link href={resourceHref(item)} className="tm-web-res-stretch">
            {t(item.titleKey)}
          </Link>
        </h3>
        <p className="tm-web-res-article-card__line">{t(item.lineKey)}</p>
        <p className="tm-web-res-time">{t(item.metaKey)}</p>
      </div>
    </article>
  );
}

/* ── Newsletter panel ───────────────────────────────────────────────────────── */

function Newsletter() {
  const t = useT();
  const [state, setState] = useState<'idle' | 'noted'>('idle');
  const statusId = useId();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('noted');
  }

  return (
    <WebSection
      spacing="flush"
      className="tm-web-res-news"
      aria-labelledby="res-news-title"
      id="res-newsletter"
    >
      <div className="tm-web-res-news__panel">
        <div className="tm-web-res-news__copy">
          <IconOrb icon="book" tone="ink" />
          <p className="tm-web-res-label">{t('ResourcesPage.newsletterEyebrow')}</p>
          <h2 id="res-news-title" className="tm-web-res-news__title">
            {t('ResourcesPage.newsletterTitle')}
          </h2>
        </div>
        <form className="tm-web-res-news__form" onSubmit={onSubmit} aria-describedby={statusId}>
          <div className="tm-web-res-news__row">
            <Field
              label={t('ResourcesPage.workEmail')}
              type="email"
              name="email"
              autoComplete="email"
              placeholder={t('ResourcesPage.emailPlaceholder')}
              required
            />
            <Button type="submit" tone="lime" size="accessible">
              {t('ResourcesPage.subscribe')}
            </Button>
          </div>
          <p
            id={statusId}
            className={cx('tm-web-res-news__caption', state === 'noted' && 'is-noted')}
            aria-live="polite"
          >
            {state === 'noted'
              ? t('ResourcesPage.newsletterNoted')
              : t('ResourcesPage.newsletterIdle')}
          </p>
        </form>
      </div>
    </WebSection>
  );
}
