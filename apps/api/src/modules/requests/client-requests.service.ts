import {
  CLIENT_ALLOWED_CLIENT_REQUEST_TRANSITIONS,
  DEFAULT_AUDIENCE,
  MANAGER_ONLY_CLIENT_REQUEST_TRANSITIONS,
  authorize,
  clientRequestStateMachine,
  isClientRequestState,
} from '@tmanage/domain';
import type { Audience, ClientRequestState, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { logUnrecognisedRowState } from '../../common/observability/logger.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import {
  ClientRequestNotFoundError,
  ClientRequestTransitionError,
  ClientRequestVersionConflictError,
  ClientRequestsRepository,
} from './client-requests.repository.js';
import type {
  Commitment,
  ListClientRequestsOptions,
  SubmitClientRequestInput,
  TransitionFacts,
} from './client-requests.repository.js';
import type { ClientRequestRow } from '../../common/database/schema.js';
import type { AuditEventView, AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';

/**
 * REQ-001's application service — the aggregate, and both of its projections.
 *
 * `12-PERMISSION-MATRIX` §2 gives this aggregate exactly two capabilities, and they belong to
 * two different kinds of person:
 *
 * - **`client_request.submit`** — every client role and no internal role. It is the one thing
 *   all four client roles can do, and the only write a client principal makes anywhere in this
 *   system.
 * - **`client_request.triage`** — `owner`, `org_admin`, `workspace_admin` and `manager`, and it
 *   is in `INTERNAL_ONLY_CAPABILITIES`, so a client role that somehow acquired it would still
 *   be refused by `authorize()` rule 5. That set is `23-ERD` §6's "only internal manager may
 *   accept/defer/decline" — `member`, `moderator` and `guest` do not have it.
 *
 * There is **no** `client_request.read`. Reading is therefore carried by the capability that
 * describes what the reader is there to do: a studio reads the queue under `client_request.triage`,
 * a client reads their own requests under `client_request.submit`. Inventing a third capability
 * would put a permission in the code that no role in the matrix can be granted — the same
 * argument `WorkItemsController` makes for deleting under `work.update`.
 *
 * ## Two method families, not one with a branch
 *
 * The internal methods return {@link ClientRequestView}; the client methods return
 * {@link ClientRequestClientView}. They are separate because
 * `25-AUTH-AND-TENANT-ISOLATION` §7 forbids client access implemented as
 * `serializeInternalObject(); delete fields`, and a single method that chose a shape by
 * `principal.kind` would be exactly that with an extra step. A client method cannot return the
 * internal record because it has no code path that constructs one.
 *
 * ## Who may transition what is the domain's answer, not this file's
 *
 * `MANAGER_ONLY_CLIENT_REQUEST_TRANSITIONS` and `CLIENT_ALLOWED_CLIENT_REQUEST_TRANSITIONS`
 * live next to the machine they constrain. This service reads them to pick which capability to
 * demand; it does not restate which moves belong to whom.
 */

/** The internal record. Everything the studio needs to triage. */
export interface ClientRequestView {
  readonly id: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  /**
   * Which client asked, in words — WEB-005.
   *
   * The id alone is useless on a triage screen, and a manager cannot look it up:
   * `GET client-organizations` is gated on `org.manage`, which only `owner` holds, while
   * `client_request.triage` belongs to `owner`, `org_admin`, `workspace_admin` and `manager`.
   * So a manager could triage a request and not know whose it was.
   *
   * Internal-facing and not a disclosure: this is a studio reading its own customer list, which
   * is the same list `ClientsController` serves to an owner. `null` only when the row is
   * unreadable for a reason the caller may not learn — see {@link ClientRequestsService.list}.
   */
  readonly clientOrganizationName: string | null;
  readonly submittedByUserId: string;
  readonly title: string;
  readonly category: string;
  readonly description: string;
  readonly urgencyReason: string | null;
  /** What the client asked for. Never a commitment — US-B01. */
  readonly desiredAt: string | null;
  readonly state: ClientRequestState;
  readonly clarificationQuestion: string | null;
  readonly clientVisibleReason: string | null;
  readonly clientSafeScopeSummary: string | null;
  readonly commitment: 'committed' | 'unscheduled' | null;
  readonly committedAt: string | null;
  readonly linkedWorkItemId: string | null;
  /** The concurrency token. A caller must present it to transition. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `22-SCREEN-BY-SCREEN` §6 CL-06's status vocabulary, which is not the internal lifecycle.
 *
 * CL-06 lists exactly seven: "submitted/clarifying/accepted/deferred/declined/planned/delivered".
 * `triage` is not among them, and its absence is the interesting part — a request being looked
 * at inside the studio is not a separate thing for the client to watch, and showing it would
 * turn "we are thinking about it" into a status the client is invited to chase. It reads as
 * `submitted` until there is an actual answer.
 *
 * `withdrawn` is added because the client is the one who causes it, so it cannot be news to
 * them, and a request that vanished from their own list would be worse than one labelled.
 */
export type ClientRequestStatus =
  | 'submitted'
  | 'clarifying'
  | 'accepted'
  | 'deferred'
  | 'declined'
  | 'planned'
  | 'delivered'
  | 'withdrawn';

/**
 * What the client sees. Built field by field, and three internal facts are deliberately absent:
 *
 * - **`linkedWorkItemId`.** The internal work item an acceptance is carried out through. A
 *   client holding its id could ask for it by id on an internal endpoint, and the whole of
 *   CLIENT-002 is that they cannot.
 * - **`submittedByUserId`.** Their own colleague, but this projection has no person in it at
 *   all: `CL-10 People` — "approved project contacts" — is the surface people belong on, and
 *   it is unbuilt. Echoing a user id here would create the first client-visible identity in the
 *   system by accident rather than by decision.
 * - **The internal `state`.** Replaced by {@link ClientRequestStatus} above.
 */
export interface ClientRequestClientView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly category: string;
  readonly description: string;
  readonly urgencyReason: string | null;
  /**
   * What was asked for. The field name says `desired`, never `due` or `committed`, because
   * US-B01's acceptance criterion is a "visible acknowledgement that date is requested, not
   * committed" and a field called `dueAt` would undo that before the screen was written.
   */
  readonly desiredAt: string | null;
  readonly status: ClientRequestStatus;
  /** Present only once somebody asked. The client's cue to answer. */
  readonly clarificationQuestion: string | null;
  /** §6 and CL-06: a deferral or a decline is shown with a client-safe reason. */
  readonly clientVisibleReason: string | null;
  readonly clientSafeScopeSummary: string | null;
  readonly commitment: 'committed' | 'unscheduled' | null;
  readonly committedAt: string | null;
  /**
   * Whether withdrawal is legal from where this request currently is.
   *
   * Asked of `clientRequestStateMachine`, not restated. It is on the projection because the
   * projection has made it unanswerable any other way: `triage` and `submitted` both read as
   * `submitted` to the client, and §6 draws `submitted -> withdrawn` and **no arrow out of
   * `triage`** — so a screen working from `status` alone would offer a Withdraw button that
   * fails for half the requests it appears on.
   *
   * It discloses nothing the client should not have. "May I take this back" is a fact about
   * the client's own options, not about what the studio is doing with it; a client who sees
   * the button disappear learns that somebody has picked their request up, which is a thing
   * they are entitled to know and which the studio's own copy tells them anyway.
   */
  readonly canWithdraw: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What an acceptance needs — `23-ERD` §6's three requirements, plus how the work is obtained.
 *
 * `linkedWorkItemId` and `work` are alternatives: supply the first to point at work that
 * already exists, omit it to have the acceptance create the work itself. Both go through
 * {@link ClientRequestsService.accept}, so there is no acceptance path that skips its checks.
 */
export interface AcceptClientRequestInput {
  readonly clientSafeScopeSummary: string;
  readonly commitment: Commitment;
  /** Point at existing work instead of creating some. */
  readonly linkedWorkItemId?: string;
  /** How to create the work, when none is linked. Every field has a defensible default. */
  readonly work?: {
    readonly title?: string;
    readonly ownerUserId?: string;
    /**
     * Widening the new work item to the client is a publication decision and is audited as
     * one. Absent, it is `internal` — see the note on {@link ClientRequestsService.accept}.
     */
    readonly audience?: Audience;
  };
}

export interface AcceptedClientRequest {
  readonly request: ClientRequestView;
  /** The work the acceptance is carried out through, whether created here or linked. */
  readonly workItemId: string;
  readonly workItemCreated: boolean;
}

function toView(
  row: ClientRequestRow,
  clientOrganizationName: string | null,
  correlationId: string,
): ClientRequestView {
  // The column is `VARCHAR(32)`, but only `clientRequestStateMachine` ever writes it. A value
  // outside the union means a corrupt row, which is a 500 — never a shape the internal view admits.
  // Fail closed, but log the row id + correlation id first (never the bad value) so the poisoned
  // row can be found; a single 500 otherwise names no row.
  if (!isClientRequestState(row.state)) {
    logUnrecognisedRowState('client_request', row.id, correlationId);
    throw new Error(`client request ${row.id} has an unrecognised state`);
  }
  const state = row.state;
  return {
    id: row.id,
    projectId: row.projectId,
    clientOrganizationId: row.clientOrganizationId,
    clientOrganizationName,
    submittedByUserId: row.submittedByUserId,
    title: row.title,
    category: row.category,
    description: row.description,
    urgencyReason: row.urgencyReason,
    desiredAt: row.desiredAt,
    state,
    clarificationQuestion: row.clarificationQuestion,
    clientVisibleReason: row.clientVisibleReason,
    clientSafeScopeSummary: row.clientSafeScopeSummary,
    commitment: row.commitment,
    committedAt: row.committedAt,
    linkedWorkItemId: row.linkedWorkItemId,
    version: Number(row.version),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The internal lifecycle collapsed to CL-06's vocabulary. Deliberately lossy — see above. */
export function clientStatusOf(state: string): ClientRequestStatus {
  switch (state) {
    case 'triage':
    case 'submitted':
      return 'submitted';
    case 'needs_clarification':
      return 'clarifying';
    case 'accepted':
      return 'accepted';
    case 'deferred':
      return 'deferred';
    case 'declined':
      return 'declined';
    case 'planned':
      return 'planned';
    case 'delivered':
      return 'delivered';
    case 'withdrawn':
      return 'withdrawn';
    default:
      // The column is `VARCHAR(32)`. An unrecognised value is not a state this system wrote,
      // and the safe reading of it for a client is the least informative one.
      return 'submitted';
  }
}

function toClientView(row: ClientRequestRow): ClientRequestClientView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    category: row.category,
    description: row.description,
    urgencyReason: row.urgencyReason,
    desiredAt: row.desiredAt,
    status: clientStatusOf(row.state),
    clarificationQuestion: row.clarificationQuestion,
    clientVisibleReason: row.clientVisibleReason,
    clientSafeScopeSummary: row.clientSafeScopeSummary,
    commitment: row.commitment,
    committedAt: row.committedAt,
    canWithdraw: clientRequestStateMachine.transition(row.state as ClientRequestState, 'withdrawn')
      .ok,
    version: Number(row.version),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The audience a request has, derived rather than stored.
 *
 * A request awaiting the client's answer is `client_action_required`, which is the audience
 * `CL-02 My Actions` is built on — so a clarification arrives in the client's action queue
 * without anything having to remember to put it there. Every other state is `client_visible`:
 * the client submitted it and must be able to read the answer, including a decline.
 *
 * Derived because a stored copy is a second opinion about the state, free to disagree with it
 * the first time a transition forgets to update both columns.
 */
function audienceOf(row: ClientRequestRow): Audience {
  return row.state === 'needs_clarification' ? 'client_action_required' : 'client_visible';
}

export class ClientRequestsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly requests: ClientRequestsRepository = new ClientRequestsRepository(),
    /** Optional for the reason `WorkItemsService`'s is: a test can assert what is written. */
    private readonly audit?: AuditService,
    /**
     * Read-only, and used to answer 404 rather than 500 when a submission names a project that
     * is not in this tenant. `fk_client_requests_project_tenant` already refuses the row, but a
     * foreign-key violation surfaces as a 500 — which is what WORK-001's first suite run
     * demonstrated on exactly this shape of mistake.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /**
     * Read-only, and used for one thing: proving that the work item an acceptance links to
     * exists inside this tenant. Same reasoning as `projects` above — the composite foreign key
     * refuses the row, and a 500 is the wrong way to tell a manager they mistyped an id.
     */
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
    /**
     * Read-only, and used for one thing: putting a **name** on the client a request came from,
     * for the internal view only. It is never consulted on a client path — see the note on
     * `ClientRequestView.clientOrganizationName`.
     */
    private readonly clientOrganizations: ClientOrganizationsRepository = new ClientOrganizationsRepository(),
    /**
     * PLAT-004. Optional for the reason `audit` is — a test can construct the service
     * without one and assert nothing was written. The running application always wires it.
     */
    private readonly outbox?: OutboxEventsRepository,
  ) {}

  // ── The studio's side ──────────────────────────────────────────────────────

  /**
   * The triage queue.
   *
   * No client-organization filter is applied for an internal reader: the studio triages every
   * client's requests, and which client each belongs to is on the row. The per-row relation
   * check still runs, so a `manager` sees only the projects they are on.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListClientRequestsOptions = {},
  ): Promise<readonly ClientRequestView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.requests.list(runner, context, options),
    );
    const visible = rows.filter((row) => this.mayTriage(principal, row));
    // One read for the whole page rather than one per row: a triage queue that issued a query
    // per request would make the cost of the queue quadratic in its own length.
    const names = await this.clientOrganizationNames(context, visible);
    return visible.map((row) =>
      toView(row, names.get(row.clientOrganizationId) ?? null, context.correlationId),
    );
  }

  /** Read one, internally. Absent or unrelated both produce the same 404. */
  async get(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
  ): Promise<ClientRequestView> {
    const row = await this.readOr404(context, clientRequestId);
    if (!this.mayTriage(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return toView(
      row,
      await this.clientOrganizationName(context, row.clientOrganizationId),
      context.correlationId,
    );
  }

  /**
   * Read several requests at once, internally, keyed by id — `get`'s rule in one query, plus
   * one read for the client organizations' names rather than one per row.
   *
   * An id that names nothing, or a row this principal may not triage, is missing from the map:
   * `get`'s 404, said without a throw, for the inbox, which drops the bundle silently either
   * way. Same `mayTriage`, same `toView`, the names read by id as `get` reads them; only the
   * count of round trips differs.
   */
  async getMany(
    context: TenantContext,
    principal: Principal,
    clientRequestIds: readonly string[],
  ): Promise<ReadonlyMap<string, ClientRequestView>> {
    const unique = [...new Set(clientRequestIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.database.read(context, (runner) =>
      this.requests.findManyByIds(runner, context, unique),
    );
    const readable = rows.filter((row) => this.mayTriage(principal, row));
    // By the ids on the rows, the way `get` reads one name: no archive predicate and no page
    // cap. The first shape used `clientOrganizationNames` — a page of 200 active
    // organizations — and answered `null` for an archived client's request where `get`
    // answers the name; the review fleet found it on 2026-09-03.
    const organizations = await this.database.read(context, (runner) =>
      this.clientOrganizations.findManyByIds(
        runner,
        context,
        readable.map((row) => row.clientOrganizationId),
      ),
    );
    const names = new Map(
      organizations.map((organization) => [organization.id, organization.name]),
    );

    return new Map(
      readable.map((row) => [
        row.id,
        toView(row, names.get(row.clientOrganizationId) ?? null, context.correlationId),
      ]),
    );
  }

  /**
   * Move a request through §6's lifecycle.
   *
   * Which capability is demanded depends on the *destination*, because §6 divides the machine
   * between two kinds of person rather than dividing the aggregate. `withdrawn` is the client's;
   * everything else is a manager's. A principal asking for a move outside their half is refused
   * with 403 rather than 404: they have already been allowed to read the row, so its existence
   * is not a secret from them.
   *
   * Every transition is audited. Unlike a work item's field edit, there is no step of this
   * lifecycle that is not a decision somebody may later have to account for.
   */
  async triage(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
    expectedVersion: number,
    to: ClientRequestState,
    facts: TransitionFacts = {},
  ): Promise<ClientRequestView> {
    const moved = await this.transition(
      context,
      principal,
      clientRequestId,
      expectedVersion,
      to,
      facts,
    );
    return toView(
      moved,
      await this.clientOrganizationName(context, moved.clientOrganizationId),
      context.correlationId,
    );
  }

  /**
   * The move itself, shared by {@link triage} and {@link withdraw}.
   *
   * Returns the row rather than a view, because its two callers project it differently — which
   * is the whole reason there are two of them.
   */
  private async transition(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
    expectedVersion: number,
    to: ClientRequestState,
    facts: TransitionFacts = {},
  ): Promise<ClientRequestRow> {
    const before = await this.readForMove(context, principal, clientRequestId, to);

    if (facts.linkedWorkItemId !== undefined) {
      await this.requireWorkItemInTenant(context, facts.linkedWorkItemId);
    }

    try {
      return await this.writing(() =>
        this.database.transaction(context, async (tx) => {
          const moved = await this.requests.transitionState(
            tx,
            context,
            clientRequestId,
            expectedVersion,
            to,
            facts,
          );

          await this.audit?.record(tx, context, {
            action: 'client_request.transitioned',
            objectId: moved.id,
            result: 'allowed',
            metadata: {
              project_id: moved.projectId,
              client_organization_id: moved.clientOrganizationId,
              state_before: before.state,
              state_after: moved.state,
              // Which facts were supplied, never their content. A clarification question and a
              // client-safe reason are both prose written by a person, and §12's metadata rule
              // is identifiers and classifications. An **array**, not a joined string: the
              // metadata contract's `VALUE_PATTERN` forbids the comma a joined list needs.
              facts_supplied: Object.keys(facts).sort(),
              commitment: moved.commitment ?? 'none',
            },
          });

          // 24-EVENT-CATALOG §4 `client_request.transitioned.v1`, atomic with the move
          // (§2). §5's minimums: ids, from/to, version, the optional accepted work id.
          // The clarification question and the client-safe reason are prose and stay on
          // the row.
          await this.outbox?.append(tx, context, {
            type: 'client_request.transitioned.v1',
            aggregateId: moved.id,
            payload: {
              requestId: moved.id,
              projectId: moved.projectId,
              clientOrganizationId: moved.clientOrganizationId,
              fromStatus: before.state,
              toStatus: moved.state,
              requestVersion: Number(moved.version),
              acceptedWorkItemId: moved.linkedWorkItemId,
            },
          });

          return moved;
        }),
      );
    } catch (error) {
      if (error instanceof ClientRequestTransitionError) {
        throw new ApiError(
          422,
          'validation_failed',
          `A client request cannot move from ${error.from} to ${error.to}`,
          error.missing.map((fact) => ({
            field: fact,
            message: 'is required for this transition',
          })),
          error.reason,
        );
      }
      throw error;
    }
  }

  /**
   * Accept a request **and commit the work in the same transaction** — REQ-002.
   *
   * This is the ticket's whole content, and the reason it is a route of its own rather than a
   * fact on `POST :id/transitions`. `23-ERD` §6 says acceptance "requires client-safe scope
   * summary, committed date or explicit unscheduled state, and **linked work**", and US-B02
   * says the same. REQ-001 could store the link and had no way to make it true: a manager
   * supplied the id of a work item created separately, so an acceptance and its work were two
   * writes that could each succeed without the other.
   *
   * Here they are one. The work item is inserted, the request is transitioned naming it, and
   * both audit rows are written inside a single `database.transaction`. If the machine refuses
   * the move — the request was not in `triage`, or somebody changed it since this caller read
   * it — the insert rolls back with it, and there is no orphan task in the plan describing work
   * nobody agreed to. A test asserts exactly that, because it is the one property the
   * two-write version could not have.
   *
   * ## Linking existing work is still allowed, through the same door
   *
   * A manager who has already created the task passes `linkedWorkItemId` and nothing is
   * created. One door rather than two, so there is no acceptance path that skips the checks
   * this one makes.
   *
   * ## The new work item is `internal` unless somebody says otherwise
   *
   * `DEFAULT_AUDIENCE`, and nothing cleverer. It is tempting to publish it — the client asked
   * for this, so surely they may watch it — and that would make widening a side effect of a
   * different decision, which is precisely what `25-AUTH-AND-TENANT-ISOLATION` §7 forbids.
   * What the client is owed is the answer to their request, and they get it: the request's own
   * projection carries the accepted status, the client-safe scope summary and the committed
   * date. The task underneath is the studio's execution.
   *
   * An `audience` on the body widens it deliberately, and is audited as the publication
   * decision it is.
   */
  async accept(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
    expectedVersion: number,
    input: AcceptClientRequestInput,
  ): Promise<AcceptedClientRequest> {
    const before = await this.readForMove(context, principal, clientRequestId, 'accepted');

    // Either link work that exists, or be allowed to create some. Never neither — and the
    // check happens before the transaction opens, so a refusal costs no write.
    if (input.linkedWorkItemId !== undefined) {
      await this.requireWorkItemInTenant(context, input.linkedWorkItemId);
    } else {
      const verdict = authorize({
        principal,
        capability: 'work.create',
        resource: {
          organizationId: before.organizationId,
          projectId: before.projectId,
          audience: DEFAULT_AUDIENCE,
          lifecycle: 'active',
        },
      });
      if (!verdict.allowed) {
        // 403 rather than 404: this caller has already been allowed to read the request, and
        // `client_request.triage` without `work.create` is a real and legible combination.
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
      }
    }

    const audience = input.work?.audience ?? DEFAULT_AUDIENCE;

    try {
      const result = await this.writing(() =>
        this.database.transaction(context, async (tx) => {
          let workItemId = input.linkedWorkItemId;
          let created = false;

          if (workItemId === undefined) {
            const workItem = await this.workItems.create(tx, context, {
              projectId: before.projectId,
              // The request's own title unless the manager retitled it. A task called what the
              // client called it is how the two stay findable from each other while there is no
              // messaging surface to carry the connection.
              title: input.work?.title ?? before.title,
              audience,
              ...(input.work?.ownerUserId ? { ownerUserId: input.work.ownerUserId } : {}),
              // A committed date is a date the work is due. An unscheduled acceptance leaves it
              // null rather than inventing one, which is the whole point of §6 admitting an
              // "explicit unscheduled state" as an answer.
              // `work_items.due_at` is still an instant, and the commitment is a calendar
              // date since 0012 — midnight UTC preserves the due date the pre-0012 code
              // stored. Converting `due_at` itself is a WORK-scope decision, not this one's.
              ...(input.commitment.kind === 'committed'
                ? { dueAt: new Date(`${input.commitment.day}T00:00:00.000Z`) }
                : {}),
            });
            workItemId = workItem.id;
            created = true;

            await this.audit?.record(tx, context, {
              action: 'work_item.created',
              objectId: workItem.id,
              result: 'allowed',
              metadata: {
                project_id: workItem.projectId,
                work_item_type: workItem.type,
                audience: workItem.audience,
                state: workItem.state,
                // The one fact this creation path has that the ordinary one does not.
                from_client_request: true,
              },
            });
          }

          const moved = await this.requests.transitionState(
            tx,
            context,
            clientRequestId,
            expectedVersion,
            'accepted',
            {
              clientSafeScopeSummary: input.clientSafeScopeSummary,
              commitment: input.commitment,
              linkedWorkItemId: workItemId,
            },
          );

          await this.audit?.record(tx, context, {
            action: 'client_request.transitioned',
            objectId: moved.id,
            result: 'allowed',
            metadata: {
              project_id: moved.projectId,
              client_organization_id: moved.clientOrganizationId,
              state_before: before.state,
              state_after: moved.state,
              facts_supplied: ['clientSafeScopeSummary', 'commitment', 'linkedWorkItemId'],
              commitment: moved.commitment ?? 'none',
              // Whether this acceptance made the work or merely pointed at it. The pair of rows
              // already says so by their presence; this lets the single row answer it.
              work_item_created: created,
            },
          });

          // The same event {@link transition} emits — an acceptance is a transition, and a
          // consumer must not need to know which door it came through.
          await this.outbox?.append(tx, context, {
            type: 'client_request.transitioned.v1',
            aggregateId: moved.id,
            payload: {
              requestId: moved.id,
              projectId: moved.projectId,
              clientOrganizationId: moved.clientOrganizationId,
              fromStatus: before.state,
              toStatus: moved.state,
              requestVersion: Number(moved.version),
              acceptedWorkItemId: moved.linkedWorkItemId,
            },
          });

          return { moved, workItemId, created };
        }),
      );

      return {
        request: toView(
          result.moved,
          await this.clientOrganizationName(context, result.moved.clientOrganizationId),
          context.correlationId,
        ),
        workItemId: result.workItemId,
        workItemCreated: result.created,
      };
    } catch (error) {
      if (error instanceof ClientRequestTransitionError) {
        throw new ApiError(
          422,
          'validation_failed',
          `A client request cannot move from ${error.from} to accepted`,
          error.missing.map((fact) => ({
            field: fact,
            message: 'is required for this transition',
          })),
          error.reason,
        );
      }
      throw error;
    }
  }

  /**
   * Everything recorded about this request — US-B02's "actor/time/history immutable".
   *
   * A read of `audit_events`, not a table of its own. Those rows already carry the actor, the
   * time and the correlation id; `0002_platform_primitives.sql` makes the table append-only by
   * trigger and `users.sql` grants the runtime credential `INSERT` and nothing else, so the
   * immutability US-B02 asks for is a property of the storage rather than a promise this
   * service makes. A second history table would be a second, mutable copy of it.
   *
   * `AuditService.historyOf` applies its own `audit.read` check and its own scope narrowing —
   * a principal without organization-wide scope sees their own actions only — so this method
   * adds no authority beyond proving the request is one this caller may read at all.
   */
  async historyOf(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
  ): Promise<readonly AuditEventView[]> {
    const row = await this.readOr404(context, clientRequestId);
    if (!this.mayTriage(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    if (!this.audit) return [];
    return this.audit.historyOf(context, principal, 'client_request', row.id);
  }

  // ── The client's side ──────────────────────────────────────────────────────

  /**
   * Submit a request — US-B01, and the first write a client principal has ever been able to
   * make.
   *
   * The client organization comes from the **principal**, never from the body: there is no
   * field for one, so there is no code path where a client could file a request against a
   * sibling client. That is the same decision `PortalController.inviteClientMember` makes, and
   * for the same reason.
   *
   * Two checks before the insert, and they answer different questions. Does this project exist
   * in this tenant at all? And may this principal act on it — which for a client means the
   * project is shared with their client organization, because `authorize()` rule 10 reads
   * `principal.projectIds`, and that list comes from `project_clients` and nothing else. Both
   * refuse with 404, because distinguishing them would tell a client which project ids are real.
   */
  async submit(
    context: TenantContext,
    principal: Principal,
    input: Omit<SubmitClientRequestInput, 'clientOrganizationId' | 'submittedByUserId'>,
  ): Promise<ClientRequestClientView> {
    const clientOrganizationId = principal.clientOrganizationId;
    if (principal.kind !== 'client' || !clientOrganizationId) {
      // `12-PERMISSION-MATRIX` §2 gives "Submit client request" to no internal role, so no
      // internal principal can reach this through the capability guard either. This is the
      // second refusal, and it is here because a request with no client organization is not a
      // narrower request — it is a row this table cannot hold.
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_a_client_principal');
    }

    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, input.projectId),
    );
    if (!project || project.archivedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability: 'client_request.submit',
      resource: {
        organizationId: context.organizationId,
        projectId: input.projectId,
        audience: 'client_visible',
        clientOrganizationId,
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
    }

    const row = await this.database.transaction(context, async (tx) => {
      const created = await this.requests.submit(tx, context, {
        ...input,
        clientOrganizationId,
        submittedByUserId: principal.userId,
      });

      await this.audit?.record(tx, context, {
        action: 'client_request.submitted',
        objectId: created.id,
        result: 'allowed',
        metadata: {
          project_id: created.projectId,
          client_organization_id: created.clientOrganizationId,
          // A slug by validation — see `ClientRequestsController`. The title, the description
          // and the urgency reason are prose and stay in the row; what is recorded here is
          // whether the client supplied them, which is the fact a triage-time dispute turns on.
          category: created.category,
          desired_date_stated: created.desiredAt !== null,
          urgency_stated: created.urgencyReason !== null,
        },
      });

      // 24-EVENT-CATALOG §4 `client_request.submitted.v1` — "manager inbox, notification,
      // analytics". Ids and the initial state; the title and description are prose and
      // stay on the row.
      await this.outbox?.append(tx, context, {
        type: 'client_request.submitted.v1',
        aggregateId: created.id,
        payload: {
          requestId: created.id,
          projectId: created.projectId,
          clientOrganizationId: created.clientOrganizationId,
          state: created.state,
        },
      });

      return created;
    });

    return toClientView(row);
  }

  /** One client organization's own requests. The filter is a query predicate, not a `.filter()`. */
  async listForClient(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId?: string } = {},
  ): Promise<readonly ClientRequestClientView[]> {
    const clientOrganizationId = principal.clientOrganizationId;
    if (principal.kind !== 'client' || !clientOrganizationId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_a_client_principal');
    }

    const rows = await this.database.read(context, (runner) =>
      this.requests.list(runner, context, {
        // From the principal. Another client's rows are never selected, so there is no moment
        // at which this process holds one and has to remember not to return it.
        clientOrganizationId,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      }),
    );

    return rows.filter((row) => this.mayClientRead(principal, row)).map(toClientView);
  }

  async getForClient(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
  ): Promise<ClientRequestClientView> {
    const row = await this.readOr404(context, clientRequestId);
    if (!this.mayClientRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return toClientView(row);
  }

  /**
   * Read several of the client's own requests at once, keyed by id — `getForClient`'s rule in
   * one query. The portal inbox's read: a page of a hundred bundles was a hundred round trips.
   *
   * The principal must be a client, refused the way `listForClient` refuses. An id that names
   * nothing, another client's row, or a request in a project no longer shared is missing from
   * the map — `getForClient`'s 404 without the throw. Same `mayClientRead`, same projection.
   */
  async getManyForClient(
    context: TenantContext,
    principal: Principal,
    clientRequestIds: readonly string[],
  ): Promise<ReadonlyMap<string, ClientRequestClientView>> {
    if (principal.kind !== 'client' || !principal.clientOrganizationId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_a_client_principal');
    }
    const unique = [...new Set(clientRequestIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.database.read(context, (runner) =>
      this.requests.findManyByIds(runner, context, unique),
    );

    return new Map(
      rows
        .filter((row) => this.mayClientRead(principal, row))
        .map((row) => [row.id, toClientView(row)]),
    );
  }

  /**
   * Withdraw — §6's "Client may withdraw before delivered", and the only move a client has.
   *
   * A method of its own rather than a general client transition endpoint, because there is
   * exactly one destination and naming it in the route is one fewer thing a body can get wrong.
   * The shared {@link transition} still runs, so the machine decides whether withdrawal is legal
   * from the state the request is actually in — a delivered request cannot be withdrawn, and
   * that refusal comes from `23-ERD` §6 rather than from a check written here.
   */
  async withdraw(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
    expectedVersion: number,
  ): Promise<ClientRequestClientView> {
    const row = await this.transition(
      context,
      principal,
      clientRequestId,
      expectedVersion,
      'withdrawn',
    );
    return toClientView(row);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Which capability a move requires, asked of the domain rather than restated here.
   *
   * A state in neither list is a state the machine does not have; it is refused under the
   * internal capability, and the machine then refuses the move itself.
   */
  private capabilityForMove(
    to: ClientRequestState,
  ): 'client_request.submit' | 'client_request.triage' {
    return CLIENT_ALLOWED_CLIENT_REQUEST_TRANSITIONS.includes(to) &&
      !MANAGER_ONLY_CLIENT_REQUEST_TRANSITIONS.includes(to)
      ? 'client_request.submit'
      : 'client_request.triage';
  }

  /**
   * The read and the two authority checks that precede every move, in one place.
   *
   * Shared by {@link triage} and {@link accept} so the two doors onto this aggregate cannot
   * drift into checking different things. The order is the one `25-AUTH-AND-TENANT-ISOLATION`
   * §3 fixes and it is load-bearing: **read authority first**, so a caller with no relation to
   * the row learns nothing from the difference between "you may not do that" and "that does not
   * exist"; then the capability for the specific move, which answers 403 because by then the
   * caller has already been allowed to see the row.
   */
  private async readForMove(
    context: TenantContext,
    principal: Principal,
    clientRequestId: string,
    to: ClientRequestState,
  ): Promise<ClientRequestRow> {
    const before = await this.readOr404(context, clientRequestId);

    const isClient = principal.kind === 'client';
    if (isClient ? !this.mayClientRead(principal, before) : !this.mayTriage(principal, before)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability: this.capabilityForMove(to),
      resource: this.resourceOf(before),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }

    return before;
  }

  /**
   * The names of the client organizations these requests belong to, in one read.
   *
   * By id, through `findManyByIds`, so the answer is the one `clientOrganizationName` gives per
   * row: an archived client's requests still name their client, and a tenant with more clients
   * than one page holds still names every one of them. The first shape read a page of active
   * organizations capped at 200 and answered `null` past either edge.
   *
   * A `Map` rather than a decorated list, because the caller needs to look one up per row and a
   * second array would have to be kept in step with the first.
   */
  private async clientOrganizationNames(
    context: TenantContext,
    rows: readonly ClientRequestRow[],
  ): Promise<ReadonlyMap<string, string>> {
    if (rows.length === 0) return new Map();
    const organizations = await this.database.read(context, (runner) =>
      this.clientOrganizations.findManyByIds(
        runner,
        context,
        rows.map((row) => row.clientOrganizationId),
      ),
    );
    return new Map(organizations.map((organization) => [organization.id, organization.name]));
  }

  private async clientOrganizationName(
    context: TenantContext,
    clientOrganizationId: string,
  ): Promise<string | null> {
    const found = await this.database.read(context, (runner) =>
      this.clientOrganizations.findById(runner, context, clientOrganizationId),
    );
    return found?.name ?? null;
  }

  private async readOr404(
    context: TenantContext,
    clientRequestId: string,
  ): Promise<ClientRequestRow> {
    const row = await this.database.read(context, (runner) =>
      this.requests.findById(runner, context, clientRequestId),
    );
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return row;
  }

  private async requireWorkItemInTenant(context: TenantContext, workItemId: string): Promise<void> {
    const found = await this.database.read(context, (runner) =>
      this.workItems.findById(runner, context, workItemId),
    );
    if (!found || found.deletedAt !== null) {
      throw new ApiError(422, 'validation_failed', 'The request body is invalid', [
        { field: 'linkedWorkItemId', message: 'must name a work item in this organization' },
      ]);
    }
  }

  private mayTriage(principal: Principal, row: ClientRequestRow): boolean {
    return authorize({
      principal,
      capability: 'client_request.triage',
      resource: this.resourceOf(row),
    }).allowed;
  }

  private mayClientRead(principal: Principal, row: ClientRequestRow): boolean {
    return authorize({
      principal,
      capability: 'client_request.submit',
      resource: this.resourceOf(row),
    }).allowed;
  }

  /**
   * `clientOrganizationId` is on the resource, which is what makes rule 7 bite: a client
   * principal reading a sibling client's request is refused by `authorize()` even before the
   * query predicate that would not have selected it.
   *
   * `lifecycle` is always `active`. This aggregate has no archived or soft-deleted form —
   * `withdrawn`, `declined` and `delivered` are terminal *states*, and a client must still be
   * able to read the answer they were given.
   */
  private resourceOf(row: ClientRequestRow) {
    return {
      organizationId: row.organizationId,
      projectId: row.projectId,
      audience: audienceOf(row),
      clientOrganizationId: row.clientOrganizationId,
      lifecycle: 'active' as const,
    };
  }

  /**
   * Translate the repository's write failures.
   *
   * A version conflict is a **409**: §3 step 7 asks for optimistic concurrency, and a conflict
   * surfacing as a 500 would be indistinguishable from a server fault — so a caller would retry
   * it, which is exactly the lost update the token exists to prevent. The case is real here
   * rather than theoretical: a manager triaging while the client withdraws is two people
   * writing the same row on purpose.
   */
  private async writing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ClientRequestVersionConflictError) {
        throw new ApiError(409, 'conflict', MESSAGES.conflict, [
          { field: 'version', message: 'the request changed since you read it' },
        ]);
      }
      if (error instanceof ClientRequestNotFoundError) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      throw error;
    }
  }
}
