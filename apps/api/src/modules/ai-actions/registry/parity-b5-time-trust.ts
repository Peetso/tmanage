/**
 * AI action registry — batch 5, lane T "time you can trust" (owner rule, 2026-11-23: "the timer
 * let a member type any time, which deceives managers, HR, accountants and clients"; ADR-0015
 * part 1 rule 4: what the member can do by hand, the AI can do — under the same rules).
 *
 * Each op mirrors a route in `time/time-trust.controller.ts`; the service decides every call, so
 * the AI and an MCP client meet the same refusals a person does, in the same words:
 *
 * - `time.trust_policy.get` (read): the owner's rules — may members add time by hand, how waiting
 *   hand time counts, the idle cap. The AI reads it to explain a refusal before it tries.
 * - `time.trust_policy.update` (manage, confirm): the company owner only; anyone else is refused
 *   403 "Only the company owner can change this setting."
 * - `time.approvals.list` (read) and `time.approvals.approve` / `.reject` (manage, confirm): the
 *   managers' queue. Never one's own entry (404); a refusal needs a note; a decided or locked
 *   entry is a 409 with the reason.
 * - `time.entries.correction` (write, confirm): the way to fix timer time — the right minutes and
 *   a reason, waiting for a manager. Timer time itself is never edited (the timesheet edit answers
 *   409 "Timer time cannot be changed…").
 * - `time.entries.history` (read): the entry, what it corrects, its corrections, the decisions.
 *
 * Starting and stopping the timer stay the existing `time.timer.*` ops (allowed); hand time is the
 * existing `work_items.time_logs.create` and `time.timesheets.entries.upsert`, which now carry a
 * `reason` and are refused 403 `hand_time_off` with the owner's words when the owner turned it off.
 */
import { z } from 'zod';
import { HAND_TIME_COUNT_MODES, IDLE_CAP_MAX_HOURS, IDLE_CAP_MIN_HOURS } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import type { AiActionOp, AiScope, HttpMethod, Sensitivity } from './types.js';
import { bodyArgs, det, f, noArgs, pathOnly, type AiActionDetail } from './detail.js';

const ORG = '/v1/organizations/:orgSlug';

function op(
  id: string,
  method: HttpMethod,
  path: string,
  capability: Capability,
  scope: AiScope,
): AiActionOp {
  const risk = method === 'GET' ? 'read' : 'confirm';
  return {
    id,
    method,
    path: `${ORG}${path}`,
    capability,
    risk,
    scope: risk === 'read' ? 'read' : scope,
  };
}

const R = 'read' as const;
const W = 'write' as const;
const M = 'manage' as const;

export const timeTrustOps: readonly AiActionOp[] = [
  op('time.trust_policy.get', 'GET', '/time/trust-policy', 'work.read', R),
  op('time.trust_policy.update', 'PATCH', '/time/trust-policy', 'org.manage', M),
  op('time.approvals.list', 'GET', '/time/approvals', 'project.manage', R),
  op('time.approvals.approve', 'POST', '/time/approvals/:entryId/approve', 'project.manage', M),
  op('time.approvals.reject', 'POST', '/time/approvals/:entryId/reject', 'project.manage', M),
  op('time.entries.correction', 'POST', '/time/entries/:entryId/correction', 'work.read', W),
  op('time.entries.history', 'GET', '/time/entries/:entryId/history', 'work.read', R),
];

/** Non-read ops only. Nothing here moves money or reaches outside; a decision is not destructive. */
export const timeTrustSensitivity: Readonly<Record<string, Sensitivity>> = {
  'time.trust_policy.update': 'none',
  'time.approvals.approve': 'none',
  'time.approvals.reject': 'none',
  'time.entries.correction': 'none',
};

const countModes = HAND_TIME_COUNT_MODES as unknown as readonly [string, ...string[]];
const reason = () => z.string().min(3).max(500);

export const timeTrustDetails: readonly AiActionDetail[] = [
  det({
    id: 'time.trust_policy.get',
    title: 'Show the rules for adding time by hand',
    description:
      'The owner’s time rules (Admin > Time): handTimeAllowed (may members type time in), ' +
      'handTimeCountMode (after_approval: typed-in time counts only once a manager approves it; ' +
      'at_once_flagged: it counts at once, labelled), idleCapHours (a timer left running stops at ' +
      'this many hours, marked "needs review") and mayChange (is the caller the owner).',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Can I add time by hand?', args: {} }],
  }),
  det({
    id: 'time.trust_policy.update',
    title: 'Change the rules for adding time by hand',
    description:
      'Company owner only. Send any of handTimeAllowed, handTimeCountMode, idleCapHours ' +
      `(${IDLE_CAP_MIN_HOURS} to ${IDLE_CAP_MAX_HOURS}). Recorded in the audit log with the ` +
      'before and after of each rule.',
    input: bodyArgs([], {
      handTimeAllowed: f.bool().optional(),
      handTimeCountMode: z.enum(countModes).optional(),
      idleCapHours: f.int(IDLE_CAP_MIN_HOURS, IDLE_CAP_MAX_HOURS).optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Allow hand time, count after approval', args: { handTimeAllowed: true } },
    ],
  }),
  det({
    id: 'time.approvals.list',
    title: 'List time waiting for my approval',
    description:
      'Time added by hand, corrections of timer time and timers stopped at the idle cap that the ' +
      'caller may decide (never their own): { entries, pendingMinutes }. Each entry says how the ' +
      'minutes came in (trust: measured or hand), the reason and whether it counts yet.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'What time waits for me?', args: {} }],
  }),
  det({
    id: 'time.approvals.approve',
    title: 'Approve time added by hand',
    description:
      'Approve one waiting entry (optional note). An approved correction replaces the timer entry ' +
      'it corrects in every total; the original stays in the history. Never one’s own entry.',
    input: bodyArgs(['entryId'], { note: reason().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Approve', args: { entryId: 'tl_1' } }],
  }),
  det({
    id: 'time.approvals.reject',
    title: 'Refuse time added by hand',
    description:
      'Refuse one waiting entry with a note the member reads (3 to 500 characters). Refused time ' +
      'never counts. Never one’s own entry.',
    input: bodyArgs(['entryId'], { note: reason() }),
    redact: 'standard',
    examples: [
      { summary: 'Refuse', args: { entryId: 'tl_1', note: 'This meeting was 30 minutes' } },
    ],
  }),
  det({
    id: 'time.entries.correction',
    title: 'Ask for a correction of my timer time',
    description:
      'Timer time cannot be edited. For the member’s own timer entry, send the right minutes ' +
      '(1-1440) and a reason; a manager approves it, and until then the timer entry counts as ' +
      'measured. One waiting correction per entry.',
    input: bodyArgs(['entryId'], { minutes: f.int(1, 24 * 60), reason: reason() }),
    redact: 'standard',
    examples: [
      {
        summary: 'I forgot to stop the timer',
        args: { entryId: 'tl_1', minutes: 45, reason: 'Forgot to stop it after the call' },
      },
    ],
  }),
  det({
    id: 'time.entries.history',
    title: 'Show the history of a time entry',
    description:
      'One entry (own, or one the caller may decide), the timer entry it corrects and its ' +
      'corrections, with decisions and the edited flag.',
    input: pathOnly('entryId'),
    redact: 'standard',
    examples: [{ summary: 'History', args: { entryId: 'tl_1' } }],
  }),
];
