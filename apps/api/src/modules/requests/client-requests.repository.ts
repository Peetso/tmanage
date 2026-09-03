import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { clientRequestStateMachine, uuidv7 } from '@tmanage/domain';
import type { ClientRequestState } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientRequests } from '../../common/database/schema.js';
import type { ClientRequestRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Client requests — REQ-001's storage half.
 *
 * `WorkItemsRepository`'s shape: `TenantContext` as the scoping parameter, no `organizationId`
 * on any input type, keyset pagination, a real `version` column for optimistic concurrency,
 * not-found rather than conflict for a caller in the wrong tenant. What differs is worth
 * reading, because each difference is a decision rather than a variation.
 *
 * ## The facts of a transition are columns, and only a transition writes them
 *
 * `23-ERD-AND-STATE-MACHINES` §6 attaches named requirements to particular moves — a question
 * to ask for clarification, a client-safe reason to defer or decline, and a scope summary, a
 * commitment and linked work to accept. `clientRequestStateMachine` in `packages/domain`
 * already refuses a move that arrives without them.
 *
 * This repository writes those facts **in the same statement as the state**. There is
 * deliberately no `update()` method at all, so there is no path that sets a decline reason
 * without declining, and no path that quietly edits the scope summary a client was shown after
 * they were shown it. A reason in this table is evidence that the decision it belongs to was
 * actually taken.
 *
 * ## There is no delete, soft or otherwise
 *
 * `WorkItemsRepository` has `softDelete`. This one has nothing. §6 gives the *client*
 * `withdrawn` and gives the studio no exit at all, and `users.sql` grants no DELETE on this
 * table, so the absence is structural rather than a matter of this file's restraint. An
 * agency that could make an awkward request disappear would be an agency whose request log
 * proves nothing.
 *
 * ## `client_organization_id` is not derived and never changes
 *
 * It is written from the submitting principal and refused by a trigger on every UPDATE, along
 * with `project_id` and `submitted_by_user_id`. Those three columns are what the request *is*;
 * re-pointing a submitted request at another client's project would silently reassign an
 * answer, which is the client-to-client boundary `04-SECURITY-PRIVACY` §5 is most emphatic
 * about being unable to cross.
 */

export class ClientRequestNotFoundError extends Error {
  constructor(readonly clientRequestId: string) {
    // No organization id and no client organization id in the message, for the reason
    // `WorkItemNotFoundError` gives: a caller probing for another tenant's — or another
    // client's — request must not learn anything from the wording.
    super(`Client request ${clientRequestId} was not found`);
    this.name = 'ClientRequestNotFoundError';
  }
}

export class ClientRequestVersionConflictError extends Error {
  constructor(
    readonly clientRequestId: string,
    readonly expectedVersion: number,
  ) {
    super(
      `Client request ${clientRequestId} was modified concurrently ` +
        `(expected version ${expectedVersion})`,
    );
    this.name = 'ClientRequestVersionConflictError';
  }
}

export class ClientRequestTransitionError extends Error {
  constructor(
    readonly from: ClientRequestState,
    readonly to: ClientRequestState,
    readonly reason: 'illegal_transition' | 'missing_requirement',
    /** Named facts the transition required and did not get. Empty for an illegal move. */
    readonly missing: readonly string[],
    detail: string,
  ) {
    // From the state machine, and documented there as stable and non-sensitive: it names
    // states and required field names, never row content.
    super(detail);
    this.name = 'ClientRequestTransitionError';
  }
}

/**
 * What a client supplies. Note what is absent: `organizationId`, taken from the context;
 * `clientOrganizationId`, taken from the principal; and `state`, which is the lifecycle's
 * initial state and is not a caller's to choose.
 */
export interface SubmitClientRequestInput {
  readonly projectId: string;
  readonly clientOrganizationId: string;
  readonly submittedByUserId: string;
  readonly title: string;
  readonly description: string;
  readonly category?: string;
  readonly urgencyReason?: string | null;
  /** Requested, never committed — US-B01. A `'YYYY-MM-DD'` calendar date (0012). */
  readonly desiredAt?: string | null;
}

export interface ListClientRequestsOptions {
  /** Keyset pagination. Cursors are ids, and the sort is by id. */
  readonly after?: string;
  readonly limit?: number;
  readonly projectId?: string;
  /**
   * Restrict to one client organization. **Omitting this returns every client's requests**,
   * which is only ever correct for an internal reader — a client's own read must always pass
   * their own id, and `ClientRequestsService` supplies it from the principal.
   */
  readonly clientOrganizationId?: string;
  readonly states?: readonly ClientRequestState[];
}

/**
 * §6's "committed date or explicit unscheduled state", as one value.
 *
 * A single fact rather than two, because it is a choice between two things: an acceptance
 * either names a date or says explicitly that there is not one yet. Two independent nullable
 * inputs would admit a third possibility — neither — which is the ambiguity §6 exists to
 * remove, and which the trigger in `0006_client_requests.sql` refuses at the engine.
 */
export type Commitment =
  { readonly kind: 'committed'; readonly day: string } | { readonly kind: 'unscheduled' };

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * The facts §6 names, mapped onto the columns that hold them.
 *
 * Keys match the `requires` lists in `clientRequestStateMachine` exactly. They have to: the
 * machine decides whether a fact was supplied, and a key spelled differently here would be a
 * fact the machine accepted and the row never recorded.
 */
export interface TransitionFacts {
  readonly clarificationQuestion?: string;
  readonly clientVisibleReason?: string;
  readonly clientSafeScopeSummary?: string;
  readonly commitment?: Commitment;
  readonly linkedWorkItemId?: string;
}

export class ClientRequestsRepository {
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListClientRequestsOptions = {},
  ): Promise<readonly ClientRequestRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [eq(clientRequests.organizationId, context.organizationId)];
    if (options.projectId) predicates.push(eq(clientRequests.projectId, options.projectId));
    if (options.clientOrganizationId) {
      predicates.push(eq(clientRequests.clientOrganizationId, options.clientOrganizationId));
    }
    if (options.states && options.states.length > 0) {
      predicates.push(inArray(clientRequests.state, [...options.states]));
    }
    if (options.after) predicates.push(gt(clientRequests.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(clientRequests)
      .where(and(...predicates))
      .orderBy(asc(clientRequests.id))
      .limit(limit);
  }

  /**
   * Fetch one request by id, within the acting tenant.
   *
   * There is deliberately no `findById(id)` without a context, for the reason ADR-0001 exists:
   * on MySQL such a method returns another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientRequestId: string,
  ): Promise<ClientRequestRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(clientRequests)
      .where(
        and(
          eq(clientRequests.organizationId, context.organizationId),
          eq(clientRequests.id, clientRequestId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch several requests by id in one query, within the acting tenant.
   *
   * `WorkItemsRepository.findManyByIds`'s shape: an id that names nothing, or another
   * tenant's row, is absent from the result rather than an error, and the service applies its
   * own per-row rule (`mayTriage` or `mayClientRead`) to what comes back. The order is the
   * database's.
   */
  async findManyByIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientRequestIds: readonly string[],
  ): Promise<readonly ClientRequestRow[]> {
    if (clientRequestIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(clientRequests)
      .where(
        and(
          eq(clientRequests.organizationId, context.organizationId),
          inArray(clientRequests.id, [...clientRequestIds]),
        ),
      );
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientRequestId: string,
  ): Promise<ClientRequestRow> {
    const found = await this.findById(runner, context, clientRequestId);
    if (!found) throw new ClientRequestNotFoundError(clientRequestId);
    return found;
  }

  /**
   * Submit a request, at the lifecycle's initial state.
   *
   * `state` is written explicitly from `clientRequestStateMachine.definition.initial` and the
   * column has no `DEFAULT` to fall back on — see the note in `0006_client_requests.sql` about
   * `work_items.state`, whose default names a state from *this* lifecycle.
   *
   * Neither the project nor the client organization is re-checked here. Both are composite
   * foreign keys including `organization_id`, so the database refuses a row that names either
   * one from another tenant; duplicating that in the repository would only give it somewhere
   * to drift from. What the service checks, and the database cannot, is whether the project is
   * *shared with* this client organization — a `project_clients` row, not a foreign key.
   */
  async submit(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: SubmitClientRequestInput,
  ): Promise<ClientRequestRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(clientRequests)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        projectId: input.projectId,
        clientOrganizationId: input.clientOrganizationId,
        submittedByUserId: input.submittedByUserId,
        title: input.title,
        category: input.category ?? 'general',
        description: input.description,
        urgencyReason: input.urgencyReason ?? null,
        desiredAt: input.desiredAt ?? null,
        state: clientRequestStateMachine.definition.initial,
        version: 1,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct: the row now carries server-generated timestamps.
    return this.requireById(runner, context, id);
  }

  /**
   * Move a request through §6's lifecycle, writing the facts the move required.
   *
   * The current state is read inside the same unit of work and checked by the machine, then
   * the write re-states `version` — so a concurrent change between the read and the write
   * loses rather than slipping through a check made against a state it has since left.
   *
   * The columns written are exactly the ones the target state's requirements name. Nothing is
   * cleared: a clarification question survives the return to `triage`, because "what were they
   * asked" is a question about the past that a later state does not answer.
   */
  async transitionState(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientRequestId: string,
    expectedVersion: number,
    to: ClientRequestState,
    facts: TransitionFacts = {},
  ): Promise<ClientRequestRow> {
    const current = await this.requireById(runner, context, clientRequestId);
    // The column is `VARCHAR(32)`, so the row's state is a string as far as the type system is
    // concerned. The machine is the authority on whether it is a state at all; an unrecognised
    // value simply has no outbound transition and is refused rather than throwing elsewhere.
    const from = current.state as ClientRequestState;

    const verdict = clientRequestStateMachine.transition(from, to, {
      ...facts,
      // The machine checks presence, and a `Commitment` object is present whichever kind it
      // is. Spelled out rather than relying on that, so the fact the machine sees is the fact
      // the column records.
      ...(facts.commitment ? { commitment: facts.commitment.kind } : {}),
    });
    if (!verdict.ok) {
      throw new ClientRequestTransitionError(
        from,
        to,
        verdict.reason,
        verdict.missing,
        verdict.detail,
      );
    }

    const changes: Record<string, unknown> = {
      state: to,
      version: sql`version + 1`,
      updatedAt: sql`current_timestamp(3)`,
    };
    if (facts.clarificationQuestion !== undefined) {
      changes['clarificationQuestion'] = facts.clarificationQuestion;
    }
    if (facts.clientVisibleReason !== undefined) {
      changes['clientVisibleReason'] = facts.clientVisibleReason;
    }
    if (facts.clientSafeScopeSummary !== undefined) {
      changes['clientSafeScopeSummary'] = facts.clientSafeScopeSummary;
    }
    if (facts.commitment !== undefined) {
      changes['commitment'] = facts.commitment.kind;
      // Null for `unscheduled`, and the trigger in 0006 refuses the incoherent pairs either
      // way round. §6 asks for a date *or* an explicit absence, never for both and never for
      // neither.
      changes['committedAt'] = facts.commitment.kind === 'committed' ? facts.commitment.day : null;
    }
    if (facts.linkedWorkItemId !== undefined) {
      changes['linkedWorkItemId'] = facts.linkedWorkItemId;
    }

    const result = await tenantDrizzle(runner)
      .update(clientRequests)
      .set(changes)
      .where(
        and(
          eq(clientRequests.organizationId, context.organizationId),
          eq(clientRequests.id, clientRequestId),
          eq(clientRequests.version, expectedVersion),
        ),
      );

    if (result[0].affectedRows === 0) {
      // Zero rows means one of three things: wrong tenant, no such request, or a stale token.
      // A scoped read distinguishes them, so a caller in the wrong tenant still gets "not
      // found" rather than a conflict that confirms the row exists.
      const live = await this.findById(runner, context, clientRequestId);
      if (!live) throw new ClientRequestNotFoundError(clientRequestId);
      throw new ClientRequestVersionConflictError(clientRequestId, live.version);
    }

    return this.requireById(runner, context, clientRequestId);
  }
}
