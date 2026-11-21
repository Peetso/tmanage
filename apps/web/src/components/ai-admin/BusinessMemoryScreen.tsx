'use client';

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { ControlCenterShell, ccKey } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { decideBusinessFact, listBusinessFacts } from '../../lib/api/business-memory';
import type { BusinessFactDecision, BusinessFactView } from '../../lib/api/business-memory';
import { listMembers } from '../../lib/api/members';
import { listProjects } from '../../lib/api/projects';
import { listClientOrganizations } from '../../lib/api/clients';
import { roleMayUse } from '../../lib/role-capability';
import { useOrganizationRole } from '../../lib/use-organization-names';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useAiText } from '../ai-chat/use-ai-text';
import type { AiTextKey } from '../ai-chat/use-ai-text';
import { AiAdminTabs } from './AiAdminTabs';
import { AUDIENCE_LABEL, FactEditor } from './FactEditor';
import type { FactEditorOutcome, FactSubject } from './FactEditor';
import {
  FACT_FILTERS,
  FACT_PAGE,
  factState,
  filterCounts,
  inFilter,
  monthsBetween,
  sortFacts,
} from './business-memory-model';
import type { FactFilter, FactState } from './business-memory-model';
import '../ai-chat/ai-chat.css';
import './ai-admin.css';

export const BUSINESS_FACTS_KEY = (slug: string) => ['business-memory', slug] as const;

const FILTER_LABEL: Record<FactFilter, AiTextKey> = {
  all: 'BusinessMemory.filter.all',
  waiting: 'BusinessMemory.filter.waiting',
  check: 'BusinessMemory.filter.check',
  retired: 'BusinessMemory.filter.retired',
};

const STATE_CAPSULE: Record<FactState, { state: CapsuleState; label: AiTextKey }> = {
  waiting: { state: 'neutral', label: 'BusinessMemory.filter.waiting' },
  check: { state: 'waiting', label: 'BusinessMemory.filter.check' },
  approved: { state: 'done', label: 'BusinessMemory.state.approved' },
  retired: { state: 'archived', label: 'BusinessMemory.filter.retired' },
};

const ENTITY_LABEL: Record<BusinessFactView['entityType'], AiTextKey> = {
  client: 'BusinessMemory.entity.client',
  project: 'BusinessMemory.entity.project',
  person: 'BusinessMemory.entity.person',
  process: 'BusinessMemory.entity.process',
  company: 'BusinessMemory.entity.company',
};

const DECIDED: Record<BusinessFactDecision, AiTextKey> = {
  approve: 'BusinessMemory.done.approved',
  confirm: 'BusinessMemory.done.confirmed',
  retire: 'BusinessMemory.done.declined',
};

const EDITED: Record<FactEditorOutcome, AiTextKey> = {
  saved: 'BusinessMemory.done.saved',
  added: 'BusinessMemory.done.added',
  retired: 'BusinessMemory.done.retired',
};

export interface BusinessMemoryScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly client?: ApiClient;
  /** Injected in tests: "now" for "Not checked for 7 months". */
  readonly now?: () => Date;
}

/**
 * Control Center › AI › Business Memory (Figma G11 771:45216 EN; review fixes 788:49713 —
 * loading 788:49714, error 788:49903, empty 788:50497, Decline 788:49669, Show 10 more
 * 788:49677). Lasting facts TManage AI may use, each approved by a person. People who manage AI
 * (`ai.manage`) approve, decline, confirm, edit and retire; everyone else reads the facts they
 * may see and their own proposals. Names come from the lists the viewer can read; a record whose
 * name the viewer cannot read shows its kind only, never an id.
 */
export function BusinessMemoryScreen({
  organizationSlug,
  organizationName,
  client,
  now = () => new Date(),
}: BusinessMemoryScreenProps) {
  const api = useMemo(() => client ?? browserApiClient(), [client]);
  const queryClient = useQueryClient();
  const tOr = useTOr();
  const { t, plural, day, number } = useAiText();
  const { role, capabilities } = useOrganizationRole(organizationSlug);
  const manager = roleMayUse(role, capabilities, 'ai.manage');
  const seesClients = roleMayUse(role, capabilities, 'org.manage');

  const [filter, setFilter] = useState<FactFilter>('all');
  const [shown, setShown] = useState(FACT_PAGE);
  const [editing, setEditing] = useState<BusinessFactView | 'new' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const facts = useQuery({
    queryKey: BUSINESS_FACTS_KEY(organizationSlug),
    queryFn: () => listBusinessFacts(api, organizationSlug),
    retry: false,
  });
  const members = useQuery({
    queryKey: ['business-memory', organizationSlug, 'members'],
    queryFn: () => listMembers(api, organizationSlug, { limit: 200 }),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const projects = useQuery({
    queryKey: ['business-memory', organizationSlug, 'projects'],
    queryFn: () => listProjects(api, organizationSlug),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const clients = useQuery({
    queryKey: ['business-memory', organizationSlug, 'clients'],
    queryFn: () => listClientOrganizations(api, organizationSlug),
    retry: false,
    staleTime: 5 * 60_000,
    enabled: seesClients,
  });

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members.data?.members ?? [])
      map.set(`person:${member.userId}`, member.displayName);
    for (const project of projects.data ?? []) map.set(`project:${project.id}`, project.name);
    for (const company of clients.data ?? []) map.set(`client:${company.id}`, company.name);
    return map;
  }, [members.data, projects.data, clients.data]);
  const person = (userId: string | null) =>
    userId === null ? undefined : names.get(`person:${userId}`);

  const subjects = useMemo<FactSubject[]>(() => {
    const list: FactSubject[] = [
      { type: 'company', id: null, name: t('BusinessMemory.entity.company') },
      { type: 'process', id: null, name: t('BusinessMemory.entity.process') },
    ];
    for (const company of clients.data ?? []) {
      if (company.archivedAt === null) {
        list.push({
          type: 'client',
          id: company.id,
          name: `${t('BusinessMemory.entity.client')} · ${company.name}`,
        });
      }
    }
    for (const project of projects.data ?? []) {
      list.push({
        type: 'project',
        id: project.id,
        name: `${t('BusinessMemory.entity.project')} · ${project.name}`,
      });
    }
    return list;
  }, [clients.data, projects.data, t]);

  const about = (fact: BusinessFactView) => {
    const kind = t(ENTITY_LABEL[fact.entityType]);
    const name =
      fact.entityId === null ? undefined : names.get(`${fact.entityType}:${fact.entityId}`);
    return name === undefined ? kind : `${kind} · ${name}`;
  };

  const meta = (fact: BusinessFactView): string => {
    const parts = [about(fact), t(AUDIENCE_LABEL[fact.audience])];
    const state = factState(fact);
    if (state === 'waiting') {
      const owner = person(fact.ownerUserId);
      const proposer = person(fact.proposedByUserId);
      parts.push(
        fact.proposedVia === 'ai'
          ? owner === undefined
            ? t('BusinessMemory.meta.suggestedByAi')
            : t('BusinessMemory.meta.suggestedByAiFor', { name: owner })
          : proposer === undefined
            ? t('BusinessMemory.meta.suggested')
            : t('BusinessMemory.meta.suggestedBy', { name: proposer }),
      );
    } else if (state === 'check') {
      const since = fact.lastConfirmedAt ?? fact.approvedAt ?? fact.createdAt;
      parts.push(
        plural('BusinessMemory.meta.notChecked', monthsBetween(since, now()), {
          one: 'Not checked for {count} month',
          other: 'Not checked for {count} months',
        }),
      );
    } else if (state === 'approved') {
      const approver = person(fact.approvedByUserId);
      if (approver !== undefined)
        parts.push(t('BusinessMemory.meta.approvedBy', { name: approver }));
      const checked = fact.lastConfirmedAt ?? fact.approvedAt;
      if (checked !== null) parts.push(t('BusinessMemory.meta.checked', { date: day(checked) }));
    } else if (fact.retiredAt !== null) {
      parts.push(t('BusinessMemory.meta.retired', { date: day(fact.retiredAt) }));
    }
    return parts.join(' · ');
  };

  const decide = useMutation({
    mutationFn: ({ fact, decision }: { fact: BusinessFactView; decision: BusinessFactDecision }) =>
      decideBusinessFact(api, organizationSlug, fact.id, decision),
    onSuccess: (_view, { decision }) => {
      setNotice({ tone: 'success', text: t(DECIDED[decision]) });
      void queryClient.invalidateQueries({ queryKey: BUSINESS_FACTS_KEY(organizationSlug) });
    },
    onError: (error) => {
      const stale =
        error instanceof ApiRequestError && (error.status === 409 || error.status === 404);
      setNotice({
        tone: 'danger',
        text: t(stale ? 'BusinessMemory.decideStale' : 'BusinessMemory.decideFailed'),
      });
      if (stale)
        void queryClient.invalidateQueries({ queryKey: BUSINESS_FACTS_KEY(organizationSlug) });
    },
  });

  const open = (target: BusinessFactView | 'new', from: HTMLElement) => {
    opener.current = from;
    setNotice(null);
    setEditing(target);
  };
  const close = () => {
    setEditing(null);
    opener.current?.focus();
  };

  const all = facts.data?.facts ?? [];
  const counts = filterCounts(all);
  const visible = sortFacts(all.filter((fact) => inFilter(fact, filter)));
  const page = visible.slice(0, shown);

  const addButton = (
    <Button tone="ink" size="accessible" onClick={(event) => open('new', event.currentTarget)}>
      {t('BusinessMemory.add')}
    </Button>
  );

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="ai"
      crumbs={[tOr(ccKey('ControlCenter.ai'), 'AI')]}
      title={t('BusinessMemory.title')}
      description={t('BusinessMemory.lead')}
      {...(facts.isSuccess ? { actions: addButton } : {})}
      client={api}
    >
      <AiAdminTabs organizationSlug={organizationSlug} current="memory" />
      <div className="tm-aia-memory">
        {facts.isPending ? (
          <div className="tm-aia-state" aria-busy="true">
            <span className="tm-aia-muted">{t('BusinessMemory.loading')}</span>
            <Skeleton />
            <Skeleton />
          </div>
        ) : facts.isError ? (
          <div className="tm-aia-state">
            <InlineAlert tone="danger" live>
              {t('BusinessMemory.loadFailed')}
            </InlineAlert>
            <div>
              <Button tone="outline" size="compact" onClick={() => void facts.refetch()}>
                {t('BusinessMemory.tryAgain')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div role="status" aria-live="polite" className="tm-aia-notice">
              {notice ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}
            </div>
            {!manager ? (
              <InlineAlert tone="neutral">{t('BusinessMemory.readOnly')}</InlineAlert>
            ) : null}
            {all.length === 0 ? (
              <div className="tm-aia-empty">
                <h2 className="tm-aia-empty__title">{t('BusinessMemory.emptyTitle')}</h2>
                <p className="tm-aia-muted">{t('BusinessMemory.emptyBody')}</p>
              </div>
            ) : (
              <>
                <div
                  className="tm-aia-chips"
                  role="group"
                  aria-label={t('BusinessMemory.filterLabel')}
                >
                  {FACT_FILTERS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="tm-aia-chip"
                      aria-pressed={filter === id}
                      onClick={() => {
                        setFilter(id);
                        setShown(FACT_PAGE);
                      }}
                    >
                      {t(FILTER_LABEL[id])}
                      <span className="tm-aia-chip__count">{number(counts[id])}</span>
                    </button>
                  ))}
                </div>
                {page.length === 0 ? (
                  <p className="tm-aia-muted">{t('BusinessMemory.emptyFilter')}</p>
                ) : (
                  <ul className="tm-aia-facts">
                    {page.map((fact) => {
                      const state = factState(fact);
                      const capsule = STATE_CAPSULE[state];
                      const busy = decide.isPending && decide.variables?.fact.id === fact.id;
                      return (
                        <li key={fact.id} className="tm-aia-fact">
                          <div className="tm-aia-fact__text">
                            <p className="tm-aia-fact__fact" dir="auto">
                              {fact.fact}
                            </p>
                            <p className="tm-aia-fact__meta">{meta(fact)}</p>
                          </div>
                          <StateCapsule state={capsule.state}>{t(capsule.label)}</StateCapsule>
                          {manager && state !== 'retired' ? (
                            <div className="tm-aia-fact__actions">
                              {state === 'waiting' ? (
                                <>
                                  <Button
                                    tone="outline"
                                    size="compact"
                                    className="tm-aic-touch"
                                    loading={busy && decide.variables?.decision === 'approve'}
                                    onClick={() => decide.mutate({ fact, decision: 'approve' })}
                                  >
                                    {t('BusinessMemory.approve')}
                                  </Button>
                                  <Button
                                    tone="text"
                                    size="compact"
                                    className="tm-aic-touch"
                                    loading={busy && decide.variables?.decision === 'retire'}
                                    onClick={() => decide.mutate({ fact, decision: 'retire' })}
                                  >
                                    {t('BusinessMemory.decline')}
                                  </Button>
                                </>
                              ) : null}
                              {state === 'check' ? (
                                <Button
                                  tone="outline"
                                  size="compact"
                                  className="tm-aic-touch"
                                  loading={busy}
                                  onClick={() => decide.mutate({ fact, decision: 'confirm' })}
                                >
                                  {t('BusinessMemory.stillTrue')}
                                </Button>
                              ) : null}
                              <Button
                                tone="text"
                                size={state === 'approved' ? 'accessible' : 'compact'}
                                className="tm-aic-touch"
                                aria-label={t('BusinessMemory.editFact', { fact: fact.fact })}
                                onClick={(event) => open(fact, event.currentTarget)}
                              >
                                {t('BusinessMemory.edit')}
                              </Button>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="tm-aia-more">
                  <span className="tm-aia-muted">
                    {plural('BusinessMemory.showing', visible.length, {
                      one: 'Showing {shown} of {count} fact',
                      other: 'Showing {shown} of {count} facts',
                    }).replace('{shown}', number(page.length))}
                  </span>
                  <span className="tm-aia-spacer" />
                  {visible.length > page.length ? (
                    <Button
                      tone="text"
                      size="compact"
                      className="tm-aic-touch"
                      onClick={() => setShown((current) => current + FACT_PAGE)}
                    >
                      {t('BusinessMemory.showMore', { count: number(FACT_PAGE) })}
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {editing !== null ? (
        <FactEditor
          organizationSlug={organizationSlug}
          client={api}
          subjects={subjects}
          {...(editing === 'new' ? {} : { fact: editing, about: about(editing) })}
          onClose={close}
          onDone={(outcome) => {
            setNotice({ tone: 'success', text: t(EDITED[outcome]) });
            void queryClient.invalidateQueries({ queryKey: BUSINESS_FACTS_KEY(organizationSlug) });
            close();
          }}
        />
      ) : null}
    </ControlCenterShell>
  );
}
