import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DecisionsRepository } from './decisions.repository.js';
import type { CreateDecisionInput } from './decisions.repository.js';
import { DecisionSupersessionsRepository } from './decision-supersessions.repository.js';
import { DecisionLocksRepository, DuplicateDecisionLockError } from './decision-lock.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { MeetingsRepository } from '../calendar/meetings.repository.js';
import { ConversationsRepository } from '../conversations/conversations.repository.js';
import type {
  DecisionLockRow,
  DecisionRow,
  DecisionSupersessionRow,
} from '../../common/database/schema.js';
import type {
  DecisionAudience,
  DecisionSourceMessage,
  DecisionStatus,
  UpdateDecisionDetailsInput,
} from './decisions.repository.js';

/**
 * The application service for DEC-01 (x113) — the decision register's object-level decisions the
 * route guard cannot make. It follows the `MeetingsService` shape.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks the coarse question `meeting.read` / `meeting.write`: does
 * this role's ceiling include the capability at all. This service adds the **relation** check with
 * the row's project in hand — an internal member without organization-wide scope reads and writes
 * only the projects they belong to.
 *
 * That relation check is expressed with the sibling `work.read` / `work.create` capabilities rather
 * than with `meeting.*`, exactly as `MeetingsService` does and for the same reason: `meeting.read`
 * was declared a ceiling-mirror of `work.read` and `meeting.write` of `work.create` (see
 * `packages/domain/src/policies/capabilities.ts`), so the two are equal by construction for every
 * role, and `work.*` is what `authorize()` already relation-gates. The register reuses `meeting.*`
 * at the route this slice (no dedicated `decision.*` capability — that is a Needs-Peter), so its
 * relation gate reuses the same `work.*` mapping the calendar does.
 *
 * No audit event is written yet — like `MeetingsService`, the audit action for a decision is a
 * follow-up (it needs a `decision.*` entry in the `AuditAction` catalog, out of this slice's scope).
 */

/** What a caller is allowed to see of a decision. `organizationId` is deliberately absent. */
export interface DecisionView {
  readonly id: string;
  readonly projectId: string;
  readonly meetingId: string | null;
  readonly title: string;
  readonly statement: string;
  readonly status: DecisionStatus;
  readonly decidedBy: string;
  /** An ISO-8601 instant on the wire. */
  readonly decidedAt: string;
  readonly createdAt: string;
  /** A15 (0225). The register number the page prints as `DEC-014`; `null` only on a legacy row. */
  readonly number: number | null;
  /** A15 (0225). "Why we decided this". */
  readonly rationale: string | null;
  /** A15 (0225). The chat message the decision came from. */
  readonly sourceMessageId: string | null;
  /** A15 (0225). Who sees it: the team only, or the team and the project's client people. */
  readonly audience: DecisionAudience;
}

/** A15. The Source card of the detail page. Inline and unexported, a member of the detail. */
interface DecisionSourceView {
  /** F3. `channel` — a project channel message; `direct` — a direct message. */
  readonly kind: 'channel' | 'direct';
  readonly messageId: string;
  readonly conversationId: string;
  readonly channelName: string;
  readonly authorName: string;
  /** The message text, cut to {@link SOURCE_QUOTE_LIMIT} characters. */
  readonly quote: string;
  /** An ISO-8601 instant. */
  readonly at: string;
}

/** The Source card quotes a message, not a whole thread. */
const SOURCE_QUOTE_LIMIT = 280;

/** One end of a supersede edge, on the wire. Inline and anonymous, not a named `…View`. */
interface SupersedeEdgeView {
  /** The other decision on the edge — never the tenant id. */
  readonly decisionId: string;
  /** When the supersession was recorded, an ISO-8601 instant. */
  readonly at: string;
}

/**
 * DEC-02 decision detail: a decision plus its supersede chain — the one decision that superseded it
 * (`supersededBy`, at most one) and the decisions it superseded (`supersedes`). Extends the summary
 * projection; `organization_id` is absent for the reason {@link DecisionView} gives.
 */
export interface DecisionDetailView extends DecisionView {
  readonly supersededBy: SupersedeEdgeView | null;
  readonly supersedes: readonly SupersedeEdgeView[];
  /** A15. The decider's display name in this tenant; `null` when they are no longer a member. */
  readonly decidedByName: string | null;
  /** A15. The Source card, or `null` when the decision names no (still visible) message. */
  readonly source: DecisionSourceView | null;
}

/**
 * SEC / Decisions (x150). What a caller is shown of a decision lock — the durable fact that a
 * decision has been sealed against further lifecycle writes, by whom and when. `organizationId` is
 * deliberately absent, for the reason {@link DecisionView} gives.
 */
export interface DecisionLockView {
  readonly id: string;
  readonly decisionId: string;
  readonly lockedBy: string;
  /** An ISO-8601 instant on the wire. */
  readonly lockedAt: string;
}

function toLockView(row: DecisionLockRow): DecisionLockView {
  return {
    id: row.id,
    decisionId: row.decisionId,
    lockedBy: row.lockedBy,
    lockedAt: row.lockedAt.toISOString(),
  };
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `decisions` in a future migration is invisible to every caller
 * until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: DecisionRow): DecisionView {
  return {
    id: row.id,
    projectId: row.projectId,
    meetingId: row.meetingId,
    title: row.title,
    statement: row.statement,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    number: row.number ?? null,
    rationale: row.rationale ?? null,
    sourceMessageId: row.sourceMessageId ?? null,
    audience: row.audience ?? 'internal',
  };
}

function toSourceView(source: DecisionSourceMessage | null): DecisionSourceView | null {
  if (!source) return null;
  const text = source.body.trim();
  return {
    kind: source.kind,
    messageId: source.messageId,
    conversationId: source.conversationId,
    channelName: source.channelName,
    authorName: source.authorName,
    quote: text.length > SOURCE_QUOTE_LIMIT ? `${text.slice(0, SOURCE_QUOTE_LIMIT - 1)}…` : text,
    at: source.createdAt.toISOString(),
  };
}

function toDetailView(
  row: DecisionRow,
  supersededBy: DecisionSupersessionRow | null,
  supersedes: readonly DecisionSupersessionRow[],
  decidedByName: string | null = null,
  source: DecisionSourceMessage | null = null,
): DecisionDetailView {
  return {
    ...toView(row),
    decidedByName,
    source: toSourceView(source),
    supersededBy: supersededBy
      ? {
          decisionId: supersededBy.supersededByDecisionId,
          at: supersededBy.createdAt.toISOString(),
        }
      : null,
    supersedes: supersedes.map((edge) => ({
      decisionId: edge.decisionId,
      at: edge.createdAt.toISOString(),
    })),
  };
}

export class DecisionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly decisions: DecisionsRepository = new DecisionsRepository(),
    /**
     * Read-only, used to prove the project a new decision names exists **inside this tenant**
     * before the insert is attempted, exactly as `MeetingsService` does. The composite foreign key
     * already refuses another tenant's project, but it surfaces as a 500; an organization-wide
     * caller skips the relation gate, so without this pre-resolution a missing or cross-tenant
     * `projectId` would fall through to that foreign key.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /**
     * Read-only, used the same way for the optional `meetingId`: a named meeting is resolved inside
     * the tenant (and the acting project) before the write, so an unknown or cross-tenant meeting is
     * a 404, not a foreign-key 500.
     */
    private readonly meetings: MeetingsRepository = new MeetingsRepository(),
    /**
     * DEC-01-b / DEC-02 (x117). Writes and reads the supersede-chain edge. Stateless like the
     * others; the runner it uses is the one the service hands it inside a read or a transaction.
     */
    private readonly supersessions: DecisionSupersessionsRepository = new DecisionSupersessionsRepository(),
    /**
     * SEC / Decisions (x150). Reads and writes the decision-lock record. Stateless like the others;
     * the runner it uses is the one the service hands it inside a read or a transaction.
     */
    private readonly locks: DecisionLocksRepository = new DecisionLocksRepository(),
    /**
     * F34. Read-only: a channel-message source is the channel's content, so citing or showing it
     * needs what `ConversationsService.mayReach` needs — org-wide scope or a channel row.
     */
    private readonly conversations: Pick<
      ConversationsRepository,
      'findMembership'
    > = new ConversationsRepository(),
  ) {}

  /** F34: may this principal read the channel a source message lives in? Same runner as the read. */
  private async mayReachChannel(
    runner: Parameters<ConversationsRepository['findMembership']>[0],
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<boolean> {
    if (principal.hasOrgWideScope) return true;
    const membership = await this.conversations.findMembership(
      runner,
      context,
      conversationId,
      principal.userId,
    );
    return membership !== null;
  }

  /**
   * SEC / Decisions (x150). Refuse a mutating write to a locked decision — the substance of the lock.
   *
   * Called by every mutating decision route ({@link accept}, {@link supersede}) after the decision is
   * resolved writable and before the write: if a lock exists for the decision, the write is a 409 with
   * no change. The lock read is tenant-scoped (the repository predicate carries `organization_id`), so
   * a lock is only ever consulted within the acting tenant.
   */
  private async assertNotLocked(context: TenantContext, decisionId: string): Promise<void> {
    const lock = await this.database.read(context, (runner) =>
      this.locks.findByDecisionId(runner, context, decisionId),
    );
    if (lock) {
      throw new ApiError(
        409,
        'conflict',
        'That decision is locked and can no longer be changed',
        [{ field: 'status', message: 'the decision is locked' }],
        'decision_locked',
      );
    }
  }

  /**
   * SEC / Decisions (x150). Lock a decision: seal it against every further lifecycle write.
   *
   * The decision is resolved writable first (Known-trap): an unknown or cross-tenant `decisionId`, and
   * a non-member's probe, both earn the same not-found the lifecycle routes give. A decision already
   * locked is a 409 with **no second row** — the read-then-insert check refuses it, and
   * `uq_decision_locks_org_decision` is the engine-level backstop mapped to the same 409. On the first
   * lock, the row is written in one transaction; the immutable lock record (who locked it, and when) is
   * the durable audit of the seal.
   */
  async lock(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
  ): Promise<DecisionLockView> {
    await this.requireWritableDecision(context, principal, decisionId);

    const existing = await this.database.read(context, (runner) =>
      this.locks.findByDecisionId(runner, context, decisionId),
    );
    if (existing) {
      throw new ApiError(
        409,
        'conflict',
        'That decision is already locked',
        [{ field: 'decisionId', message: 'the decision is already locked' }],
        'already_locked',
      );
    }

    try {
      const row = await this.database.transaction(context, (tx) =>
        this.locks.create(tx, context, { decisionId, lockedBy: context.userId }),
      );
      return toLockView(row);
    } catch (error) {
      // A lock inserted by a concurrent request between the read and the write is refused by the
      // unique key and mapped to the same 409, with no second row written.
      if (error instanceof DuplicateDecisionLockError) {
        throw new ApiError(
          409,
          'conflict',
          'That decision is already locked',
          [{ field: 'decisionId', message: 'the decision is already locked' }],
          'already_locked',
        );
      }
      throw error;
    }
  }

  /**
   * Resolve a decision the principal may write to, tenant- and relation-scoped, or throw the
   * not-found that both an unknown id and a non-member's probe must earn (the Known-trap order:
   * resolve tenant-scoped BEFORE the relation check, so neither surfaces as a 500 or a 403).
   *
   * Shared by {@link accept} and {@link supersede}: both name a decision by id and both write, so
   * both resolve it the same way before anything else.
   */
  private async requireWritableDecision(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
  ): Promise<DecisionRow> {
    const decision = await this.database.read(context, (runner) =>
      this.decisions.findById(runner, context, decisionId),
    );
    if (!decision) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'decision_not_visible');
    }
    const permitted = authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: decision.organizationId,
        projectId: decision.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'decision_not_visible');
    }
    return decision;
  }

  /**
   * DEC-01-b (x117). Accept a decision: `proposed → accepted`, a guarded transition.
   *
   * The decision is resolved writable first (Known-trap). The state machine allows accept only from
   * `proposed`; accepting an already-accepted or a superseded decision is an illegal transition —
   * a 409 with no write, not a silent no-op that would report success for a change that did not
   * happen. On the allowed transition, `status` is the only column written (the `0038` trigger pins
   * every other), so who decided the decision and when stay exactly as authored.
   */
  async accept(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
  ): Promise<DecisionView> {
    const decision = await this.requireWritableDecision(context, principal, decisionId);
    // SEC / Decisions (x150): a locked decision refuses every lifecycle write — 409, no change.
    await this.assertNotLocked(context, decisionId);
    if (decision.status !== 'proposed') {
      throw new ApiError(
        409,
        'conflict',
        'A decision can only be accepted while it is proposed',
        [{ field: 'status', message: `cannot accept a decision that is ${decision.status}` }],
        'illegal_transition',
      );
    }
    const row = await this.database.transaction(context, (tx) =>
      this.decisions.updateStatus(tx, context, decisionId, 'accepted'),
    );
    return toView(row);
  }

  /**
   * A15. The detail page's Edit: change "Why we decided this" and "Visible to". Resolved writable
   * first (Known-trap), and a locked decision refuses it like every other write — 409, no change.
   */
  async updateDetails(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
    input: UpdateDecisionDetailsInput,
  ): Promise<DecisionView> {
    await this.requireWritableDecision(context, principal, decisionId);
    await this.assertNotLocked(context, decisionId);
    const row = await this.database.transaction(context, (tx) =>
      this.decisions.updateDetails(tx, context, decisionId, input),
    );
    return toView(row);
  }

  /**
   * DEC-01-b / DEC-02 (x117). Supersede a decision **by another decision**.
   *
   * Both ids are resolved tenant- and project-scoped BEFORE the write (Known-trap): the superseded
   * decision is resolved writable; the superseding one must resolve inside the tenant and belong to
   * the **same project** — a decision is superseded by one of its own project's decisions, and a
   * non-member must not be able to probe which decisions exist elsewhere, so an unknown,
   * cross-tenant or cross-project `supersededById` is a 404. A decision may not supersede itself
   * (422), and an already-superseded decision cannot be superseded again (409). In one transaction
   * the edge is written and the superseded decision's `status` is flipped to `superseded`.
   */
  async supersede(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
    supersededById: string,
  ): Promise<DecisionDetailView> {
    if (decisionId === supersededById) {
      throw new ApiError(
        422,
        'validation_failed',
        'A decision cannot supersede itself',
        [{ field: 'supersededById', message: 'must be a different decision' }],
        'self_supersede',
      );
    }

    const decision = await this.requireWritableDecision(context, principal, decisionId);
    // SEC / Decisions (x150): a locked decision refuses every lifecycle write — 409, no change.
    await this.assertNotLocked(context, decisionId);

    const superseder = await this.database.read(context, (runner) =>
      this.decisions.findById(runner, context, supersededById),
    );
    // Unknown / cross-tenant, or a decision on a different project of this tenant: not found. The
    // superseding decision must be one of the superseded decision's own project.
    if (!superseder || superseder.projectId !== decision.projectId) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'superseding_decision_not_visible',
      );
    }

    if (decision.status === 'superseded') {
      throw new ApiError(
        409,
        'conflict',
        'That decision has already been superseded',
        [{ field: 'status', message: 'the decision is already superseded' }],
        'already_superseded',
      );
    }

    await this.database.transaction(context, async (tx) => {
      await this.supersessions.create(tx, context, {
        decisionId,
        supersededByDecisionId: supersededById,
        createdBy: context.userId,
      });
      await this.decisions.updateStatus(tx, context, decisionId, 'superseded');
    });

    return this.detail(context, principal, decisionId);
  }

  /**
   * DEC-02 (x117). One decision's detail, including its supersede chain.
   *
   * Read-gated by relation (`work.read`) with the row's project in hand, exactly as {@link list}
   * filters: an unknown or cross-tenant id, and a non-member's probe, both earn the same not-found.
   * The edges are read tenant-scoped: `supersededBy` is the at-most-one decision that superseded
   * this one; `supersedes` is the decisions this one superseded.
   */
  async detail(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
  ): Promise<DecisionDetailView> {
    const decision = await this.database.read(context, (runner) =>
      this.decisions.findById(runner, context, decisionId),
    );
    if (!decision) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'decision_not_visible');
    }
    const permitted = authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: decision.organizationId,
        projectId: decision.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'decision_not_visible');
    }

    const [supersededBy, supersedes, decidedByName, source] = await this.database.read(
      context,
      async (runner) => {
        const by = await this.supersessions.findSupersededBy(runner, context, decisionId);
        const of = await this.supersessions.listSupersedes(runner, context, decisionId);
        const name = await this.decisions.findMemberName(runner, context, decision.decidedBy);
        // F3: a channel message of the decision's project, else a direct message of this tenant
        // (the recorder, a participant, chose to show it on the decision).
        let message: DecisionSourceMessage | null = null;
        if (decision.sourceMessageId) {
          const channel = await this.decisions.findSourceMessage(
            runner,
            context,
            decision.projectId,
            decision.sourceMessageId,
          );
          if (channel) {
            // F34: a viewer outside the channel sees no source card — no quote, channel name or
            // author — exactly what the channel's own read would refuse them.
            message = (await this.mayReachChannel(
              runner,
              context,
              principal,
              channel.conversationId,
            ))
              ? channel
              : null;
          } else {
            message = await this.decisions.findSourceDirectMessage(
              runner,
              context,
              decision.sourceMessageId,
            );
          }
        }
        return [by, of, name, message] as const;
      },
    );

    return toDetailView(decision, supersededBy, supersedes, decidedByName, source);
  }

  /**
   * List a project's decisions the principal may read, most recently decided first.
   *
   * The tenant filter is the repository's; the deterministic `decided_at DESC` order is too. What
   * this adds is the relation filter: a member without organization-wide scope sees a project's
   * decisions only if they belong to that project. Filtered after the read rather than pushed into
   * the query, for the reason `MeetingsService.list` gives — `authorize()` is the single place the
   * relation rule lives, and a `WHERE ... IN (...)` copy would be free to disagree with it.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId: string; readonly limit?: number },
  ): Promise<readonly DecisionView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.decisions.list(runner, context, options),
    );

    return rows
      .filter(
        (row) =>
          authorize({
            principal,
            capability: 'work.read',
            resource: {
              organizationId: row.organizationId,
              projectId: row.projectId,
              audience: 'internal',
              lifecycle: 'active',
            },
          }).allowed,
      )
      .map(toView);
  }

  /**
   * Author a decision in a project the principal may write to.
   *
   * The Known-trap order (FAST-PROTOCOL, 19:55): every id the body names is resolved tenant-scoped
   * **before** the relation check and the write, so a missing or cross-tenant id is a 404 rather
   * than a foreign-key 500 the `HttpExceptionFilter` cannot map:
   *
   * 1. The named project is resolved inside this tenant (`findById` is tenant-scoped). Unknown or
   *    another organization's ⇒ 404.
   * 2. If a `meetingId` is given, it is resolved inside this tenant and must belong to the same
   *    project. Unknown, another organization's, or another project's ⇒ 404 — a decision links a
   *    meeting of its own project, and a non-member must not be able to probe which meetings exist.
   * 3. The relation check: a caller who names a project they are not a member of gets not found,
   *    never forbidden — 403 would confirm the project exists. An organization-wide role passes it.
   * 4. The write.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly projectId: string;
      readonly meetingId?: string | null;
      readonly title: string;
      readonly statement: string;
      readonly status: DecisionStatus;
      readonly decidedAt: Date;
      readonly rationale?: string | null;
      readonly sourceMessageId?: string | null;
      readonly audience?: DecisionAudience;
      /** F3. Who took the decision; the recorder when absent. Must be an active member. */
      readonly decidedBy?: string;
    },
  ): Promise<DecisionView> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, input.projectId),
    );

    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    if (input.meetingId !== undefined && input.meetingId !== null) {
      const meeting = await this.database.read(context, (runner) =>
        this.meetings.findById(runner, context, input.meetingId as string),
      );
      // Unknown / cross-tenant, or a meeting on a different project of this tenant: not found. The
      // decision's meeting must be one of the decision's own project.
      if (!meeting || meeting.projectId !== input.projectId) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'meeting_not_visible');
      }
    }

    const permitted = authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: context.organizationId,
        projectId: input.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    // A15. A source message must be a message of this tenant in one of this project's channels —
    // or (F3, COL-10) a direct message the recorder is one of the two participants of. A direct
    // message of two other people is not found, exactly like an unknown id.
    const sourceMessageId = input.sourceMessageId ?? null;
    if (sourceMessageId !== null) {
      const visible = await this.database.read(context, async (runner) => {
        const channel = await this.decisions.findSourceMessage(
          runner,
          context,
          input.projectId,
          sourceMessageId,
        );
        // F34: citing a channel message needs the channel's own read — org-wide scope or a
        // channel row — else the same not-found as an unknown id.
        if (channel)
          return this.mayReachChannel(runner, context, principal, channel.conversationId);
        const direct = await this.decisions.findSourceDirectMessage(
          runner,
          context,
          sourceMessageId,
        );
        return direct !== null && direct.participantIds.includes(context.userId);
      });
      if (!visible) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'message_not_visible');
      }
    }

    // F3. "Decided by" another person: an active member of this tenant, else not found.
    const decidedBy = input.decidedBy ?? context.userId;
    if (decidedBy !== context.userId) {
      const member = await this.database.read(context, (runner) =>
        this.decisions.isActiveMember(runner, context, decidedBy),
      );
      if (!member) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'member_not_visible');
      }
    }

    const toWrite: CreateDecisionInput = {
      projectId: input.projectId,
      meetingId: input.meetingId ?? null,
      title: input.title,
      statement: input.statement,
      status: input.status,
      decidedBy,
      decidedAt: input.decidedAt,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(sourceMessageId !== null ? { sourceMessageId } : {}),
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
    };

    const row = await this.database.transaction(context, (tx) =>
      this.decisions.create(tx, context, toWrite),
    );

    return toView(row);
  }
}
