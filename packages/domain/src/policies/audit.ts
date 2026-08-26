/**
 * The audit vocabulary and the safe-metadata rule — AUD-001.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC` §12 is one paragraph and it does two separate
 * things. It lists the decisions that *must* leave an audit record, and it constrains what
 * such a record may contain:
 *
 *   "Role changes, invitations, external publish, approval decision/invalidation, restricted
 *    export download, client membership change, policy change, offboarding, export,
 *    API/webhook credentials, admin impersonation, cross-tenant support action, and any
 *    emergency database procedure require audit. Denied sensitive attempts are security
 *    events with safe metadata."
 *
 * This file is where both halves become code rather than intention.
 *
 * ## Why the action vocabulary is closed
 *
 * `audit_events.action` is a `VARCHAR(190)`, so the database would accept anything. A closed
 * union is the difference between an audit trail and a log: a query for "every role change in
 * this organization last quarter" is only answerable if every writer spelled the action the
 * same way, and the only reliable way to make writers agree is to make disagreement a
 * compile error. Adding an action is a deliberate edit here, in the file that also records
 * which §12 clause requires it.
 *
 * {@link AUDIT_ACTION_CATALOG} pairs each action with the object type it describes and the
 * clause that demands it. The object type is part of the definition rather than a free
 * parameter because `ix_audit_events_org_object` is `(organization_id, object_type,
 * object_id)` — an object type that varies by call site makes that index useless for the one
 * question it exists to answer, "what happened to this row".
 *
 * ## Why the metadata rule is a refusal rather than a convention
 *
 * §12's "safe metadata" and `24-EVENT-CATALOG` §1's "Secrets, full message bodies, raw file
 * content, and unnecessary personal data are forbidden" are the same requirement stated
 * twice. Both are easy to satisfy on the day the writer is reviewed and easy to lose six
 * months later, when someone adds `reason` to a metadata object and a user's sentence ends up
 * in an append-only table that no credential in this system is permitted to amend.
 *
 * So {@link assertSafeAuditMetadata} refuses. It admits identifiers and classifications —
 * UUIDs, slugs, enum members, counts, flags — and nothing that looks like prose. The
 * denylist of key names is the second line, not the first: the value shape is what actually
 * stops a message body, because a message body cannot be spelled with the permitted
 * character set at the permitted length whatever the key is called.
 *
 * This is deliberately *not* `findForbiddenClientFields` from `audience.ts`. That function
 * answers a different question — "may a client see this payload" — against camelCase domain
 * fields, and it is a search that reports rather than a gate that refuses. Reusing it here
 * would couple two rules that are allowed to change independently.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the `result` enum in `0002_platform_primitives.sql`.
 *
 * `denied` is the case §12's last sentence is about, and it is a *result* rather than a
 * separate action on purpose: the interesting security question is "who tried to do this and
 * was refused", which is only answerable if the attempt and the success share an action name.
 */
export const AUDIT_RESULTS = ['allowed', 'denied', 'error'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditActionDefinition {
  /** The row kind this action describes. Fixed per action — see the note at the top. */
  readonly objectType: string;
  /** The §12 clause that requires it, quoted closely enough to be found by search. */
  readonly clause: string;
}

/**
 * A note on a field that is deliberately **not** here.
 *
 * A first draft gave each action a `deniedAttemptIsSecurityEvent` flag, meaning "a refused
 * attempt at this is itself worth an audit row". It was removed before it shipped, because
 * its polarity could not be made coherent for `security.capability_denied` — an action whose
 * only legal result *is* `denied`, and for which "was the denial denied" is not a question.
 * Nothing in the application consumed it either; the decision about which refusals to record
 * currently lives in `CapabilityGuard`, which is where the facts to make it are.
 *
 * When a second producer needs that decision, it should arrive as a rule with one meaning
 * rather than as a boolean that means something different for one member of the set.
 */

/**
 * Every action this system may write today, and why.
 *
 * The list is shorter than §12's, and the gap is honest rather than accidental: an action is
 * added when the code that writes it exists. Approvals, publication, exports and webhook
 * credentials have no implementation yet, so naming them here would create a vocabulary whose
 * members no query could ever return, and a reader could not tell "never happened" from
 * "never built".
 */
export const AUDIT_ACTION_CATALOG = {
  /**
   * TEN-001's provisioning transaction.
   *
   * The first row an organization ever has, and the only audit row whose `organization_id`
   * names a row created in the same transaction. §12 lists "organization settings" among the
   * changes that must be recorded, and there is no settings change more consequential than
   * the one that decides who owns the organization in the first place.
   */
  'organization.provisioned': {
    objectType: 'organization',
    clause: '§12 organization settings — the founding grant is the first and largest of them',
  },
  /**
   * PROJ-002. A project is the container every later object lives in — work items,
   * deliverables, approvals, the client's whole view — so "who created this project, and
   * when" is the first question any later investigation of its contents has to answer.
   */
  'project.created': {
    objectType: 'project',
    clause: '§12 organization settings — a project is the unit every later object belongs to',
  },
  'project_membership.granted': {
    objectType: 'project_membership',
    clause: '§12 role changes — a project grant is the narrowest role change in the system',
  },
  'project_membership.role_changed': {
    objectType: 'project_membership',
    clause: '§12 role changes',
  },
  /**
   * The one that closes a gap recorded in code rather than in a document.
   * `ProjectMembershipsRepository.remove()` is a real `DELETE` — the only one in this
   * codebase — and the note above it says that trade "only holds if the revocation is
   * recorded somewhere else, and today it is not". This is somewhere else.
   */
  'project_membership.revoked': {
    objectType: 'project_membership',
    clause: '§12 role changes — the grant is erased, so the revocation is the only record',
  },
  'security.capability_denied': {
    objectType: 'capability',
    // Recorded as `denied`, never as `allowed`; `AuditEventsRepository.append` refuses the
    // latter, because a row reading "this denial succeeded" describes nothing that happens.
    clause: '§12 "Denied sensitive attempts are security events with safe metadata"',
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTION_CATALOG;

export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_CATALOG) as readonly AuditAction[];

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_ACTION_CATALOG, value);
}

/** The object type an action describes. Callers never choose it. */
export function auditObjectTypeFor(action: AuditAction): string {
  return AUDIT_ACTION_CATALOG[action].objectType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe metadata
// ─────────────────────────────────────────────────────────────────────────────

export type AuditMetadataScalar = string | number | boolean | null;
export type AuditMetadataValue = AuditMetadataScalar | readonly AuditMetadataScalar[];
export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export class UnsafeAuditMetadataError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`Audit metadata is not safe to record: ${violations.join('; ')}`);
    this.name = 'UnsafeAuditMetadataError';
  }
}

/** Limits, in one place so a change to any of them is visible as a change to the rule. */
const MAX_KEYS = 20;
const MAX_KEY_LENGTH = 40;
const MAX_VALUE_LENGTH = 64;
const MAX_ARRAY_LENGTH = 20;

/** `snake_case`, matching the column names these values describe. */
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Identifiers and classifications only.
 *
 * Letters, digits, and the four separators that appear in the identifiers this system
 * actually produces: `.` in an action name, `_` in an enum member, `-` in a UUID or slug, `:`
 * in a prefixed key. No space, so a sentence cannot pass; no `@`, so an address cannot; no
 * `/`, so a path or a URL cannot.
 */
const VALUE_PATTERN = /^[A-Za-z0-9._:-]*$/;

/**
 * Key names refused outright.
 *
 * This is the second line of defence — the value rules above already stop prose — and it
 * exists for the case where a short value is nonetheless disclosive: a six-character password
 * satisfies every shape rule in this file.
 *
 * Matched against the key's underscore-separated **segments**, singular or plural, rather
 * than as substrings. Substring matching was the first attempt and it was wrong in a way
 * worth recording: `ip` appears inside `membership`, so `membership_id` — the single most
 * common legitimate key this system will ever write — would have been refused. A denylist
 * that rejects the ordinary case gets deleted rather than fixed.
 *
 * Segment matching still costs a word occasionally, and one such collision is real and was
 * found by AUD-001's own first producer rather than by review. `subject` is here because an
 * email subject line is content; `subject_user_id` — the person an action was taken *upon* —
 * is not content at all, and it is the natural name for it. The resolution was to rename the
 * key to `target_user_id` rather than to admit `subject`, because the denylist is cheap to
 * work around and expensive to re-tighten: a rule relaxed once for a good reason is a rule
 * the next person relaxes for a worse one.
 */
const FORBIDDEN_KEY_SEGMENTS: readonly string[] = [
  'body',
  'content',
  'text',
  'message',
  'comment',
  'note',
  'reason',
  'rationale',
  'description',
  'subject',
  'title',
  'password',
  'secret',
  'token',
  'credential',
  'signature',
  'email',
  'phone',
  'address',
  'ip',
  'agent',
  'payload',
];

const FORBIDDEN_SEGMENT_SET: ReadonlySet<string> = new Set(
  // Both the singular and the plural, so `note` also refuses `notes`. Spelled out here
  // rather than by stripping a trailing `s` at match time, because that heuristic would
  // also turn `status` into `statu` and make the set's membership unreadable.
  FORBIDDEN_KEY_SEGMENTS.flatMap((segment) => [segment, `${segment}s`]),
);

function forbiddenSegment(key: string): string | undefined {
  return key.split('_').find((segment) => FORBIDDEN_SEGMENT_SET.has(segment));
}

/**
 * Refuse anything that is not identifiers and classifications.
 *
 * Reports every violation rather than the first, because a writer fixing metadata wants the
 * whole list; a rule that reveals its objections one round trip at a time gets worked around.
 */
export function assertSafeAuditMetadata(metadata: unknown): asserts metadata is AuditMetadata {
  const violations: string[] = [];

  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new UnsafeAuditMetadataError(['metadata must be a plain object']);
  }

  const entries = Object.entries(metadata);
  if (entries.length > MAX_KEYS) {
    violations.push(`metadata has ${entries.length} keys; the limit is ${MAX_KEYS}`);
  }

  for (const [key, value] of entries) {
    if (key.length > MAX_KEY_LENGTH) {
      violations.push(`key '${key}' is longer than ${MAX_KEY_LENGTH} characters`);
    }
    if (!KEY_PATTERN.test(key)) {
      violations.push(`key '${key}' is not snake_case`);
    }
    const forbidden = forbiddenSegment(key);
    if (forbidden !== undefined) {
      violations.push(`key '${key}' names '${forbidden}', which is content rather than a fact`);
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) {
        violations.push(
          `key '${key}' holds ${value.length} items; the limit is ${MAX_ARRAY_LENGTH}`,
        );
      }
      value.forEach((item, index) => {
        violations.push(...scalarViolations(`${key}[${index}]`, item));
      });
      continue;
    }

    violations.push(...scalarViolations(key, value));
  }

  if (violations.length > 0) throw new UnsafeAuditMetadataError(violations);
}

function scalarViolations(label: string, value: unknown): readonly string[] {
  if (value === null || typeof value === 'boolean') return [];

  if (typeof value === 'number') {
    // `NaN` and the infinities serialise to `null` in JSON, so a metric recorded as one would
    // read back as "absent" rather than as "wrong" — the worse of the two failures.
    return Number.isFinite(value) ? [] : [`'${label}' is not a finite number`];
  }

  if (typeof value === 'string') {
    const problems: string[] = [];
    if (value.length > MAX_VALUE_LENGTH) {
      problems.push(`'${label}' is longer than ${MAX_VALUE_LENGTH} characters`);
    }
    if (!VALUE_PATTERN.test(value)) {
      // The value itself is not quoted back. It is the thing under suspicion of being
      // content, and an error message is a place content leaks to just as readily.
      problems.push(`'${label}' contains characters outside identifiers and classifications`);
    }
    return problems;
  }

  return [`'${label}' is a ${typeof value}; only strings, numbers, booleans and null are safe`];
}

/**
 * The non-throwing form, for a caller that must not fail the operation it is describing.
 *
 * The exception filter is the reason this exists: a denial has already been decided by the
 * time it writes an audit row, and throwing there would turn a 403 into a 500 — telling the
 * caller *more* because the server tried to record that it told them less.
 */
export function isSafeAuditMetadata(metadata: unknown): metadata is AuditMetadata {
  try {
    assertSafeAuditMetadata(metadata);
    return true;
  } catch {
    return false;
  }
}
