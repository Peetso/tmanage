import { describe, expect, it } from 'vitest';
import { effectiveCapabilitySet } from '../authorize.js';
import {
  AI_EMPLOYEE_CAPABILITIES,
  ASSIGNABLE_INTERNAL_ROLES,
  CAPABILITIES,
  INTERNAL_ROLES,
  CLIENT_ROLES,
  capabilitySetFor,
  customRoleKey,
  hasCapability,
  isInternalOnlyCapability,
  type Capability,
} from '../capabilities.js';
import {
  AI_ALLOWED_CAPABILITIES,
  AI_CAPABILITY_CLASS,
  aiAdminCapabilitiesIn,
  aiEffectiveCapabilities,
  aiRoleDecision,
} from './ceiling.js';
import { AI_REFUSED_DOORS, mayPassDoor } from './doors.js';
import {
  AI_EMPLOYEE_EMAIL_DOMAIN,
  aiEmployeeEmail,
  isAiEmployeeEmail,
  isAiMembershipKind,
  parseMembershipKind,
} from './kind.js';
import {
  aiEmployeeMayWork,
  aiEmployeeStateMachine,
  parseAiEmployeePauseReason,
  parseAiEmployeeStatus,
} from './lifecycle.js';
import {
  AI_EMPLOYEE_LIMIT_CAPS,
  AI_EMPLOYEE_LIMIT_DEFAULTS,
  isWithinWorkingHours,
  parseAiEmployeeLimits,
  parseWorkingHours,
  readStoredAiEmployeeLimits,
} from './limits.js';

const ROLE_ID = '0199aa00-0000-7000-8000-0000000000e1';
const USER_ID = '0199aa00-0000-7000-8000-0000000000e2';

describe('60-01 capabilities', () => {
  it('appends the three AI-employee capabilities at the end, internal-only', () => {
    expect(CAPABILITIES.slice(-3)).toEqual([...AI_EMPLOYEE_CAPABILITIES]);
    for (const capability of AI_EMPLOYEE_CAPABILITIES) {
      expect(isInternalOnlyCapability(capability)).toBe(true);
      for (const role of CLIENT_ROLES) expect(hasCapability(role, capability)).toBe(false);
    }
  });

  it('hire = owner and admins; assign and briefs = manager and above (open question 2)', () => {
    const hire = new Set(['owner', 'org_admin', 'workspace_admin', 'platform_support']);
    const assign = new Set([...hire, 'manager']);
    for (const role of INTERNAL_ROLES) {
      expect(hasCapability(role, 'ai_employee.manage'), role).toBe(hire.has(role));
      expect(hasCapability(role, 'ai_employee.assign'), role).toBe(assign.has(role));
      expect(hasCapability(role, 'brief.manage'), role).toBe(assign.has(role));
    }
  });

  it('a custom-role key minted before 60-01 (15 nibbles) still decodes to its old set', () => {
    const full = customRoleKey(ROLE_ID, ['work.read', 'time.view_team']);
    const legacy = full.slice(0, -1);
    expect(legacy.split(':')[2]).toHaveLength(15);
    expect([...capabilitySetFor(legacy)].sort()).toEqual(['time.view_team', 'work.read']);
    expect(capabilitySetFor(customRoleKey(ROLE_ID, ['brief.manage'])).has('brief.manage')).toBe(
      true,
    );
  });
});

describe('60-01 AI ceiling (plan 60 v2 §4.6 step 5)', () => {
  it('classifies every capability exactly once', () => {
    expect(Object.keys(AI_CAPABILITY_CLASS).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('allows only the task reads and the contract writes', () => {
    expect(AI_ALLOWED_CAPABILITIES).toEqual([
      'conversation.read',
      'conversation.write',
      'work.read',
      'meeting.read',
      'doc.read',
      'deliverable.create',
      'approval.read',
      'file.upload',
      'file.download',
      'decision.read',
    ]);
  });

  it('never allows deciding, publishing, sending, deleting, exporting or administering', () => {
    const forbidden: Capability[] = [
      'approval.decide',
      'deliverable.publish',
      'deliverable.review',
      'org.manage',
      'roles.assign',
      'people.invite',
      'billing.manage',
      'finance.view',
      'ai.manage',
      'ai.use',
      'work.delete',
      'work.export',
      'file.delete',
      'audit.export',
      'ai_employee.manage',
      'ai_employee.assign',
      'brief.manage',
      'work.create',
    ];
    for (const capability of forbidden) expect(AI_ALLOWED_CAPABILITIES).not.toContain(capability);
  });

  it('refuses every built-in role except member and guest, and every client role', () => {
    for (const role of INTERNAL_ROLES) {
      const decision = aiRoleDecision(role);
      expect(decision.allowed, role).toBe(role === 'member' || role === 'guest');
      if (!decision.allowed) expect(decision.reason).toBe('admin_role');
    }
    for (const role of CLIENT_ROLES) {
      expect(aiRoleDecision(role)).toEqual({
        allowed: false,
        reason: 'not_internal',
        capabilities: [],
      });
    }
  });

  it('refuses a custom role with an admin capability and names it; accepts a plain one', () => {
    const admin = customRoleKey(ROLE_ID, ['work.read', 'roles.assign', 'billing.view']);
    expect(aiRoleDecision(admin)).toEqual({
      allowed: false,
      reason: 'admin_capabilities',
      capabilities: ['roles.assign', 'billing.view'],
    });
    const plain = customRoleKey(ROLE_ID, ['work.read', 'work.create', 'file.upload']);
    expect(aiRoleDecision(plain)).toEqual({ allowed: true });
    expect(aiAdminCapabilitiesIn(['approval.decide', 'approval.decide', 'work.read'])).toEqual([
      'approval.decide',
    ]);
  });

  it('never exceeds the sponsor, for every assignable sponsor role', () => {
    const ai = effectiveCapabilitySet({ role: 'member' });
    for (const sponsorRole of ASSIGNABLE_INTERNAL_ROLES) {
      const sponsor = effectiveCapabilitySet({ role: sponsorRole });
      const held = aiEffectiveCapabilities(ai, sponsor);
      for (const capability of held) {
        expect(sponsor.has(capability), `${sponsorRole} ${capability}`).toBe(true);
        expect(AI_ALLOWED_CAPABILITIES).toContain(capability);
        expect(ai.has(capability)).toBe(true);
      }
    }
  });

  it('narrows at once when the sponsor is demoted, and empties when the sponsor holds nothing', () => {
    const ai = effectiveCapabilitySet({ role: 'member' });
    const before = aiEffectiveCapabilities(ai, effectiveCapabilitySet({ role: 'member' }));
    expect(before.has('file.upload')).toBe(true);
    const demoted = effectiveCapabilitySet({ role: 'guest' });
    const after = aiEffectiveCapabilities(ai, demoted);
    expect(after.has('file.upload')).toBe(false);
    expect(after.has('work.read')).toBe(true);
    expect(aiEffectiveCapabilities(ai, new Set())).toEqual(new Set());
  });

  it('an allow override on the AI cannot lift it past the ceiling', () => {
    const ai = effectiveCapabilitySet({
      role: 'member',
      overrides: { allow: ['approval.decide', 'org.manage'], deny: [] },
    });
    const owner = effectiveCapabilitySet({ role: 'owner' });
    const held = aiEffectiveCapabilities(ai, owner);
    expect(held.has('approval.decide')).toBe(false);
    expect(held.has('org.manage')).toBe(false);
  });
});

describe('60-01 kind and doors (security test 1)', () => {
  it('reads only exact kinds', () => {
    expect(parseMembershipKind('human')).toBe('human');
    expect(parseMembershipKind('ai')).toBe('ai');
    for (const bad of ['AI', ' ai', '', null, undefined, 1]) {
      expect(parseMembershipKind(bad)).toBeNull();
    }
    expect(isAiMembershipKind('ai')).toBe(true);
    expect(isAiMembershipKind('human')).toBe(false);
  });

  it('refuses every door to ai and to an unreadable kind; a person passes', () => {
    for (const door of AI_REFUSED_DOORS) {
      expect(mayPassDoor('ai', door), door).toBe(false);
      expect(mayPassDoor('AI', door), door).toBe(false);
      expect(mayPassDoor(null, door), door).toBe(false);
      expect(mayPassDoor('human', door), door).toBe(true);
    }
  });

  it('gives an AI user an address on the reserved .invalid domain', () => {
    const email = aiEmployeeEmail(USER_ID);
    expect(email).toBe(`ai-${USER_ID}@${AI_EMPLOYEE_EMAIL_DOMAIN}`);
    expect(isAiEmployeeEmail(email)).toBe(true);
    expect(isAiEmployeeEmail('AI-x@AI-EMPLOYEE.INVALID')).toBe(true);
    expect(isAiEmployeeEmail('mat@example.com')).toBe(false);
    expect(isAiEmployeeEmail('ai-employee.invalid')).toBe(false);
    expect(() => aiEmployeeEmail('not-a-uuid')).toThrow();
  });
});

describe('60-01 lifecycle', () => {
  it('pauses with a reason, resumes only with an active sponsor, retires for good', () => {
    expect(aiEmployeeStateMachine.transition('active', 'paused').ok).toBe(false);
    expect(
      aiEmployeeStateMachine.transition('active', 'paused', { pausedReason: 'manual' }).ok,
    ).toBe(true);
    expect(aiEmployeeStateMachine.transition('paused', 'active')).toMatchObject({
      ok: false,
      reason: 'missing_requirement',
      missing: ['activeSponsor'],
    });
    expect(aiEmployeeStateMachine.transition('paused', 'active', { activeSponsor: true }).ok).toBe(
      true,
    );
    expect(
      aiEmployeeStateMachine.transition('paused', 'retired', { retiredByMembershipId: ROLE_ID }).ok,
    ).toBe(true);
    expect(aiEmployeeStateMachine.isTerminal('retired')).toBe(true);
    expect(
      aiEmployeeStateMachine.transition('retired', 'active', { activeSponsor: true }),
    ).toMatchObject({ ok: false, reason: 'illegal_transition' });
  });

  it('works only while active; parses stored values strictly', () => {
    expect(aiEmployeeMayWork('active')).toBe(true);
    expect(aiEmployeeMayWork('paused')).toBe(false);
    expect(aiEmployeeMayWork('retired')).toBe(false);
    expect(parseAiEmployeeStatus('paused')).toBe('paused');
    expect(parseAiEmployeeStatus('PAUSED')).toBeNull();
    expect(parseAiEmployeePauseReason('sponsor_left')).toBe('sponsor_left');
    expect(parseAiEmployeePauseReason('bored')).toBeNull();
  });
});

describe('60-01 limits (plan 60 v2 §4.9)', () => {
  it('defaults, lowering, and refusing a raise above the platform cap', () => {
    expect(parseAiEmployeeLimits(undefined)).toEqual({
      ok: true,
      limits: AI_EMPLOYEE_LIMIT_DEFAULTS,
    });
    const lowered = parseAiEmployeeLimits({ callsPerMinute: 10, revisionRounds: 6 });
    expect(lowered).toEqual({
      ok: true,
      limits: { ...AI_EMPLOYEE_LIMIT_DEFAULTS, callsPerMinute: 10, revisionRounds: 6 },
    });
    expect(parseAiEmployeeLimits({ callsPerMinute: 61 })).toEqual({
      ok: false,
      field: 'callsPerMinute',
      reason: 'above_cap',
    });
    expect(parseAiEmployeeLimits({ revisionRounds: 7 })).toMatchObject({ reason: 'above_cap' });
    expect(parseAiEmployeeLimits({ writesPerDay: 0 })).toMatchObject({ reason: 'below_one' });
    expect(parseAiEmployeeLimits({ writesPerDay: 1.5 })).toMatchObject({
      reason: 'not_a_whole_number',
    });
    expect(parseAiEmployeeLimits({ unlimited: true })).toMatchObject({ reason: 'unknown_field' });
    expect(parseAiEmployeeLimits([])).toMatchObject({ ok: false });
    for (const key of Object.keys(
      AI_EMPLOYEE_LIMIT_DEFAULTS,
    ) as (keyof typeof AI_EMPLOYEE_LIMIT_CAPS)[]) {
      expect(AI_EMPLOYEE_LIMIT_CAPS[key]).toBeGreaterThanOrEqual(AI_EMPLOYEE_LIMIT_DEFAULTS[key]);
    }
  });

  it('reads an unreadable stored value as the defaults, never as unlimited', () => {
    expect(readStoredAiEmployeeLimits(null)).toBe(AI_EMPLOYEE_LIMIT_DEFAULTS);
    expect(readStoredAiEmployeeLimits('{oops')).toBe(AI_EMPLOYEE_LIMIT_DEFAULTS);
    expect(readStoredAiEmployeeLimits('{"callsPerMinute":100000}')).toBe(
      AI_EMPLOYEE_LIMIT_DEFAULTS,
    );
    expect(readStoredAiEmployeeLimits('{"callsPerMinute":5}').callsPerMinute).toBe(5);
  });

  it('working hours: parse, refuse bad input, and answer by the employee time zone', () => {
    expect(parseWorkingHours({ timezone: 'Mars/Base' })).toEqual({ ok: false, reason: 'timezone' });
    expect(parseWorkingHours({ timezone: 'Asia/Riyadh', windows: [] })).toEqual({
      ok: false,
      reason: 'windows',
    });
    expect(
      parseWorkingHours({
        timezone: 'Asia/Riyadh',
        windows: [{ day: 1, start: '17:00', end: '09:00' }],
      }),
    ).toEqual({ ok: false, reason: 'windows' });
    const always = parseWorkingHours({ timezone: 'UTC', windows: null });
    expect(always.ok && isWithinWorkingHours(always.hours, new Date('2026-11-21T03:00:00Z'))).toBe(
      true,
    );
    const parsed = parseWorkingHours({
      timezone: 'Asia/Riyadh',
      windows: [{ day: 6, start: '09:00', end: '17:00' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 2026-11-21 is a Saturday. 06:00Z = 09:00 in Riyadh (UTC+3): inside. 05:59Z: before.
    expect(isWithinWorkingHours(parsed.hours, new Date('2026-11-21T06:00:00Z'))).toBe(true);
    expect(isWithinWorkingHours(parsed.hours, new Date('2026-11-21T05:59:00Z'))).toBe(false);
    expect(isWithinWorkingHours(parsed.hours, new Date('2026-11-21T14:00:00Z'))).toBe(false);
    expect(isWithinWorkingHours(parsed.hours, new Date('2026-11-22T07:00:00Z'))).toBe(false);
  });
});
