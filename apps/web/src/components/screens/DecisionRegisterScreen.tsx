'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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

export interface DecisionRegisterScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how a project screen hands off to its register. */
  initialProjectId?: string;
  client?: ApiClient;
}

const STATUSES: readonly { id: DecisionStatus; label: string }[] = [
  { id: 'proposed', label: 'Proposed' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'superseded', label: 'Superseded' },
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
 *    or written until a project is picked.
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

  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
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
      title="Decision register"
      description="The decisions a project has taken, most recently decided first."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-decisions-filters">
        <h2 id="tm-decisions-filters" className="tm-eyebrow">
          Project
        </h2>
        <fieldset className="tm-fieldset tm-stack" disabled={projects.isPending}>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-decisions-project">
              Show the register for
            </label>
            <select
              id="tm-decisions-project"
              className="tm-field__control"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Choose a project…</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <span className="tm-field__hint">
            A register is per project. Choose one to see and record its decisions.
          </span>
        </fieldset>
      </section>

      {projectId === '' ? (
        <InlineAlert tone="neutral" title="Choose a project">
          Pick a project above to see its decision register and record a decision.
        </InlineAlert>
      ) : null}

      {projectId !== '' ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-decisions-author">
          <h2 id="tm-decisions-author" className="tm-eyebrow">
            Record a decision
          </h2>
          <form className="tm-stack" onSubmit={onSubmit} noValidate>
            <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={create.isPending}>
              <Field
                label="Decision"
                name="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                hint="One line. What was decided."
                required
              />

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-decision-statement">
                  In words
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
                  The decision in full, and why. This is the register's record.
                </span>
              </div>

              <Select
                label="Status"
                name="status"
                value={status}
                onChange={(event) => setStatus(event.target.value as DecisionStatus)}
                hint="Where the decision stands now."
              >
                {STATUSES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </fieldset>

            {create.isError ? (
              <InlineAlert tone="danger" title="Could not record the decision" live>
                {describeError(create.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={create.isPending}
                loadingLabel="Recording"
                disabled={!canSubmit}
              >
                Record decision
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      {register.isError ? (
        <InlineAlert tone="danger" title="Could not load the register" live>
          {describeError(register.error)}
        </InlineAlert>
      ) : null}

      {projectId !== '' && register.isPending ? (
        <LoadingRegion label="Loading the decision register.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {projectId !== '' && !register.isPending && !register.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No decisions yet">
          This project has no recorded decisions. Record the first one above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 && lifecycleError ? (
        <InlineAlert tone="danger" title="Could not update the decision" live>
          {describeError(lifecycleError)}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-decisions-heading">
          <h2 id="tm-decisions-heading" className="tm-eyebrow">
            Register
          </h2>
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the work timeline's table.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Decision register"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Decisions on this project, most recently decided first, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Decision</th>
                  <th scope="col">Status</th>
                  <th scope="col">Decided</th>
                  <th scope="col">Lifecycle</th>
                  <th scope="col">Linked work</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((decision) => (
                  <DecisionRow
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

      {selectedDecision ? (
        <DecisionWorkLinksPanel
          organizationSlug={organizationSlug}
          decisionId={selectedDecision.id}
          decisionTitle={selectedDecision.title}
          {...(client ? { client } : {})}
        />
      ) : null}
    </AppShell>
  );
}

function DecisionRow({
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
  const [supersededById, setSupersededById] = useState('');
  // A decision may be superseded by another of the same register, never by itself, and a decision
  // already superseded is a dead end.
  const options = candidates.filter(
    (other) => other.id !== decision.id && other.status !== 'superseded',
  );
  const superseder = `tm-supersede-${decision.id}`;

  return (
    <tr>
      <th scope="row" className="tm-table__title">
        {decision.title}
      </th>
      <td>{statusLabel(decision.status)}</td>
      <td className="tm-mono">{formatMoment(decision.decidedAt)}</td>
      <td>
        {decision.status === 'superseded' ? (
          <span className="tm-field__hint">No further action.</span>
        ) : locked ? (
          // Sealed: the lifecycle controls are gone, and the row states the seal (x150).
          <span className="tm-field__hint">Locked. No further changes.</span>
        ) : (
          <div className="tm-stack tm-stack--tight">
            {decision.status === 'proposed' ? (
              <Button
                type="button"
                tone="ink"
                size="accessible"
                onClick={() => onAccept(decision.id)}
                disabled={busy}
              >
                Accept
              </Button>
            ) : null}
            <div className="tm-field">
              <label className="tm-field__label" htmlFor={superseder}>
                Supersede with
              </label>
              <select
                id={superseder}
                className="tm-field__control"
                value={supersededById}
                onChange={(event) => setSupersededById(event.target.value)}
                disabled={busy || options.length === 0}
              >
                <option value="">Choose a decision…</option>
                {options.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.title}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              tone="outline"
              size="accessible"
              onClick={() => {
                if (supersededById !== '') onSupersede(decision.id, supersededById);
              }}
              disabled={busy || supersededById === ''}
            >
              Supersede
            </Button>
            <Button
              type="button"
              tone="outline"
              size="accessible"
              onClick={() => onLock(decision.id)}
              disabled={busy}
            >
              Lock
            </Button>
          </div>
        )}
      </td>
      <td>
        <Button
          type="button"
          tone="outline"
          size="accessible"
          onClick={onToggleLinks}
          aria-pressed={linksSelected}
        >
          {linksSelected ? 'Hide linked work' : 'Linked work'}
        </Button>
      </td>
    </tr>
  );
}

function statusLabel(status: DecisionStatus): string {
  return STATUSES.find((option) => option.id === status)?.label ?? status;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/**
 * Format an ISO timestamp for display, following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
