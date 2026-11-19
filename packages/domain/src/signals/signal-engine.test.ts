import { describe, expect, it } from 'vitest';
import { capabilitiesFor, customRoleKey } from '../policies/capabilities.js';
import { SIGNAL_RULES, SIGNAL_RULE_KEYS, signalRulesVisibleTo } from './signal-catalog.js';
import { mayRaiseSignal, signalDay } from './signal-finding.js';
import { parseSignalSettingsInput, resolveSignalSettings } from './signal-settings.js';
import { signalRecipients } from './signal-recipients.js';
import type { SignalRecipientCandidate } from './signal-recipients.js';

const NOW = new Date('2026-11-19T23:30:00.000Z');
const HOUR = 3_600_000;

describe('catalogue', () => {
  it('money rules reach the finance team only: one fixed recipient each', () => {
    const money = SIGNAL_RULE_KEYS.filter((key) => SIGNAL_RULES[key].money);
    expect(money).toEqual([
      'overdue_invoice',
      'project_over_budget',
      'unusual_expense',
      'approved_time_not_invoiced',
    ]);
    for (const key of money) expect(SIGNAL_RULES[key].recipients).toHaveLength(1);
    expect(SIGNAL_RULES.project_over_budget.defaultRecipient).toBe('owner_and_finance_team');
  });

  it('every default sits inside its limits and among its choices', () => {
    for (const key of SIGNAL_RULE_KEYS) {
      const { threshold, recipients, defaultRecipient } = SIGNAL_RULES[key];
      expect(threshold.defaultValue).toBeGreaterThanOrEqual(threshold.min);
      expect(threshold.defaultValue).toBeLessThanOrEqual(threshold.max);
      expect(recipients).toContain(defaultRecipient);
    }
  });

  it('the finance rules are hidden without finance.view', () => {
    const member = signalRulesVisibleTo(capabilitiesFor('member')).map((rule) => rule.key);
    expect(member).not.toContain('approved_time_not_invoiced');
    expect(member).not.toContain('overdue_invoice');
    expect(member).toContain('stale_task');
    const owner = signalRulesVisibleTo(capabilitiesFor('owner')).map((rule) => rule.key);
    expect(owner).toEqual([...SIGNAL_RULE_KEYS]);
  });
});

describe('dedupe', () => {
  it('one signal per subject per 24 h, also across midnight', () => {
    expect(mayRaiseSignal(null, NOW)).toBe(true);
    expect(mayRaiseSignal(new Date(NOW.getTime() - 2 * HOUR), NOW)).toBe(false);
    expect(mayRaiseSignal(new Date(NOW.getTime() - 24 * HOUR + 1), NOW)).toBe(false);
    expect(mayRaiseSignal(new Date(NOW.getTime() - 24 * HOUR), NOW)).toBe(true);
  });

  it('a signal is filed under its UTC day (part of the unique key)', () => {
    expect(signalDay(NOW)).toBe('2026-11-19');
  });
});

describe('settings', () => {
  it('a rule without a row runs on its defaults, on', () => {
    expect(resolveSignalSettings([]).stale_task).toEqual({
      rule: 'stale_task',
      enabled: true,
      threshold: 14,
      recipient: 'assignee',
    });
  });

  it('a stored row wins field by field; a value off the catalogue falls back', () => {
    const resolved = resolveSignalSettings([
      { rule: 'stale_task', enabled: false, threshold: 30, recipient: 'owner' },
      { rule: 'overdue_invoice', enabled: true, threshold: 999, recipient: 'assignee' },
      { rule: 'not_a_rule', enabled: false, threshold: 1, recipient: 'owner' },
    ]);
    expect(resolved.stale_task).toMatchObject({
      enabled: false,
      threshold: 30,
      recipient: 'owner',
    });
    expect(resolved.overdue_invoice).toMatchObject({ threshold: 7, recipient: 'finance_team' });
  });

  it('parses a valid save', () => {
    const parsed = parseSignalSettingsInput({
      rules: [{ rule: 'deadline_at_risk', enabled: false, threshold: 30, recipient: 'owner' }],
    });
    expect(parsed).toEqual({
      ok: true,
      settings: [{ rule: 'deadline_at_risk', enabled: false, threshold: 30, recipient: 'owner' }],
    });
  });

  it('refuses the whole save on any bad field: limits, unit choices, money recipient, repeats', () => {
    const bad = parseSignalSettingsInput({
      rules: [
        { rule: 'deadline_at_risk', enabled: true, threshold: 31, recipient: 'owner' },
        { rule: 'overdue_invoice', enabled: true, threshold: 7, recipient: 'project_lead' },
        { rule: 'stale_task', enabled: 'yes', threshold: 2.5, recipient: 'owner' },
        { rule: 'stale_task', enabled: true, threshold: 14, recipient: 'owner' },
        { rule: 'nope', enabled: true, threshold: 1, recipient: 'owner' },
      ],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.map((issue) => issue.field)).toEqual([
      'rules[0].threshold',
      'rules[1].recipient',
      'rules[2].enabled',
      'rules[2].threshold',
      'rules[3].rule',
      'rules[4].rule',
    ]);
    expect(parseSignalSettingsInput({ rules: [] }).ok).toBe(false);
    expect(parseSignalSettingsInput(null).ok).toBe(false);
  });
});

describe('recipients', () => {
  const person = (
    userId: string,
    role: SignalRecipientCandidate['role'],
    extra: Partial<SignalRecipientCandidate> = {},
  ): SignalRecipientCandidate => ({
    userId,
    membershipId: `m-${userId}`,
    role,
    hasOrgWideScope: false,
    onProject: false,
    ...extra,
  });
  const owner = person('owner', 'owner', { hasOrgWideScope: true });
  // A project lead whose custom role has no finance access (FIGMA-D fix 23).
  const leadRole = customRoleKey('00000000-0000-4000-8000-000000000001', [
    'project.manage',
    'work.read',
  ]);
  const lead = person('lead', leadRole, { onProject: true });
  const otherLead = person('other-lead', 'manager');
  const doer = person('doer', 'member', { onProject: true });
  const boss = person('boss', 'manager');
  const all = [owner, lead, otherLead, doer, boss];
  const subject = { projectId: 'p1', assigneeUserId: 'doer', managerMembershipId: 'm-boss' };

  it('each choice names its people', () => {
    expect(signalRecipients('stale_task', 'assignee', subject, all)).toEqual(['doer']);
    expect(signalRecipients('stale_task', 'their_manager', subject, all)).toEqual(['boss']);
    expect(signalRecipients('stale_task', 'project_lead', subject, all)).toEqual(['lead']);
    expect(signalRecipients('stale_task', 'owner', subject, all)).toEqual(['owner']);
    expect(signalRecipients('stale_task', 'project_lead_and_owner', subject, all)).toEqual([
      'lead',
      'owner',
    ]);
  });

  it('a choice that names nobody falls back to the project lead, then the owner', () => {
    const nobody = { projectId: 'p1', assigneeUserId: null, managerMembershipId: null };
    expect(signalRecipients('stale_task', 'assignee', nobody, all)).toEqual(['lead']);
    const noProject = { projectId: null, assigneeUserId: null, managerMembershipId: null };
    expect(signalRecipients('overloaded_person', 'their_manager', noProject, all)).toEqual([
      'owner',
    ]);
  });

  it('money rules tell finance.view holders only — a lead without finance access is not told', () => {
    expect(signalRecipients('project_over_budget', 'owner_and_finance_team', subject, all)).toEqual(
      ['owner'],
    );
    const financeLead = person('finance-lead', 'org_admin', { onProject: true });
    const told = signalRecipients('overdue_invoice', 'finance_team', subject, [
      ...all,
      financeLead,
    ]);
    expect(told).toEqual(['owner', 'finance-lead']);
    expect(told).not.toContain('lead');
  });
});
