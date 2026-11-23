/**
 * AI action details — people (directory, capacity, availability, skills, teams, offboarding).
 *
 * Slice S4 (registry wave C). The `people` redaction profile keeps private contact details and
 * notes for the person themselves or their manager; deletes and offboarding are confirm-class.
 */
import { z } from 'zod';
import { MAX_WEEKS as HEATMAP_MAX_WEEKS } from '../../people/capacity-heatmap.service.js';
import { AVAILABILITY_KINDS } from '../../people/availability.controller.js';
import { det, queryArgs, listArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

/** A calendar day on the wire, `YYYY-MM-DD` (the people controllers' `ISO_DATE`). */
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');
// = common/database/schema.ts:PERSON_SKILL_LEVELS (lowest to highest)
const skillLevel = z.enum(['basic', 'proficient', 'expert']);

export const peopleDetails: readonly AiActionDetail[] = [
  // --- directory / offboarding (members module) ---
  det({
    id: 'members.list',
    title: 'List members',
    description: 'Everyone with a membership in this workspace, optionally matching a search.',
    input: listArgs(
      [],
      { q: f.shortText(190).optional().describe('Search text (name or email)') },
      { cursor: 'after' },
    ),
    redact: 'people',
    examples: [
      { summary: 'All members', args: {} },
      { summary: 'Search', args: { q: 'Sara' } },
    ],
  }),
  det({
    id: 'members.offboarding_impact.list',
    title: 'Preview offboarding impact',
    description: 'What would be reassigned or lost if a member were offboarded.',
    input: pathOnly('userId'),
    redact: 'people',
    examples: [{ summary: 'Preview', args: { userId: 'u_1' } }],
  }),
  det({
    id: 'members.offboard.create',
    title: 'Offboard a member',
    description: 'Remove a person from the workspace and reassign their work. Confirm-class.',
    input: bodyArgs(['userId'], { reassignToUserId: f.id().nullish() }),
    redact: 'people',
    notifies: true,
    examples: [{ summary: 'Offboard', args: { userId: 'u_1' } }],
  }),
  // --- people directory ---
  det({
    id: 'people.list',
    title: 'List people',
    description: 'The people directory with roles and teams.',
    input: listArgs([], { q: f.shortText(200).optional() }, { cursor: 'after' }),
    redact: 'people',
    examples: [{ summary: 'Search', args: { q: 'designer' } }],
  }),
  det({
    id: 'people.get',
    title: 'Get a person',
    description: 'One person by membership id.',
    input: pathOnly('membershipId'),
    redact: 'people',
    examples: [{ summary: 'By id', args: { membershipId: 'm_1' } }],
  }),
  det({
    id: 'people.org_chart.list',
    title: 'Get the org chart',
    description: 'The reporting-line tree for the workspace.',
    input: queryArgs(),
    redact: 'people',
    examples: [{ summary: 'Chart', args: {} }],
  }),
  det({
    id: 'people.capacity.heatmap.list',
    title: 'Capacity heatmap',
    description:
      'Weekly capacity versus allocation across people, for a number of weeks starting on a day.',
    input: queryArgs([], {
      from: day().describe('First day of the first week, YYYY-MM-DD'),
      weeks: f.int(1, HEATMAP_MAX_WEEKS).describe(`Number of weeks, 1 to ${HEATMAP_MAX_WEEKS}`),
    }),
    redact: 'people',
    examples: [{ summary: 'This month', args: { from: '2026-11-02', weeks: 4 } }],
  }),
  det({
    id: 'people.skills.search.list',
    title: 'Search people by skill',
    description:
      'Find people who have a skill, optionally at a minimum level (basic, proficient or expert).',
    input: listArgs(
      [],
      { skill: f.shortText(80).optional(), level: skillLevel.optional() },
      { cursor: null },
    ),
    redact: 'people',
    examples: [{ summary: 'Figma experts', args: { skill: 'Figma', level: 'expert' } }],
  }),
  // --- per-person detail ---
  det({
    id: 'people.availability.list',
    title: "A person's availability",
    description: 'Availability and time-off windows for one person.',
    input: queryArgs(['membershipId']),
    redact: 'people',
    examples: [{ summary: 'By person', args: { membershipId: 'm_1' } }],
  }),
  det({
    id: 'people.load.get',
    title: "A person's workload in hours",
    description:
      'Planned hours per week against capacity for one person; work the caller cannot read is one bucket.',
    input: queryArgs(['membershipId'], { from: f.iso(), to: f.iso() }),
    redact: 'people',
    examples: [
      {
        summary: 'Next four weeks',
        args: { membershipId: 'm_1', from: '2026-11-02', to: '2026-11-29' },
      },
    ],
  }),
  // R31 A13: the people overview (this week's roster, and time off / allocations in a window).
  det({
    id: 'people.capacity_roster.list',
    title: 'Capacity this week',
    description: "Everyone's capacity, allocated hours and time off for the current week.",
    input: queryArgs(),
    redact: 'people',
    examples: [{ summary: 'This week', args: {} }],
  }),
  det({
    id: 'people.time_off_overview.list',
    title: 'Time off across people',
    description: 'Time off for everyone in a date window (default: the next weeks).',
    input: queryArgs([], { from: f.iso().optional(), to: f.iso().optional() }),
    redact: 'people',
    examples: [{ summary: 'November', args: { from: '2026-11-01', to: '2026-11-30' } }],
  }),
  det({
    id: 'people.allocations_overview.list',
    title: 'Allocations across people',
    description:
      'Planned allocations for everyone in a date window; only projects the caller can read.',
    input: queryArgs([], { from: f.iso().optional(), to: f.iso().optional() }),
    redact: 'people',
    examples: [{ summary: 'November', args: { from: '2026-11-01', to: '2026-11-30' } }],
  }),
  det({
    id: 'people.capacity.list',
    title: "A person's capacity",
    description: 'Weekly working-hours capacity for one person.',
    input: queryArgs(['membershipId']),
    redact: 'people',
    examples: [{ summary: 'By person', args: { membershipId: 'm_1' } }],
  }),
  det({
    id: 'people.capacity.set',
    title: 'Set a person’s capacity',
    description: 'Set weekly working hours effective from a date.',
    input: bodyArgs(['membershipId'], { weeklyHours: f.int(0, 168), effectiveFrom: f.iso() }),
    redact: 'people',
    examples: [
      {
        summary: '32h/week',
        args: { membershipId: 'm_1', weeklyHours: 32, effectiveFrom: '2026-11-01' },
      },
    ],
  }),
  det({
    id: 'people.manager.list',
    title: "A person's manager",
    description: 'The reporting line (manager) for one person.',
    input: queryArgs(['membershipId']),
    redact: 'people',
    examples: [{ summary: 'By person', args: { membershipId: 'm_1' } }],
  }),
  det({
    id: 'people.manager.set',
    title: 'Set a person’s manager',
    description: 'Set or clear who a person reports to.',
    input: bodyArgs(['membershipId'], { managerMembershipId: f.id().nullable() }),
    redact: 'people',
    examples: [{ summary: 'Assign', args: { membershipId: 'm_1', managerMembershipId: 'm_2' } }],
  }),
  det({
    id: 'people.profile.list',
    title: "A person's profile",
    description: 'Department, bio and contact details for one person.',
    input: queryArgs(['membershipId']),
    redact: 'people',
    examples: [{ summary: 'By person', args: { membershipId: 'm_1' } }],
  }),
  det({
    id: 'people.profile.set',
    title: 'Update a person’s profile',
    description: 'Set department, bio and contact fields.',
    input: bodyArgs(['membershipId'], {
      department: f.shortText(120).nullish(),
      bio: f.text(2000).nullish(),
      contactEmail: f.shortText(254).nullish(),
      contactPhone: f.shortText(40).nullish(),
    }),
    redact: 'people',
    examples: [{ summary: 'Set dept', args: { membershipId: 'm_1', department: 'Design' } }],
  }),
  det({
    id: 'people.skills.list',
    title: "A person's skills",
    description: 'Skills and levels recorded for one person.',
    input: queryArgs(['membershipId']),
    redact: 'people',
    examples: [{ summary: 'By person', args: { membershipId: 'm_1' } }],
  }),
  det({
    id: 'people.skills.create',
    title: 'Add a skill to a person',
    description: 'Record a skill at a level for one person.',
    input: bodyArgs(['membershipId'], { label: f.shortText(80), level: f.int(0, 5).optional() }),
    redact: 'people',
    examples: [{ summary: 'Add', args: { membershipId: 'm_1', label: 'Figma', level: 4 } }],
  }),
  det({
    id: 'people.skills.delete',
    title: 'Remove a skill from a person',
    description: 'Delete one recorded skill. Confirm-class.',
    input: pathOnly('membershipId', 'skillId'),
    redact: 'people',
    examples: [{ summary: 'Remove', args: { membershipId: 'm_1', skillId: 'sk_1' } }],
  }),
  det({
    id: 'people.certifications.list',
    title: "A person's certifications",
    description: 'Certifications recorded for one person.',
    input: queryArgs(['userId']),
    redact: 'people',
    examples: [{ summary: 'By person', args: { userId: 'u_1' } }],
  }),
  det({
    id: 'people.certifications.create',
    title: 'Add a certification',
    description: 'Record a certification for one person.',
    input: bodyArgs(['userId'], {
      name: f.shortText(160),
      issuer: f.shortText(160).optional(),
      issuedOn: f.iso().optional(),
      expiresOn: f.iso().nullish(),
    }),
    redact: 'people',
    examples: [{ summary: 'Add', args: { userId: 'u_1', name: 'PMP' } }],
  }),
  det({
    id: 'people.certifications.delete',
    title: 'Remove a certification',
    description: 'Delete one recorded certification. Confirm-class.',
    input: pathOnly('userId', 'certificationId'),
    redact: 'people',
    examples: [{ summary: 'Remove', args: { userId: 'u_1', certificationId: 'cert_1' } }],
  }),
  det({
    id: 'people.time_off.list',
    title: "A person's time off",
    description:
      'Time-off entries for one person, optionally only those overlapping a from/to window (send both, YYYY-MM-DD).',
    input: queryArgs(['userId'], { from: day().optional(), to: day().optional() }),
    redact: 'people',
    examples: [
      { summary: 'By person', args: { userId: 'u_1' } },
      { summary: 'In November', args: { userId: 'u_1', from: '2026-11-01', to: '2026-11-30' } },
    ],
  }),
  det({
    id: 'people.time_off.create',
    title: 'Record time off',
    description: 'Add a time-off window for one person.',
    input: bodyArgs(['userId'], {
      startDate: f.iso(),
      endDate: f.iso(),
      kind: f.shortText(40).optional(),
      note: f.text(500).optional(),
    }),
    redact: 'people',
    examples: [
      { summary: 'Leave', args: { userId: 'u_1', startDate: '2026-12-24', endDate: '2026-12-31' } },
    ],
  }),
  det({
    id: 'people.time_off.delete',
    title: 'Delete time off',
    description: 'Remove one time-off entry. Confirm-class.',
    input: pathOnly('userId', 'entryId'),
    redact: 'people',
    examples: [{ summary: 'Remove', args: { userId: 'u_1', entryId: 'to_1' } }],
  }),
  // --- org-wide availability ---
  det({
    id: 'people.availability.list.get',
    title: 'Your availability',
    description: 'Your own availability and time-off windows.',
    input: queryArgs(),
    redact: 'people',
    examples: [{ summary: 'Mine', args: {} }],
  }),
  det({
    id: 'people.availability.create',
    title: 'Add an availability window',
    description:
      'Record your own time away: a kind and a startDate/endDate window (YYYY-MM-DD, end on or after start).',
    input: bodyArgs([], {
      startDate: day(),
      endDate: day(),
      kind: z.enum(AVAILABILITY_KINDS),
      note: z.string().max(500).nullable().optional(),
    }),
    redact: 'people',
    examples: [
      {
        summary: 'Two days off',
        args: { startDate: '2026-12-01', endDate: '2026-12-02', kind: 'vacation' },
      },
    ],
  }),
  det({
    id: 'people.availability.delete',
    title: 'Delete an availability window',
    description: 'Remove one availability window. Confirm-class.',
    input: pathOnly('availabilityId'),
    redact: 'people',
    examples: [{ summary: 'Remove', args: { availabilityId: 'av_1' } }],
  }),
  // --- teams ---
  det({
    id: 'people.teams.list',
    title: 'List teams',
    description: 'Teams defined in the workspace.',
    input: queryArgs(),
    redact: 'people',
    examples: [{ summary: 'All teams', args: {} }],
  }),
  det({
    id: 'people.teams.create',
    title: 'Create a team',
    description: 'Create a new team.',
    input: bodyArgs([], { name: f.shortText(120) }),
    redact: 'people',
    examples: [{ summary: 'New team', args: { name: 'Design' } }],
  }),
  det({
    id: 'people.teams.get',
    title: 'Get a team',
    description: 'One team with its members.',
    input: pathOnly('id'),
    redact: 'people',
    examples: [{ summary: 'By id', args: { id: 't_1' } }],
  }),
  det({
    id: 'people.teams.members.set',
    title: 'Add or update a team member',
    description: 'Put a person on a team (optionally with a role).',
    input: bodyArgs(['id', 'membershipId'], { role: f.shortText(40).optional() }),
    redact: 'people',
    examples: [{ summary: 'Add', args: { id: 't_1', membershipId: 'm_1' } }],
  }),
  det({
    id: 'people.teams.members.delete',
    title: 'Remove a team member',
    description: 'Take a person off a team. Confirm-class.',
    input: pathOnly('id', 'membershipId'),
    redact: 'people',
    examples: [{ summary: 'Remove', args: { id: 't_1', membershipId: 'm_1' } }],
  }),
];
