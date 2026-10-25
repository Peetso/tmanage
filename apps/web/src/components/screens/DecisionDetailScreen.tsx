'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { DecisionsSidebar } from '../docs/DecisionsSidebar';
import '../docs/docs-shell.css';
import {
  formatDocDay,
  formatDocMoment,
  formatDocShortDay,
  initialsFor,
  isArabic,
  rtlLine,
} from '../docs/doc-markdown';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  decisionCode,
  getDecision,
  updateDecisionDetails,
  type DecisionAudience,
  type DecisionDetail,
  type DecisionStatus,
} from '../../lib/api/decisions';
import { listDecisionWorkLinks } from '../../lib/api/decision-work-links';
import { listProjects } from '../../lib/api/projects';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { RecordedDecisionToast, takeRecordedFlag } from '../decisions/RecordDecisionDialog';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface DecisionDetailScreenProps {
  organizationSlug: string;
  organizationName: string;
  decisionId: string;
  client?: ApiClient;
}

const STATUS: Readonly<Record<DecisionStatus, { key: string; english: string }>> = {
  proposed: { key: 'DecisionDetailScreen.statusProposed', english: 'Proposed' },
  accepted: { key: 'DecisionDetailScreen.statusDecided', english: 'Decided' },
  superseded: { key: 'DecisionDetailScreen.statusSuperseded', english: 'Superseded' },
};

const WORK_STATE: Readonly<Record<string, { key: string; english: string }>> = {
  backlog: { key: 'DecisionDetailScreen.workBacklog', english: 'Planned' },
  ready: { key: 'DecisionDetailScreen.workReady', english: 'Ready' },
  in_progress: { key: 'DecisionDetailScreen.workInProgress', english: 'In progress' },
  blocked: { key: 'DecisionDetailScreen.workBlocked', english: 'Blocked' },
  internal_review: { key: 'DecisionDetailScreen.workReview', english: 'In review' },
  done: { key: 'DecisionDetailScreen.workDone', english: 'Done' },
  archived: { key: 'DecisionDetailScreen.workArchived', english: 'Archived' },
};

/**
 * **Decision detail page** — Figma 384:3835 / 384:4073 (A15).
 *
 * The decisions column on the start side, a top bar ("Decisions / <project>", Copy link, Edit),
 * then the decision: its status pill and `DEC-<nnn> · <project>`, the title, "Why we decided this",
 * the Source card (the chat message it came from: channel · author · time, the quote, "Open the
 * message"), the Linked work rows (title, owner · due, state pill), and the Details column
 * (Status, Decided by, Date, Project, Visible to).
 *
 * Edit changes the two fields a recorded decision may still change — why it was decided and who
 * can see it (`PATCH …/decisions/:id`); its title and statement are pinned by the engine.
 */
export function DecisionDetailScreen({
  organizationSlug,
  organizationName,
  decisionId,
  client,
}: DecisionDetailScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  // F3. Arriving from "Record as decision" (`?recorded=1`): the "Decision recorded" toast.
  const [recorded, setRecorded] = useState(false);
  useEffect(() => {
    if (takeRecordedFlag()) setRecorded(true);
  }, []);

  const decision = useQuery({
    queryKey: ['decision', organizationSlug, decisionId],
    queryFn: () => getDecision(api, organizationSlug, decisionId),
  });
  const links = useQuery({
    queryKey: ['decision-work-links', organizationSlug, decisionId],
    queryFn: () => listDecisionWorkLinks(api, organizationSlug, decisionId),
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const data = decision.data;
  const projectName =
    (Array.isArray(projects.data) ? projects.data : []).find(
      (project) => project.id === data?.projectId,
    )?.name ?? '';

  const audienceLabel = (audience: DecisionAudience) =>
    audience === 'client_visible'
      ? tOr('DecisionDetailScreen.visibleTeamAndClient', 'Team and client')
      : tOr('DecisionDetailScreen.visibleTeam', 'Team only');

  async function copyLink() {
    const href =
      typeof window === 'undefined'
        ? ''
        : `${window.location.origin}/${organizationSlug}/decisions/${decisionId}`;
    try {
      await navigator.clipboard?.writeText(href);
    } catch {
      // Clipboard refused (an insecure context); the address bar still holds the link.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title={data ? data.title : tOr('DecisionDetailScreen.fallbackTitle', 'Decision')}
      contextRail={
        <DecisionsSidebar
          api={api}
          organizationSlug={organizationSlug}
          activeDecisionId={decisionId}
          {...(data ? { projectId: data.projectId } : {})}
        />
      }
    >
      <div className="tm-docpage">
        <div className="tm-docpage__bar">
          <nav aria-label={tOr('DecisionDetailScreen.breadcrumbAria', 'Breadcrumb')}>
            <ol className="tm-docpage__crumbs">
              <li>
                <Link href={`/${organizationSlug}/decisions`}>
                  {tOr('DecisionDetailScreen.crumbDecisions', 'Decisions')}
                </Link>
              </li>
              {projectName !== '' ? (
                <>
                  <li aria-hidden="true">/</li>
                  <li>{projectName}</li>
                </>
              ) : null}
            </ol>
          </nav>
          <div className="tm-docpage__bar-end">
            <button type="button" className="tm-docpage__btn" onClick={() => void copyLink()}>
              {copied
                ? tOr('DecisionDetailScreen.linkCopied', 'Link copied')
                : tOr('DecisionDetailScreen.copyLink', 'Copy link')}
            </button>
            {data ? (
              <button
                type="button"
                className="tm-docpage__btn"
                aria-expanded={editing}
                onClick={() => setEditing((open) => !open)}
              >
                {tOr('DecisionDetailScreen.edit', 'Edit')}
              </button>
            ) : null}
          </div>
        </div>

        {decision.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('DecisionDetailScreen.loadError', 'Could not load this decision')}
            live
          >
            {describeError(decision.error)}
          </InlineAlert>
        ) : null}
        {decision.isPending ? (
          <LoadingRegion label={tOr('DecisionDetailScreen.loading', 'Loading the decision')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {data ? (
          <div className="tm-decpage__grid">
            <article className="tm-decpage__main" aria-labelledby="tm-decision-title">
              <p className="tm-decpage__head">
                <span className="tm-docpage__pill">
                  {tOr(STATUS[data.status].key, STATUS[data.status].english)}
                </span>
                <span>
                  {rtlLine(
                    `${decisionCode(data.number)}${projectName !== '' ? ` · ${projectName}` : ''}`,
                    locale,
                  )}
                </span>
              </p>
              <h2 id="tm-decision-title" className="tm-decpage__title">
                {data.title}
              </h2>

              {editing ? (
                <DecisionEditForm
                  decision={data}
                  audienceLabel={audienceLabel}
                  onCancel={() => setEditing(false)}
                  onSave={async (changes) => {
                    await updateDecisionDetails(api, organizationSlug, decisionId, changes);
                    await queryClient.invalidateQueries({
                      queryKey: ['decision', organizationSlug, decisionId],
                    });
                    setEditing(false);
                  }}
                />
              ) : null}

              <section className="tm-decpage__section" aria-labelledby="tm-decision-why">
                <h3 id="tm-decision-why" className="tm-decpage__h">
                  {tOr('DecisionDetailScreen.why', 'Why we decided this')}
                </h3>
                <p className="tm-decpage__prose">{data.rationale ?? data.statement}</p>
              </section>

              {data.source ? (
                <section className="tm-decpage__section" aria-labelledby="tm-decision-source">
                  <h3 id="tm-decision-source" className="tm-decpage__h">
                    {tOr('DecisionDetailScreen.source', 'Source')}
                  </h3>
                  <div className="tm-decpage__card">
                    <div className="tm-decpage__source-head">
                      <span className="tm-decpage__orb" aria-hidden="true">
                        {initialsFor(data.source.authorName)}
                      </span>
                      <span>
                        {isArabic(locale) ? '\u200F' : ''}
                        {data.source.kind === 'direct' ? (
                          tOr('DecisionDetailScreen.directMessage', 'Direct message')
                        ) : (
                          <bdi dir="ltr">#{data.source.channelName}</bdi>
                        )}{' '}
                        · {data.source.authorName} · {formatDocMoment(data.source.at, locale)}
                      </span>
                    </div>
                    <blockquote className="tm-decpage__quote">
                      {isArabic(locale) ? `«${data.source.quote}»` : `“${data.source.quote}”`}
                    </blockquote>
                    <Link
                      className="tm-decpage__open"
                      href={
                        data.source.kind === 'direct'
                          ? `/${organizationSlug}/chat/dm/${data.source.conversationId}#message-${data.source.messageId}`
                          : `/${organizationSlug}/chat/${data.source.conversationId}#message-${data.source.messageId}`
                      }
                    >
                      {tOr('DecisionDetailScreen.openMessage', 'Open the message')}{' '}
                      <span aria-hidden="true">↗</span>
                    </Link>
                  </div>
                </section>
              ) : null}

              <section className="tm-decpage__section" aria-labelledby="tm-decision-work">
                <h3 id="tm-decision-work" className="tm-decpage__h">
                  {tOr('DecisionDetailScreen.linkedWork', 'Linked work')}
                </h3>
                {links.isSuccess && links.data.length === 0 ? (
                  <p className="tm-decpage__prose">
                    {tOr('DecisionDetailScreen.noLinkedWork', 'No work is linked yet.')}
                  </p>
                ) : null}
                <ul className="tm-decpage__links">
                  {(links.data ?? []).map((link) => {
                    const state = WORK_STATE[link.workItemState];
                    const sub = [
                      link.workItemOwnerName,
                      link.workItemDueAt
                        ? `${tOr('DecisionDetailScreen.due', 'due')} ${formatDocShortDay(link.workItemDueAt, locale)}`
                        : null,
                    ]
                      .filter((part): part is string => part !== null && part !== '')
                      .join(' · ');
                    return (
                      <li key={link.linkId}>
                        <Link
                          className="tm-decpage__link"
                          href={`/${organizationSlug}/work/${link.workItemId}`}
                        >
                          <span className="tm-decpage__link-glyph" aria-hidden="true">
                            ▤
                          </span>
                          <span className="tm-decpage__link-text">
                            <span>{link.workItemTitle}</span>
                            {sub !== '' ? (
                              <span className="tm-decpage__link-sub">{sub}</span>
                            ) : null}
                          </span>
                          <span className="tm-docpage__pill">
                            {state ? tOr(state.key, state.english) : link.workItemState}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </article>

            <aside
              className="tm-decpage__side"
              aria-label={tOr('DecisionDetailScreen.details', 'Details')}
            >
              <h2>{tOr('DecisionDetailScreen.details', 'Details')}</h2>
              <dl className="tm-decpage__facts">
                <div>
                  <dt>{tOr('DecisionDetailScreen.status', 'Status')}</dt>
                  <dd>{tOr(STATUS[data.status].key, STATUS[data.status].english)}</dd>
                </div>
                <div>
                  <dt>{tOr('DecisionDetailScreen.decidedBy', 'Decided by')}</dt>
                  <dd>
                    {data.decidedByName ??
                      tOr('DecisionDetailScreen.formerMember', 'A former member')}
                  </dd>
                </div>
                <div>
                  <dt>{tOr('DecisionDetailScreen.date', 'Date')}</dt>
                  <dd>{formatDocDay(data.decidedAt, locale)}</dd>
                </div>
                <div>
                  <dt>{tOr('DecisionDetailScreen.project', 'Project')}</dt>
                  <dd>{projectName !== '' ? projectName : '—'}</dd>
                </div>
                <div>
                  <dt>{tOr('DecisionDetailScreen.visibleTo', 'Visible to')}</dt>
                  <dd>{rtlLine(audienceLabel(data.audience), locale)}</dd>
                </div>
              </dl>
            </aside>
          </div>
        ) : null}
        {recorded && data ? (
          <RecordedDecisionToast
            authorName={data.source?.authorName}
            onDone={() => setRecorded(false)}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

function DecisionEditForm({
  decision,
  audienceLabel,
  onCancel,
  onSave,
}: {
  decision: DecisionDetail;
  audienceLabel: (audience: DecisionAudience) => string;
  onCancel: () => void;
  onSave: (changes: {
    readonly rationale: string | null;
    readonly audience: DecisionAudience;
  }) => Promise<void>;
}) {
  const describeError = useDescribeApiError();
  const tOr = useTOr();
  const [rationale, setRationale] = useState(decision.rationale ?? '');
  const [audience, setAudience] = useState<DecisionAudience>(decision.audience);
  const save = useMutation({
    mutationFn: () => onSave({ rationale: rationale.trim() === '' ? null : rationale, audience }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form
      className="tm-decpage__edit"
      onSubmit={submit}
      aria-label={tOr('DecisionDetailScreen.editAria', 'Edit decision')}
    >
      <label>
        {tOr('DecisionDetailScreen.why', 'Why we decided this')}
        <textarea
          rows={4}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
        />
      </label>
      <label>
        {tOr('DecisionDetailScreen.visibleTo', 'Visible to')}
        <select
          value={audience}
          onChange={(event) => setAudience(event.target.value as DecisionAudience)}
        >
          <option value="internal">{audienceLabel('internal')}</option>
          <option value="client_visible">{audienceLabel('client_visible')}</option>
        </select>
      </label>
      {save.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('DecisionDetailScreen.saveError', 'Could not save')}
          live
        >
          {describeError(save.error)}
        </InlineAlert>
      ) : null}
      <div className="tm-decpage__edit-actions">
        <button type="submit" className="tm-docpage__btn" data-tone="ink" disabled={save.isPending}>
          {tOr('DecisionDetailScreen.save', 'Save')}
        </button>
        <button type="button" className="tm-docpage__btn" onClick={onCancel}>
          {tOr('DecisionDetailScreen.cancel', 'Cancel')}
        </button>
      </div>
    </form>
  );
}
