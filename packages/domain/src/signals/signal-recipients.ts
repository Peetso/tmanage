import { hasCapability } from '../policies/capabilities.js';
import type { Capability, PrincipalRole } from '../policies/capabilities.js';
import { SIGNAL_FINANCE_CAPABILITY, SIGNAL_RULES } from './signal-catalog.js';
import type { SignalRecipient, SignalRuleKey } from './signal-catalog.js';

/**
 * Who hears one signal — decided at delivery from the *current* active internal memberships
 * (`24-EVENT-CATALOG` §6), never from who could see the subject when the signal was raised.
 *
 * - **Project lead**: a member of the subject's project who holds `project.manage` there. An
 *   org-wide holder (owner, admin) is not a lead of every project; "Owner" is its own choice.
 * - **Their manager**: the reporting-line manager of the person the signal is about (the
 *   overloaded person, or the assignee of a work item).
 * - **Assignee**: the work item's owner.
 * - **Owner**: an organization-wide owner.
 * - **Finance team**: holds `finance.view`, org-wide or on the subject's project.
 *
 * A choice that names nobody (no manager on file, no assignee) falls back to the project lead,
 * then to the owner, so a signal is never told to no one. A money rule tells **only**
 * `finance.view` holders, whatever the choice says (FIGMA-D fix 23).
 */

export interface SignalRecipientCandidate {
  readonly userId: string;
  readonly membershipId: string;
  /** The resolved principal role; null holds nothing. */
  readonly role: PrincipalRole | null;
  readonly hasOrgWideScope: boolean;
  /** Holds a project membership on the subject's project. */
  readonly onProject: boolean;
}

export interface SignalSubjectPeople {
  readonly projectId: string | null;
  readonly assigneeUserId: string | null;
  /** The membership id of the manager of the person the signal is about. */
  readonly managerMembershipId: string | null;
}

type Chooser = (
  candidates: readonly SignalRecipientCandidate[],
) => readonly SignalRecipientCandidate[];

function holds(candidate: SignalRecipientCandidate, capability: Capability): boolean {
  return candidate.role !== null && hasCapability(candidate.role, capability);
}

function pickers(subject: SignalSubjectPeople): Readonly<Record<SignalRecipient, Chooser>> {
  const inScope = (c: SignalRecipientCandidate) =>
    c.hasOrgWideScope || subject.projectId === null || c.onProject;
  const leads: Chooser = (all) =>
    subject.projectId === null ? [] : all.filter((c) => c.onProject && holds(c, 'project.manage'));
  const owners: Chooser = (all) => all.filter((c) => c.role === 'owner' && c.hasOrgWideScope);
  const finance: Chooser = (all) =>
    all.filter((c) => holds(c, SIGNAL_FINANCE_CAPABILITY) && inScope(c));
  return {
    project_lead: leads,
    owner: owners,
    their_manager: (all) => all.filter((c) => c.membershipId === subject.managerMembershipId),
    assignee: (all) => all.filter((c) => c.userId === subject.assigneeUserId),
    project_lead_and_owner: (all) => [...leads(all), ...owners(all)],
    finance_team: finance,
    owner_and_finance_team: (all) => [...owners(all), ...finance(all)],
  };
}

/** The user ids to tell, each once, in candidate order. */
export function signalRecipients(
  rule: SignalRuleKey,
  recipient: SignalRecipient,
  subject: SignalSubjectPeople,
  candidates: readonly SignalRecipientCandidate[],
): readonly string[] {
  const pick = pickers(subject);
  const money = SIGNAL_RULES[rule].money;
  const allowed = money
    ? candidates.filter((c) => holds(c, SIGNAL_FINANCE_CAPABILITY))
    : candidates;
  const chain: readonly SignalRecipient[] = [recipient, 'project_lead', 'owner'];
  for (const choice of chain) {
    const chosen = pick[choice](allowed);
    if (chosen.length > 0) return [...new Set(chosen.map((c) => c.userId))];
  }
  return [];
}
