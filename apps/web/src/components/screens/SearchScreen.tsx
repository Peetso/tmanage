'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import { search } from '../../lib/api/search';
import { listProjects } from '../../lib/api/projects';
import type { SearchAudience, SearchResultKind, SearchTimeWindow } from '../../lib/api/search';
import { getResolvedFeatureFlags } from '../../lib/api/admin-feature-flags';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/search-ai.css';

export interface SearchScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a query — how a link (`?q=`) opens straight onto its results. */
  initialQuery?: string;
  client?: ApiClient;
}

/** The TYPE facet capsules (SR-02), in the order the design lists them. */
const KIND_ORDER: readonly SearchResultKind[] = [
  'work_item',
  'document',
  'meeting',
  'message',
  'decision',
  'project',
];

/** The AUDIENCE facet rows (SR-02), each with the glyph the design pairs it with. */
const AUDIENCE_ORDER: readonly SearchAudience[] = [
  'internal',
  'client_visible',
  'client_action_required',
];

/** The TIME facet capsules (SR-02). */
const TIME_ORDER: readonly SearchTimeWindow[] = ['7d', '30d', 'all'];

/**
 * **SRCH-01 Global search (x111), ranked by SRCH ranking (x148)** — drawn as SR-02 Universal
 * search: the lime-ringed search capsule across the top, the TYPE facet column on the start side
 * and the ranked result cards beside it.
 *
 * ## What it draws, and what it cannot
 *
 * - **Every hit is one the caller may read.** The API relation-gates each row with `work.read`
 *   before it is returned, so the screen renders what it is given without a second permission
 *   check — a search never surfaces an item the item's own screen would deny. The "Hidden from
 *   you" note states that rule; it does not invent a count the API does not return.
 * - **Order is the server's ranking** — relevance, then recency — so the list is rendered in the
 *   exact order the API returns. The TYPE facet only hides kinds; it never re-sorts.
 * - **Only work items link to a detail page**, because only work items have one today.
 * - **Body/snippet matching is not here yet** — `snippet` is null until snippet extraction lands;
 *   the card draws the excerpt line only when there is one.
 * - **AUDIENCE and TIME facets are server filters.** Changing one re-runs the search with
 *   `audience=` / `since=`, so the page is filled from the narrowed set rather than thinned on the
 *   client. They only narrow: the server still relation-gates every hit. With every audience ticked
 *   no `audience` is sent; with none ticked nothing is fetched (an empty audience set is no search).
 *   The TIME facet opens on "30 days", as SR-02 draws it; "All time" sends no `since`.
 *
 * A query must be entered and submitted before anything is fetched: an empty search is not a
 * search, and the API rejects one.
 */
export function SearchScreen({
  organizationSlug,
  organizationName,
  initialQuery,
  client,
}: SearchScreenProps) {
  const describeError = useDescribeApiError();
  const t = useT();
  const api = client ?? browserApiClient();

  /** The singular label each hit carries so its kind stays legible in one flat, ranked list. */
  const KIND_LABEL: Readonly<Record<SearchResultKind, string>> = {
    work_item: t('SearchScreen.kindWorkItem'),
    document: t('SearchScreen.kindDocument'),
    meeting: t('SearchScreen.kindMeeting'),
    message: t('SearchScreen.kindMessage'),
    decision: t('SearchScreen.kindDecision'),
    project: t('SearchScreen.kindProject'),
  };
  const KIND_FACET: Readonly<Record<SearchResultKind, string>> = {
    work_item: t('SearchScreen.facetWork'),
    document: t('SearchScreen.facetDocs'),
    meeting: t('SearchScreen.facetMeetings'),
    message: t('SearchScreen.facetMessages'),
    decision: t('SearchScreen.facetDecisions'),
    project: t('SearchScreen.facetProjects'),
  };
  const AUDIENCE_FACET: Readonly<Record<SearchAudience, string>> = {
    internal: t('SearchScreen.audienceInternal'),
    client_visible: t('SearchScreen.audienceClientVisible'),
    client_action_required: t('SearchScreen.audienceClientAction'),
  };
  const AUDIENCE_PILL: Readonly<Record<SearchAudience, string>> = {
    internal: t('SearchScreen.pillInternal'),
    client_visible: t('SearchScreen.pillClientVisible'),
    client_action_required: t('SearchScreen.pillClientAction'),
  };
  const TIME_FACET: Readonly<Record<SearchTimeWindow, string>> = {
    '7d': t('SearchScreen.time7d'),
    '30d': t('SearchScreen.time30d'),
    all: t('SearchScreen.timeAll'),
  };

  const [draft, setDraft] = useState<string>(initialQuery ?? '');
  const [query, setQuery] = useState<string>(initialQuery?.trim() ?? '');
  const [kind, setKind] = useState<'all' | SearchResultKind>('all');
  const [audiences, setAudiences] = useState<readonly SearchAudience[]>(AUDIENCE_ORDER);
  // SR-02 opens on the "30 days" capsule, so the first search is already narrowed to the last 30 days.
  const [since, setSince] = useState<SearchTimeWindow>('30d');

  const selectedAudiences = AUDIENCE_ORDER.filter((value) => audiences.includes(value));
  const audienceFilter =
    selectedAudiences.length === AUDIENCE_ORDER.length ? undefined : selectedAudiences;
  const noAudience = selectedAudiences.length === 0;

  const results = useQuery({
    queryKey: ['search', organizationSlug, query, audienceFilter ?? 'any', since],
    queryFn: () =>
      search(api, organizationSlug, {
        q: query,
        ...(audienceFilter === undefined ? {} : { audiences: audienceFilter }),
        since,
      }),
    enabled: query !== '' && !noAudience,
  });

  function toggleAudience(value: SearchAudience) {
    setAudiences((current) =>
      current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
    );
    setKind('all');
  }

  // The copilot is an optional module: its "Ask" affordance appears only when the `copilot` feature
  // flag is resolved on for this org. While the flag read is pending or fails, the affordance stays
  // hidden — no dead button — and the copilot route's own 404 (flag off) is the belt to this braces.
  const flags = useQuery({
    queryKey: ['resolved-feature-flags', organizationSlug],
    queryFn: () => getResolvedFeatureFlags(api, organizationSlug),
  });
  const copilotEnabled = flags.data?.flags.copilot === true;

  // A hit carries its project's id; the card names the project, never a raw id fragment
  // (2026-10-31 live test: "Project 01A1·93DB"). The list is the caller's own readable projects
  // and shares the sidebar's cache key, so this is usually a cache hit.
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
    enabled: query !== '',
  });
  const projectNames = new Map((projects.data ?? []).map((project) => [project.id, project.name]));

  const hits = results.data ?? [];
  const total = hits.length;
  const askQuery = (query !== '' ? query : draft).trim();
  const shown = kind === 'all' ? hits : hits.filter((hit) => hit.kind === kind);
  const org = encodeURIComponent(organizationSlug);
  const settled = query !== '' && !noAudience && !results.isPending && !results.isError;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(draft.trim());
    setKind('all');
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('SearchScreen.title')}
    >
      <div className="tm-sa-search tm-sa-headerless">
        <form className="tm-sa-searchbar" onSubmit={onSubmit} role="search">
          <span className="tm-sa-searchbar__glyph" aria-hidden="true">
            ⌕
          </span>
          <label className="tm-visually-hidden" htmlFor="tm-search-q">
            {t('SearchScreen.searchLabel')}
          </label>
          <input
            id="tm-search-q"
            className="tm-sa-searchbar__input"
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('SearchScreen.searchPlaceholder')}
          />
          <div className="tm-sa-searchbar__actions">
            {settled ? (
              <span className="tm-sa-searchbar__count" aria-live="polite">
                {total}{' '}
                {total === 1 ? t('SearchScreen.resultSingular') : t('SearchScreen.resultPlural')}
              </span>
            ) : null}
            {copilotEnabled ? (
              <Link
                href={
                  askQuery === ''
                    ? `/${org}/copilot`
                    : `/${org}/copilot?q=${encodeURIComponent(askQuery)}`
                }
                className="tm-sa-capsule"
              >
                {t('SearchScreen.askCopilot')}
              </Link>
            ) : null}
            {query !== '' ? (
              <Link
                href={`/${org}/search/saved?q=${encodeURIComponent(query)}`}
                className="tm-sa-capsule"
              >
                {t('SearchScreen.saveThisSearch')}
              </Link>
            ) : null}
            <button
              type="submit"
              className="tm-sa-capsule tm-sa-capsule--ink"
              disabled={draft.trim() === ''}
            >
              {t('SearchScreen.searchButton')}
            </button>
          </div>
        </form>

        <div className="tm-sa-search__body">
          <div className="tm-sa-facets">
            <div className="tm-sa-facet" role="group" aria-labelledby="tm-search-type">
              <p id="tm-search-type" className="tm-sa-eyebrow">
                {t('SearchScreen.facetTypeHeading')}
              </p>
              <div className="tm-chip-row">
                <button
                  type="button"
                  className="tm-chip"
                  aria-pressed={kind === 'all'}
                  onClick={() => setKind('all')}
                >
                  {t('SearchScreen.allFacet')} {total}
                </button>
                {KIND_ORDER.map((value) => {
                  const count = hits.filter((hit) => hit.kind === value).length;
                  return (
                    <button
                      key={value}
                      type="button"
                      className="tm-chip"
                      aria-pressed={kind === value}
                      onClick={() => setKind(value)}
                      disabled={count === 0}
                    >
                      {KIND_FACET[value]} {count}
                    </button>
                  );
                })}
              </div>
            </div>
            <fieldset className="tm-sa-facet">
              <legend className="tm-sa-eyebrow tm-sa-facet__legend">
                {t('SearchScreen.facetAudienceLegend')}
              </legend>
              {AUDIENCE_ORDER.map((value) => (
                <label key={value} className="tm-sa-check">
                  <input
                    type="checkbox"
                    className="tm-sa-check__input"
                    checked={audiences.includes(value)}
                    onChange={() => toggleAudience(value)}
                  />
                  <span className="tm-sa-check__box" aria-hidden="true">
                    ✓
                  </span>
                  {AUDIENCE_FACET[value]}
                </label>
              ))}
            </fieldset>
            <div className="tm-sa-facet" role="group" aria-labelledby="tm-search-time">
              <p id="tm-search-time" className="tm-sa-eyebrow">
                {t('SearchScreen.facetTimeHeading')}
              </p>
              <div className="tm-chip-row">
                {TIME_ORDER.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="tm-chip tm-sa-time"
                    aria-pressed={since === value}
                    onClick={() => {
                      setSince(value);
                      setKind('all');
                    }}
                  >
                    {TIME_FACET[value]}
                  </button>
                ))}
              </div>
            </div>
            <div className="tm-sa-note">
              <p className="tm-sa-eyebrow">{t('SearchScreen.hiddenEyebrow')}</p>
              <p className="tm-sa-note__body">{t('SearchScreen.hiddenBody')}</p>
            </div>
          </div>

          <section className="tm-sa-results" aria-labelledby="tm-search-results">
            <h2 id="tm-search-results" className="tm-sa-eyebrow">
              {total > 0
                ? `${t('SearchScreen.resultsHeadingPrefix')} (${total}) ${t('SearchScreen.resultsHeadingSuffix')}`
                : t('SearchScreen.resultsHeading')}
            </h2>

            {query === '' ? (
              <div className="tm-sa-empty">
                <p className="tm-sa-empty__title">{t('SearchScreen.emptySearchTitle')}</p>
                <p className="tm-sa-empty__body">{t('SearchScreen.emptySearchBody')}</p>
              </div>
            ) : null}

            {query !== '' && noAudience ? (
              <div className="tm-sa-empty" role="status">
                <p className="tm-sa-empty__title">{t('SearchScreen.noAudienceTitle')}</p>
                <p className="tm-sa-empty__body">{t('SearchScreen.noAudienceBody')}</p>
              </div>
            ) : null}

            {results.isError ? (
              <InlineAlert tone="danger" title={t('SearchScreen.runError')} live>
                {describeError(results.error)}
              </InlineAlert>
            ) : null}

            {query !== '' && !noAudience && results.isPending ? (
              <LoadingRegion label={t('SearchScreen.running')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {settled && total === 0 ? (
              <div className="tm-sa-empty" role="status">
                <p className="tm-sa-empty__title">{t('SearchScreen.noMatchesTitle')}</p>
                <p className="tm-sa-empty__body">
                  {t('SearchScreen.noMatchesBefore')}“{query}”
                  {audienceFilter !== undefined || since !== 'all'
                    ? t('SearchScreen.withFilters')
                    : ''}
                  {t('SearchScreen.noMatchesAfter')}
                </p>
              </div>
            ) : null}

            {total > 0 ? (
              <ul className="tm-sa-results__list" aria-label={t('SearchScreen.resultsListAria')}>
                {shown.map((hit) => (
                  <li key={`${hit.kind}:${hit.id}`} className="tm-sa-hit">
                    <div className="tm-sa-hit__head">
                      <span className="tm-sa-badge">{KIND_LABEL[hit.kind]}</span>
                      {hit.kind === 'work_item' ? (
                        <Link
                          href={`/${organizationSlug}/work/${hit.id}`}
                          className="tm-sa-hit__title"
                        >
                          {hit.title}
                        </Link>
                      ) : hit.kind === 'project' ? (
                        <Link
                          href={`/${organizationSlug}/projects/${hit.id}`}
                          className="tm-sa-hit__title"
                        >
                          {hit.title}
                        </Link>
                      ) : hit.kind === 'document' ? (
                        <Link
                          href={`/${organizationSlug}/docs/${hit.id}`}
                          className="tm-sa-hit__title"
                        >
                          {hit.title}
                        </Link>
                      ) : (
                        <span className="tm-sa-hit__title">{hit.title}</span>
                      )}
                      <span
                        className={`tm-sa-audience tm-sa-audience--${hit.audience}`}
                        data-testid="search-hit-audience"
                      >
                        {AUDIENCE_PILL[hit.audience]}
                      </span>
                      <span className="tm-sa-hit__ref" aria-hidden="true">
                        {shortRef(hit.id)}
                      </span>
                    </div>
                    {hit.snippet ? <p className="tm-sa-hit__body">{hit.snippet}</p> : null}
                    <p className="tm-sa-hit__meta">
                      {projectNames.has(hit.projectId) ? (
                        <>
                          {t('SearchScreen.projectMetaPrefix')}{' '}
                          {projectNames.get(hit.projectId)}{' '}
                        </>
                      ) : null}
                      {projectNames.has(hit.projectId)
                        ? t('SearchScreen.updatedMeta')
                        : t('SearchScreen.updatedMeta').replace(/^·\s*/, '')}{' '}
                      {shortDate(hit.updatedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

/** The design's short mono reference ("8F2C·D41A"): the first eight hex digits of an id. */
export function shortRef(id: string): string {
  const hex = id.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length >= 8 ? `${hex.slice(0, 4)}·${hex.slice(4, 8)}` : id.toUpperCase();
}

/** "13 Aug" — the design's short date on the card's meta line. */
export function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
