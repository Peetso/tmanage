/**
 * Audience — the visibility classification carried by every governed object.
 *
 * `12-PERMISSION-MATRIX.md` §3.
 *
 * The critical rule, stated in `04-SECURITY-PRIVACY.md` §5 and `15-AI-EXECUTION-HANDBOOK.md` §3:
 * **new content defaults to `internal`**. Client visibility is never inherited, never
 * defaulted on, and never implied by the parent object's audience.
 */

export const AUDIENCES = ['internal', 'client_visible', 'client_action_required'] as const;

export type Audience = (typeof AUDIENCES)[number];

/**
 * The audience every newly created governed object receives.
 *
 * Exported as a named constant rather than inlined so that a search for
 * `DEFAULT_AUDIENCE` finds every creation path, and so a change to it is a
 * single reviewable diff rather than a sweep.
 */
export const DEFAULT_AUDIENCE: Audience = 'internal';

/** Audiences an external principal may ever see. */
const CLIENT_READABLE: ReadonlySet<Audience> = new Set<Audience>([
  'client_visible',
  'client_action_required',
]);

/**
 * Is this audience, in principle, readable by an external principal?
 *
 * This is a *necessary* condition, never a sufficient one. A `client_visible` object is
 * still only reachable through a published projection by an active client member of a
 * client organization related to that project (`12-PERMISSION-MATRIX` §3). The evaluator
 * enforces the rest; this function only rules out `internal`.
 */
export function isClientReadableAudience(audience: Audience): boolean {
  return CLIENT_READABLE.has(audience);
}

/**
 * Comments inherit the audience of the object they are attached to.
 *
 * `12-PERMISSION-MATRIX.md` §3: "Comments inherit object audience; internal note is a
 * separate object, not a hidden flag inside a client comment."
 *
 * The second half matters more than the first. There is deliberately no
 * `internal: boolean` on a comment — an internal note is a distinct record type, so a
 * serialization bug cannot leak it as a field that was merely supposed to be filtered.
 */
export function inheritedCommentAudience(objectAudience: Audience): Audience {
  // A comment on an action-required object is visible, but does not itself demand action.
  return objectAudience === 'client_action_required' ? 'client_visible' : objectAudience;
}

/**
 * Can `from` be changed to `to` without a re-authorization / confirmation step?
 *
 * `12-PERMISSION-MATRIX.md` §5 lists "bulk visibility change" and "external publish" among
 * the actions requiring confirmation. Widening visibility is externally consequential;
 * narrowing it is not.
 */
export function isVisibilityWidening(from: Audience, to: Audience): boolean {
  const rank: Record<Audience, number> = {
    internal: 0,
    client_visible: 1,
    client_action_required: 2,
  };
  return rank[to] > rank[from];
}

/**
 * Fields that must never appear in a client-facing payload.
 *
 * From `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §5 and `12-PERMISSION-MATRIX.md` §4.
 *
 * ## This list is a safety net, not the mechanism
 *
 * The actual mechanism is that client DTOs are **built from explicit allowlisted columns**.
 * `25-AUTH-AND-TENANT-ISOLATION` §7 is emphatic: "Never implement client access as
 * `serializeInternalObject(); delete fields`."
 *
 * This list exists so a test can assert that no client projection ever contains one of
 * these keys — catching the case where someone adds a field to an allowlist without
 * thinking about who reads it. If this net ever actually catches something in production
 * code, the allowlist that produced it is the bug.
 */
export const FORBIDDEN_CLIENT_FIELDS: readonly string[] = [
  'internalDescription',
  'internalNotes',
  'internalRiskRationale',
  'privateComments',
  'privateMessages',
  'estimate',
  'estimateNotes',
  'cost',
  'margin',
  'staffEvaluation',
  'staffReview',
  'securityMetadata',
  'hiddenCustomFields',
  'unreleasedVersions',
  'internalFileKey',
  'storageKey',
  // FILE-001 named the key `objectKey` and the provider's handle `providerUploadId`; a net
  // that names only the older spelling catches neither (found by the review of FILE-001).
  'objectKey',
  'providerUploadId',
  'otherClientIdentities',
  // 52-04 (R15-a): sell and cost rates reach a client only as an invoice line's unit price.
  'hourlyCostMinor',
  'costSnapshotMinor',
  'rateSnapshotMinor',
  'hourlyMinor',
];

const FORBIDDEN_SET: ReadonlySet<string> = new Set(FORBIDDEN_CLIENT_FIELDS);

/**
 * Recursively find any forbidden key in a payload about to be sent to a client.
 *
 * Returns the dotted paths of every offending key so a failure names all of them at once.
 */
export function findForbiddenClientFields(payload: unknown, path = ''): readonly string[] {
  if (payload === null || typeof payload !== 'object') return [];

  if (Array.isArray(payload)) {
    return payload.flatMap((item, i) => findForbiddenClientFields(item, `${path}[${i}]`));
  }

  const found: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_SET.has(key)) found.push(here);
    found.push(...findForbiddenClientFields(value, here));
  }
  return found;
}
