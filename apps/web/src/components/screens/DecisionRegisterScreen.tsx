'use client';

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { DecisionWorkLinksPanel } from './DecisionWorkLinksPanel';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import {
  acceptDecision,
  createDecision,
  listDecisions,
  lockDecision,
  supersedeDecision,
} from '../../lib/api/decisions';
import type { DecisionStatus, DecisionSummary } from '../../lib/api/decisions';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

export interface DecisionRegisterScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how a project screen hands off to its register. */
  initialProjectId?: string;
  client?: ApiClient;
}

const STATUSES: readonly { id: DecisionStatus; labelKey: MessageKey }[] = [
  { id: 'proposed', labelKey: 'DecisionRegisterScreen.statusProposed' },
  { id: 'accepted', labelKey: 'DecisionRegisterScreen.statusAccepted' },
  { id: 'superseded', labelKey: 'DecisionRegisterScreen.statusSuperseded' },
];

/**
 * **DEC-01 Decision register (x113).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Decisions DEC-01: the register a project's decisions live
 * on. This screen authors a decision — a title, the decision in words, its status and when it was
 * taken — and lists the project's register most recently decided first. It reads
 * `GET …/decisions?projectId=` and writes `POST …/decisions`, both gated on the server by the
 * calendar's `meeting.read` / `meeting.write` (the register reuses them this slice).
 *
 * Two decisions worth stating, both from the sibling work/calendar screens:
 *
 * 1. **Authorization is the API's.** A caller without the capability gets the ordinary refusal,
 *    which `describeError()` turns into a sentence; the screen never guesses a capability of its own
 *    and never renders blank on a refusal.
 * 2. **A project is chosen first.** The register is per project by definition, so nothing is fetched
 *    or written until a project is known — the one handed in, or the first the caller can see.
 *
 * The optional meeting link the API accepts is not offered here yet: there is no meeting picker on
 * this slice, and a text field for a UUID is not a form. A decision authored here is unlinked; the
 * link arrives with the meeting-close surface (a later slice).
 */
export function DecisionRegisterScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: DecisionRegisterScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const [chosenId, setProjectId] = useState<string>(initialProjectId ?? '');
  // DEC-01's filter capsules. "All" is the default so a decision just superseded stays in view.
  const [filter, setFilter] = useState<'all' | 'active' | 'superseded'>('all');
  const [title, setTitle] = useState('');
  const [statement, setStatement] = useState('');
  const [status, setStatus] = useState<DecisionStatus>('proposed');
  // DEC / module 12 (x149). Which decision's linked work the panel below the register shows, if any.
  const [selectedDecision, setSelectedDecision] = useState<{ id: string; title: string } | null>(
    null,
  );
  // SEC / Decisions (x150). The register list does not carry lock state, so the ids a caller has
  // locked this session are tracked here to reflect the seal immediately. The server is the authority
  // (a locked decision refuses every later write); this is the minimal additive surface.
  const [lockedIds, setLockedIds] = useState<ReadonlySet<string>>(() => new Set());

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // The register is per project. It opens on the project handed in, or else the first project the
  // caller can see, so the screen shows a register rather than an empty chooser.
  const available = projects.data ?? [];
  const projectId = chosenId !== '' ? chosenId : (available[0]?.id ?? '');

  const register = useQuery({
    queryKey: ['decisions', organizationSlug, projectId],
    queryFn: () => listDecisions(api, organizationSlug, { projectId }),
    enabled: projectId !== '',
  });

  const create = useMutation({
    mutationFn: () =>
      createDecision(api, organizationSlug, {
        projectId,
        title: title.trim(),
        statement: statement.trim(),
        status,
      }),
    onSuccess: async () => {
      setTitle('');
      setStatement('');
      setStatus('proposed');
      await queryClient.invalidateQueries({
        queryKey: ['decisions', organizationSlug, projectId],
      });
    },
  });

  async function refetchRegister() {
    await queryClient.invalidateQueries({
      queryKey: ['decisions', organizationSlug, projectId],
    });
  }

  // DEC-01-b lifecycle. Accept moves proposed → accepted; supersede records the chain edge and
  // flips the superseded decision's status. Both refetch the register on success; the API is the
  // authority on whether the transition is legal, and its refusal is shown, never guessed here.
  const accept = useMutation({
    mutationFn: (decisionId: string) => acceptDecision(api, organizationSlug, decisionId),
    onSuccess: refetchRegister,
  });
  const supersede = useMutation({
    mutationFn: (vars: { decisionId: string; supersededById: string }) =>
      supersedeDecision(api, organizationSlug, vars.decisionId, vars.supersededById),
    onSuccess: refetchRegister,
  });
  // SEC / Decisions (x150). Lock seals a decision against every further lifecycle write. On success the
  // id is remembered so the row reflects the seal at once; the API refuses a re-lock and any later write.
  const lock = useMutation({
    mutationFn: (decisionId: string) => lockDecision(api, organizationSlug, decisionId),
    onSuccess: (locked) => {
      setLockedIds((current) => new Set(current).add(locked.decisionId));
    },
  });

  const rows = useMemo(() => register.data ?? [], [register.data]);
  const supersededCount = rows.filter((decision) => decision.status === 'superseded').length;
  const activeCount = rows.length - supersededCount;
  const visibleRows = useMemo(
    () =>
      rows.filter((decision) =>
        filter === 'all'
          ? true
          : filter === 'superseded'
            ? decision.status === 'superseded'
            : decision.status !== 'superseded',
      ),
    [rows, filter],
  );
  const canSubmit = projectId !== '' && title.trim() !== '' && statement.trim() !== '';
  const lifecycleError = accept.error ?? supersede.error ?? lock.error;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || create.isPending) return;
    create.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      eyebrow={t('DecisionRegisterScreen.eyebrow')}
      title={t('DecisionRegisterScreen.title')}
      {...(rows.length > 0
        ? {
            headerAside: (
              <p className="tm-dx-register-count">
                {rows.length}{' '}
                {rows.length === 1
                  ? t('DecisionRegisterScreen.decisionSingular')
                  : t('DecisionRegisterScreen.decisionPlural')}{' '}
                · {supersededCount} {t('DecisionRegisterScreen.supersededWord')}
              </p>
            ),
          }
        : {})}
    >
      <div className="tm-dx">
        <div className="tm-dx-chips">
          {rows.length > 0 ? (
            <div
              className="tm-dx-chips"
              role="group"
              aria-label={t('DecisionRegisterScreen.filterAria')}
            >
              {(
                [
                  { id: 'all', label: `${t('DecisionRegisterScreen.filterAll')} · ${rows.length}` },
                  {
                    id: 'active',
                    label: `${t('DecisionRegisterScreen.filterActive')} · ${activeCount}`,
                  },
                  {
                    id: 'superseded',
                    label: `${t('DecisionRegisterScreen.filterSuperseded')} · ${supersededCount}`,
                  },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="tm-chip"
                  aria-pressed={filter === option.id}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="tm-dx-select tm-push-end">
            <label className="tm-dx-select__label" htmlFor="tm-decisions-project">
              {t('DecisionRegisterScreen.showRegisterFor')}
            </label>
            <select
              id="tm-decisions-project"
              className="tm-dx-select__control"
              value={projectId}
              disabled={projects.isPending}
              onChange={(event) => setProjectId(event.target.value)}
              aria-describedby="tm-decisions-project-hint"
            >
              {available.length === 0 ? (
                <option value="">{t('DecisionRegisterScreen.chooseProject')}</option>
              ) : null}
              {available.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <span id="tm-decisions-project-hint" className="tm-visually-hidden">
              {t('DecisionRegisterScreen.registerPerProjectHint')}
            </span>
          </div>
        </div>

        {projects.isError ? (
          <InlineAlert tone="danger" title={t('DecisionRegisterScreen.loadProjectsError')} live>
            {describeError(projects.error)}
          </InlineAlert>
        ) : null}

        {!projects.isPending && projectId === '' ? (
          <div className="tm-dx-empty">
            <p className="tm-dx-empty__title">{t('DecisionRegisterScreen.chooseProjectTitle')}</p>
            <p className="tm-dx-empty__body">{t('DecisionRegisterScreen.chooseProjectBody')}</p>
          </div>
        ) : null}

        {projectId !== '' ? (
          <div className="tm-dx-split">
            <div className="tm-dx-split__main">
              {register.isError ? (
                <InlineAlert
                  tone="danger"
                  title={t('DecisionRegisterScreen.loadRegisterError')}
                  live
                >
                  {describeError(register.error)}
                </InlineAlert>
              ) : null}

              {register.isPending ? (
                <LoadingRegion label={t('DecisionRegisterScreen.loadingRegister')}>
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {!register.isPending && !register.isError && rows.length === 0 ? (
                <div className="tm-dx-empty">
                  <p className="tm-dx-empty__title">{t('DecisionRegisterScreen.emptyTitle')}</p>
                  <p className="tm-dx-empty__body">{t('DecisionRegisterScreen.emptyBody')}</p>
                </div>
              ) : null}

              {rows.length > 0 && lifecycleError ? (
                <InlineAlert tone="danger" title={t('DecisionRegisterScreen.updateError')} live>
                  {describeError(lifecycleError)}
                </InlineAlert>
              ) : null}

              {rows.length > 0 ? (
                <section className="tm-dx" aria-labelledby="tm-decisions-heading">
                  <h2 id="tm-decisions-heading" className="tm-visually-hidden">
                    {t('DecisionRegisterScreen.registerHeading')}
                  </h2>
                  <div
                    className="tm-dx-table-card"
                    // A scrollable region must be focusable or a keyboard cannot reach its overflow
                    // columns (WCAG 2.2 2.1.1), matching the work timeline's table.
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                    tabIndex={0}
                    role="region"
                    aria-label={t('DecisionRegisterScreen.registerTableAria')}
                  >
                    <table className="tm-dx-table">
                      <caption className="tm-visually-hidden">
                        {t('DecisionRegisterScreen.captionPrefix')} {visibleRows.length}{' '}
                        {t('DecisionRegisterScreen.captionSuffix')}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('DecisionRegisterScreen.thStatement')}</th>
                          <th scope="col">{t('DecisionRegisterScreen.thStatus')}</th>
                          <th scope="col">{t('DecisionRegisterScreen.thEffective')}</th>
                          <th scope="col">{t('DecisionRegisterScreen.thLifecycle')}</th>
                          <th scope="col" className="tm-dx-table__end">
                            {t('DecisionRegisterScreen.thAffects')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map((decision) => (
                          <DecisionRow
                            organizationSlug={organizationSlug}
                            key={decision.id}
                            decision={decision}
                            candidates={rows}
                            locked={lockedIds.has(decision.id)}
                            onAccept={(id) => accept.mutate(id)}
                            onSupersede={(id, byId) =>
                              supersede.mutate({ decisionId: id, supersededById: byId })
                            }
                            onLock={(id) => lock.mutate(id)}
                            busy={accept.isPending || supersede.isPending || lock.isPending}
                            linksSelected={selectedDecision?.id === decision.id}
                            onToggleLinks={() =>
                              setSelectedDecision((current) =>
                                current?.id === decision.id
                                  ? null
                                  : { id: decision.id, title: decision.title },
                              )
                            }
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}
            </div>

            <aside
              className="tm-dx-split__side"
              aria-label={t('DecisionRegisterScreen.recordLinkAria')}
            >
              {selectedDecision ? (
                <DecisionWorkLinksPanel
                  organizationSlug={organizationSlug}
                  decisionId={selectedDecision.id}
                  decisionTitle={selectedDecision.title}
                  {...(client ? { client } : {})}
                />
              ) : null}

              <section
                className="tm-dx-card tm-dx-card--dashed"
                aria-labelledby="tm-decisions-author"
              >
                <h2 id="tm-decisions-author" className="tm-dx-card__title">
                  {t('DecisionRegisterScreen.recordHeading')}
                </h2>
                <form className="tm-dx-form" onSubmit={onSubmit} noValidate>
                  <fieldset className="tm-fieldset" disabled={create.isPending}>
                    <Field
                      label={t('DecisionRegisterScreen.decisionLabel')}
                      name="title"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      hint={t('DecisionRegisterScreen.decisionHint')}
                      required
                    />

                    <div className="tm-field">
                      <label className="tm-field__label" htmlFor="tm-decision-statement">
                        {t('DecisionRegisterScreen.inWords')}
                        <span className="tm-field__required" aria-hidden="true">
                          *
                        </span>
                      </label>
                      <textarea
                        id="tm-decision-statement"
                        name="statement"
                        className="tm-field__control tm-field__control--multiline"
                        rows={4}
                        value={statement}
                        onChange={(event) => setStatement(event.target.value)}
                        aria-describedby="tm-decision-statement-hint"
                        required
                      />
                      <span className="tm-field__hint" id="tm-decision-statement-hint">
                        {t('DecisionRegisterScreen.statementHint')}
                      </span>
                    </div>

                    <Select
                      label={t('DecisionRegisterScreen.statusSelectLabel')}
                      name="status"
                      value={status}
                      onChange={(event) => setStatus(event.target.value as DecisionStatus)}
                      hint={t('DecisionRegisterScreen.statusSelectHint')}
                    >
                      {STATUSES.map((option) => (
                        <option key={option.id} value={option.id}>
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </Select>
                  </fieldset>

                  {create.isError ? (
                    <InlineAlert tone="danger" title={t('DecisionRegisterScreen.recordError')} live>
                      {describeError(create.error)}
                    </InlineAlert>
                  ) : null}

                  <Button
                    type="submit"
                    tone="ink"
                    size="default"
                    loading={create.isPending}
                    loadingLabel={t('DecisionRegisterScreen.recording')}
                    disabled={!canSubmit}
                  >
                    {t('DecisionRegisterScreen.recordButton')}
                  </Button>
                </form>
              </section>

              <div className="tm-dx-info">
                <span className="tm-dx-info__orb" aria-hidden="true">
                  i
                </span>
                <p>{t('DecisionRegisterScreen.infoNote')}</p>
              </div>
            </aside>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function DecisionRow({
  organizationSlug,
  decision,
  candidates,
  locked,
  onAccept,
  onSupersede,
  onLock,
  busy,
  linksSelected,
  onToggleLinks,
}: {
  /** A15: the row's title opens the decision's own page. */
  organizationSlug: string;
  decision: DecisionSummary;
  candidates: readonly DecisionSummary[];
  /** SEC / Decisions (x150): the decision has been sealed this session; no further write is offered. */
  locked: boolean;
  onAccept: (decisionId: string) => void;
  onSupersede: (decisionId: string, supersededById: string) => void;
  onLock: (decisionId: string) => void;
  busy: boolean;
  linksSelected: boolean;
  onToggleLinks: () => void;
}) {
  const t = useT();
  const [supersededById, setSupersededById] = useState('');
  // A decision may be superseded by another of the same register, never by itself, and a decision
  // already superseded is a dead end.
  const options = candidates.filter(
    (other) => other.id !== decision.id && other.status !== 'superseded',
  );
  const superseder = `tm-supersede-${decision.id}`;

  return (
    <tr data-state={decision.status} {...(linksSelected ? { 'data-current': 'true' } : {})}>
      <th scope="row" className="tm-dx-table__title">
        <Link href={`/${organizationSlug}/decisions/${decision.id}`}>{decision.title}</Link>
        <span className="tm-dx-table__sub">{decision.statement}</span>
      </th>
      <td>
        <span className={`tm-dx-pill ${statusTone(decision.status)}`}>
          {t(statusLabelKey(decision.status))}
        </span>
      </td>
      <td>
        <time className="tm-dx-table__mono tm-dx-table__mono--ink" dateTime={decision.decidedAt}>
          {formatMoment(decision.decidedAt)}
        </time>
      </td>
      <td>
        {decision.status === 'superseded' ? (
          <span className="tm-dx-note">{t('DecisionRegisterScreen.noFurtherAction')}</span>
        ) : locked ? (
          // Sealed: the lifecycle controls are gone, and the row states the seal (x150).
          <span className="tm-dx-note">{t('DecisionRegisterScreen.lockedNote')}</span>
        ) : (
          <div className="tm-dx-actions">
            {decision.status === 'proposed' ? (
              <Button
                type="button"
                tone="ink"
                size="compact"
                onClick={() => onAccept(decision.id)}
                disabled={busy}
              >
                {t('DecisionRegisterScreen.accept')}
              </Button>
            ) : null}
            <label className="tm-visually-hidden" htmlFor={superseder}>
              {t('DecisionRegisterScreen.supersedeWith')}
            </label>
            <select
              id={superseder}
              className="tm-dx-select__control"
              value={supersededById}
              onChange={(event) => setSupersededById(event.target.value)}
              disabled={busy || options.length === 0}
            >
              <option value="">{t('DecisionRegisterScreen.supersedeWithOption')}</option>
              {options.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.title}
                </option>
              ))}
            </select>
            <Button
              type="button"
              tone="outline"
              size="compact"
              onClick={() => {
                if (supersededById !== '') onSupersede(decision.id, supersededById);
              }}
              disabled={busy || supersededById === ''}
            >
              {t('DecisionRegisterScreen.supersede')}
            </Button>
            <Button
              type="button"
              tone="outline"
              size="compact"
              onClick={() => onLock(decision.id)}
              disabled={busy}
            >
              {t('DecisionRegisterScreen.lock')}
            </Button>
          </div>
        )}
      </td>
      <td className="tm-dx-table__end">
        <span className="tm-dx-actions tm-dx-actions--end">
          <Button
            type="button"
            tone="outline"
            size="compact"
            onClick={onToggleLinks}
            aria-pressed={linksSelected}
          >
            {linksSelected
              ? t('DecisionRegisterScreen.hideLinkedWork')
              : t('DecisionRegisterScreen.linkedWork')}
          </Button>
        </span>
      </td>
    </tr>
  );
}

function statusLabelKey(status: DecisionStatus): MessageKey {
  return (
    STATUSES.find((option) => option.id === status)?.labelKey ??
    'DecisionRegisterScreen.statusProposed'
  );
}

function statusTone(status: DecisionStatus): string {
  if (status === 'accepted') return 'tm-dx-pill--active';
  if (status === 'superseded') return 'tm-dx-pill--muted';
  return 'tm-dx-pill--proposed';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/**
 * Format an ISO timestamp as DEC-01's "14 Aug", following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at);
}
