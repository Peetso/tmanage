import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_CATALOG,
  AUDIT_RESULTS,
  UnsafeAuditMetadataError,
  assertSafeAuditMetadata,
  auditObjectTypeFor,
  isAuditAction,
  isSafeAuditMetadata,
} from './audit.js';

/**
 * The metadata rule is the half of AUD-001 worth testing hardest.
 *
 * The vocabulary is a table and a lookup; a test can confirm it is internally consistent and
 * little else. `assertSafeAuditMetadata` is a gate that stands between a caller's object and
 * an append-only table that no credential in this system may amend, so the cases below are
 * written as attempts to get content past it rather than as a demonstration that valid input
 * is accepted.
 */

const violationsOf = (metadata: unknown): readonly string[] => {
  try {
    assertSafeAuditMetadata(metadata);
    return [];
  } catch (error) {
    if (error instanceof UnsafeAuditMetadataError) return error.violations;
    throw error;
  }
};

describe('the action vocabulary', () => {
  it('gives every action an object type and a clause', () => {
    for (const action of AUDIT_ACTIONS) {
      const definition = AUDIT_ACTION_CATALOG[action];
      expect(definition.objectType.length).toBeGreaterThan(0);
      // `audit_events.object_type` is VARCHAR(64); a longer value would be silently
      // truncated under a non-strict mode and refused under a strict one.
      expect(definition.objectType.length).toBeLessThanOrEqual(64);
      expect(definition.clause).toContain('§12');
    }
  });

  it('keeps every action within the action column', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action.length).toBeLessThanOrEqual(190);
    }
  });

  it('names actions as object.past_tense_verb', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });

  it('recognises its own members and nothing else', () => {
    for (const action of AUDIT_ACTIONS) expect(isAuditAction(action)).toBe(true);
    expect(isAuditAction('project_membership.exploded')).toBe(false);
    expect(isAuditAction('')).toBe(false);
    // `Object.hasOwn` rather than `in`, so an inherited property is not mistaken for a member.
    expect(isAuditAction('toString')).toBe(false);
    expect(isAuditAction('constructor')).toBe(false);
  });

  it('fixes the object type per action rather than letting a caller choose', () => {
    expect(auditObjectTypeFor('project_membership.revoked')).toBe('project_membership');
    expect(auditObjectTypeFor('project_membership.granted')).toBe('project_membership');
    expect(auditObjectTypeFor('security.capability_denied')).toBe('capability');
  });

  it('matches the result enum in 0002_platform_primitives.sql', () => {
    expect([...AUDIT_RESULTS]).toEqual(['allowed', 'denied', 'error']);
  });
});

describe('safe metadata — what is admitted', () => {
  it('accepts identifiers, classifications, counts and flags', () => {
    const metadata = {
      project_membership_id: '019890ab-cdef-7123-8456-789abcdef012',
      project_id: '019890ab-cdef-7123-8456-789abcdef013',
      previous_role: 'contributor',
      new_role: 'project_manager',
      removed_row_count: 1,
      was_already_absent: false,
      client_organization_id: null,
    };
    expect(() => assertSafeAuditMetadata(metadata)).not.toThrow();
    expect(isSafeAuditMetadata(metadata)).toBe(true);
  });

  it('accepts an empty object — an action can be its own whole story', () => {
    expect(() => assertSafeAuditMetadata({})).not.toThrow();
  });

  it('accepts a short list of identifiers', () => {
    expect(() =>
      assertSafeAuditMetadata({
        affected_user_ids: [
          '019890ab-cdef-7123-8456-789abcdef012',
          '019890ab-cdef-7123-8456-789abcdef013',
        ],
      }),
    ).not.toThrow();
  });

  it('refuses subject_user_id and admits target_user_id, which is the same fact', () => {
    // Not a curiosity: AUD-001's first producer was written with `subject_user_id` and the
    // database suite refused it. The key was renamed rather than the denylist relaxed — see
    // the note above FORBIDDEN_KEY_SEGMENTS. This case exists so a future reader finds the
    // decision rather than rediscovering the collision.
    expect(violationsOf({ subject_user_id: '019890ab-cdef-7123-8456-789abcdef012' })).toEqual([
      "key 'subject_user_id' names 'subject', which is content rather than a fact",
    ]);
    expect(violationsOf({ target_user_id: '019890ab-cdef-7123-8456-789abcdef012' })).toEqual([]);
  });

  it('accepts a key that merely contains a forbidden fragment inside a word', () => {
    // The regression this test exists for: substring matching refused `membership_id`,
    // because `membership` contains `ip`. Segment matching does not.
    expect(() =>
      assertSafeAuditMetadata({
        membership_id: '019890ab-cdef-7123-8456-789abcdef012',
        project_membership_id: '019890ab-cdef-7123-8456-789abcdef013',
        // `context` contains `text`; `notice` contains `note`.
        context_kind: 'internal',
        notice_kind: 'quiet',
      }),
    ).not.toThrow();
  });
});

describe('safe metadata — what is refused', () => {
  it('refuses anything that is not a plain object', () => {
    expect(violationsOf(null)).toEqual(['metadata must be a plain object']);
    expect(violationsOf('anything')).toEqual(['metadata must be a plain object']);
    expect(violationsOf([{ a: 'b' }])).toEqual(['metadata must be a plain object']);
    expect(violationsOf(42)).toEqual(['metadata must be a plain object']);
  });

  it('refuses a sentence, which is what a message body looks like', () => {
    const violations = violationsOf({
      reason: 'Removed because the client complained about Jane on Tuesday',
    });
    // Two independent rules catch it: the key names content, and the value is prose.
    expect(violations).toHaveLength(2);
    expect(violations.join(' ')).toContain('is content rather than a fact');
    expect(violations.join(' ')).toContain('outside identifiers and classifications');
  });

  it('refuses prose even under an innocuous key', () => {
    // The value rule alone must be sufficient — the denylist is the second line, not the
    // first, and a writer who renames the key must not thereby get past the gate.
    expect(violationsOf({ detail: 'the client asked for this to be undone' })).toEqual([
      "'detail' contains characters outside identifiers and classifications",
    ]);
  });

  it('refuses an address, because it is short enough to pass every length rule', () => {
    expect(violationsOf({ actor: 'jane@example.com' })).toEqual([
      "'actor' contains characters outside identifiers and classifications",
    ]);
  });

  it('refuses a key that names content however short its value', () => {
    expect(violationsOf({ password: 'hunter2' })).toEqual([
      "key 'password' names 'password', which is content rather than a fact",
    ]);
    expect(violationsOf({ user_email: 'x' })).toEqual([
      "key 'user_email' names 'email', which is content rather than a fact",
    ]);
    expect(violationsOf({ internal_notes: 'x' })).toEqual([
      "key 'internal_notes' names 'notes', which is content rather than a fact",
    ]);
    expect(violationsOf({ user_agent: 'x' })).toEqual([
      "key 'user_agent' names 'agent', which is content rather than a fact",
    ]);
  });

  it('never quotes the suspect value back in the violation', () => {
    const secret = 'correct horse battery staple';
    for (const violation of violationsOf({ detail: secret })) {
      expect(violation).not.toContain(secret);
      expect(violation).not.toContain('horse');
    }
  });

  it('refuses a value longer than an identifier', () => {
    expect(violationsOf({ slug: 'a'.repeat(65) })).toEqual(["'slug' is longer than 64 characters"]);
    expect(violationsOf({ slug: 'a'.repeat(64) })).toEqual([]);
  });

  it('refuses a nested object, which is where a payload hides', () => {
    expect(violationsOf({ before: { role: 'owner' } })).toEqual([
      "'before' is a object; only strings, numbers, booleans and null are safe",
    ]);
  });

  it('refuses a nested object inside an array', () => {
    expect(violationsOf({ changes: [{ role: 'owner' }] })).toEqual([
      "'changes[0]' is a object; only strings, numbers, booleans and null are safe",
    ]);
  });

  it('refuses undefined, which JSON would silently drop', () => {
    expect(violationsOf({ project_id: undefined })).toEqual([
      "'project_id' is a undefined; only strings, numbers, booleans and null are safe",
    ]);
  });

  it('refuses a non-finite number, which JSON turns into null', () => {
    expect(violationsOf({ elapsed_ms: Number.NaN })).toEqual([
      "'elapsed_ms' is not a finite number",
    ]);
    expect(violationsOf({ elapsed_ms: Number.POSITIVE_INFINITY })).toEqual([
      "'elapsed_ms' is not a finite number",
    ]);
  });

  it('refuses a key that is not snake_case', () => {
    expect(violationsOf({ projectId: 'x' })).toEqual(["key 'projectId' is not snake_case"]);
    expect(violationsOf({ 'project-id': 'x' })).toEqual(["key 'project-id' is not snake_case"]);
    expect(violationsOf({ '': 'x' })).toEqual(["key '' is not snake_case"]);
  });

  it('bounds the object and its arrays', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`key_${index}`, 'value']),
    );
    expect(violationsOf(wide)).toEqual(['metadata has 21 keys; the limit is 20']);

    const long = { user_ids: Array.from({ length: 21 }, () => 'a') };
    expect(violationsOf(long)).toEqual(["key 'user_ids' holds 21 items; the limit is 20"]);
  });

  it('reports every violation at once rather than the first', () => {
    const violations = violationsOf({
      projectId: 'x',
      detail: 'a whole sentence about a person',
      depth: { nested: true },
    });
    expect(violations).toHaveLength(3);
  });

  it('agrees with its non-throwing form', () => {
    const cases: readonly unknown[] = [
      {},
      { a_b: 'c' },
      { detail: 'a sentence' },
      null,
      { nested: {} },
    ];
    for (const value of cases) {
      expect(isSafeAuditMetadata(value)).toBe(violationsOf(value).length === 0);
    }
  });
});

describe('the vocabulary and the metadata rule together', () => {
  it('lets every catalogued action be written with only safe metadata', () => {
    // A cheap consistency check with real value: it fails if an action is added whose
    // object type would not survive the column, or whose name breaks the naming rule the
    // repository relies on when it splits an action for reporting.
    for (const action of AUDIT_ACTIONS) {
      expect(() =>
        assertSafeAuditMetadata({
          action_recorded: action,
          object_type: auditObjectTypeFor(action),
        }),
      ).not.toThrow();
    }
  });
});
