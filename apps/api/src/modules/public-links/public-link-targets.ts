import type { Capability } from '@tmanage/domain';
import type { PublicLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 56-07 — what a public link may point at, as one adapter per target type.
 *
 * The link system knows tokens, expiry, codes, events and the one terminal decision; it knows
 * nothing about deliverables or quotes. Each consumer plugs in a {@link PublicLinkTargetAdapter}:
 * 52-18 the deliverable version (registered here as `deliverable_version`), 52-08 a `quote`
 * adapter (lines + total projection, content hash, accept/decline moves the quote's status),
 * 52-20 / 55-14 their own. A consumer module registers its adapter on {@link PublicLinkTargets}
 * in `onModuleInit`; nothing in this module changes when one is added.
 *
 * Every adapter method runs inside a transaction whose context is bound to ONE organization —
 * the member's own, or (for an outsider) a service context for the link's organization — and
 * must read with that context's `organization_id`. An object of another organization is therefore
 * `null`, never a row: a link can only ever reach an object of the organization that issued it.
 */

export const PUBLIC_LINK_KINDS = ['approval', 'intake', 'quote', 'share', 'magic_signin'] as const;
export type PublicLinkKind = (typeof PUBLIC_LINK_KINDS)[number];

/** The capability a member needs, on the target's project, to issue a link of each kind. */
export const KIND_CAPABILITY: Readonly<Record<PublicLinkKind, Capability>> = {
  approval: 'deliverable.publish',
  intake: 'client_request.triage',
  quote: 'project.manage',
  share: 'project.manage',
  magic_signin: 'project.manage',
};

/** JSON-safe, client-safe data an outsider may see. Never internal ids beyond the target's own. */
export type PublicLinkProjection = Readonly<Record<string, unknown>>;

export interface ResolvedTarget {
  /** The project the object lives in, for `authorize()`; null for an org-level object. */
  readonly projectId: string | null;
  /**
   * The hash of the object's current content. A decision link binds it at creation; a later
   * content change makes the link's decision stale ("a newer version exists"). Null when the
   * target has no versioned content (a share or intake link).
   */
  readonly versionHash: string | null;
  /** Shown on the outsider page. Already narrowed: no project, no other versions, no notes. */
  readonly projection: PublicLinkProjection;
}

/**
 * 52-18 — what the outsider said and where from, handed to a decision's side effect. `verified`
 * is true only when the decision passed the e-mail code check in this same transaction.
 */
export interface PublicLinkDecisionDetail {
  readonly comment: string | null;
  readonly typedName: string | null;
  readonly verified: boolean;
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  readonly decidedAt: Date;
}

/**
 * 52-18 — a consumer's extra side effect of a decision on a target type it does not own (the
 * approvals module records the external approver and notifies the sender for
 * `deliverable_version`). Runs in the decision's transaction after `onDecision`; throwing rolls
 * the decision back.
 */
export type PublicLinkDecisionObserver = (
  runner: TenantQueryRunner,
  context: TenantContext,
  link: PublicLinkRow,
  decision: string,
  detail: PublicLinkDecisionDetail,
) => Promise<void>;

export interface PublicLinkTargetAdapter {
  /** Stored in `public_links.target_type`; at most 32 characters. */
  readonly targetType: string;
  /** The link kinds that may point at this target type. */
  readonly kinds: readonly PublicLinkKind[];
  /** What a member needs on the target to list or revoke its links. */
  readonly manageCapability: Capability;
  /** The decisions an outsider may make, e.g. `approve | request_changes`; empty = view only. */
  readonly decisions: readonly string[];
  /** A decision that always needs the e-mail code, whatever the link says (52-08: `accept`). */
  readonly decisionsRequiringCode?: readonly string[];
  /** The object in the context's organization, or `null` (absent, gone, or another tenant's). */
  resolve(
    runner: TenantQueryRunner,
    context: TenantContext,
    targetId: string,
  ): Promise<ResolvedTarget | null>;
  /**
   * The side effect of the one terminal decision, in the same transaction that records it, under
   * the link's service context (52-08: quote → accepted/declined). Throwing rolls the decision back.
   */
  onDecision?(
    runner: TenantQueryRunner,
    context: TenantContext,
    link: PublicLinkRow,
    decision: string,
    detail?: PublicLinkDecisionDetail,
  ): Promise<void>;
}

export class PublicLinkTargets {
  private readonly adapters = new Map<string, PublicLinkTargetAdapter>();
  private readonly observers = new Map<string, PublicLinkDecisionObserver[]>();

  register(adapter: PublicLinkTargetAdapter): void {
    if (adapter.targetType.length === 0 || adapter.targetType.length > 32) {
      throw new Error(`public link target type '${adapter.targetType}' must be 1-32 characters`);
    }
    if (this.adapters.has(adapter.targetType)) {
      throw new Error(`public link target type '${adapter.targetType}' is already registered`);
    }
    this.adapters.set(adapter.targetType, adapter);
  }

  get(targetType: unknown): PublicLinkTargetAdapter | null {
    return typeof targetType === 'string' ? (this.adapters.get(targetType) ?? null) : null;
  }

  /**
   * 56-07p: the kinds a member can issue here — every kind a registered adapter takes. A kind no
   * adapter takes (`magic_signin`, issued by portal sign-in for its own 15-minute use) is not one.
   */
  issuedKinds(): readonly PublicLinkKind[] {
    const kinds = new Set([...this.adapters.values()].flatMap((adapter) => adapter.kinds));
    return PUBLIC_LINK_KINDS.filter((kind) => kinds.has(kind));
  }

  /** 52-18: add a decision side effect for a target type (registered or not yet). */
  observeDecisions(targetType: string, observer: PublicLinkDecisionObserver): void {
    const list = this.observers.get(targetType) ?? [];
    list.push(observer);
    this.observers.set(targetType, list);
  }

  decisionObservers(targetType: string): readonly PublicLinkDecisionObserver[] {
    return this.observers.get(targetType) ?? [];
  }
}

export const PUBLIC_LINK_TARGETS = Symbol.for('tmanage.PublicLinkTargets');
