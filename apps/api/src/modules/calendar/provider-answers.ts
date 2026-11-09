import type { MeetingRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { MeetingCalendarRepository, RosterEntry } from './meeting-calendar.repository.js';
import type { StoredAttendeeRsvp } from './meeting-attendees.repository.js';
import type { MeetingRsvpRepository } from './rsvp.repository.js';

/**
 * Fix 2026-11-09 — the answers a calendar provider (Google Calendar, Outlook) reports for a linked
 * meeting, written into TManage. Shared by both pulls so they cannot drift apart again.
 *
 * - **Every roster row**, the organizer's included: an answer the organizer gives in their own
 *   calendar ("Maybe") is theirs. A provider's "no answer yet" never downgrades the organizer,
 *   who attends from the moment they create the meeting.
 * - **Email matched case-insensitively**: providers lowercase addresses, a guest row keeps what was
 *   typed. The provider's `self` entry (the organizer's own calendar) is the organizer even when
 *   their calendar account's address differs from their TManage sign-in address.
 * - **`meeting_rsvps` too**, for a member: the "Are you going?" buttons and the counts read that
 *   table. A missing row is filled in; an existing one changes only when the provider's answer
 *   itself changed, so a stale provider copy never overwrites an answer just given in TManage.
 * - **The organizer is told** (`meeting.attendee_responded.v1`, same transaction) when someone
 *   else's answer is news: it changed on the roster and was not already the member's TManage answer.
 */

export interface ProviderAnswer {
  /** As the provider reports it (compared lowercased). */
  readonly email: string;
  readonly rsvp: StoredAttendeeRsvp;
  /** The provider marks this entry as the calendar's owner — the organizer. */
  readonly self?: boolean;
}

export interface ApplyProviderAnswersDeps {
  readonly calendar: MeetingCalendarRepository;
  readonly rsvps: MeetingRsvpRepository;
  readonly outbox: OutboxEventsRepository | null;
}

export async function applyProviderAnswers(
  tx: TenantQueryRunner,
  context: TenantContext,
  deps: ApplyProviderAnswersDeps,
  input: {
    readonly meeting: Pick<MeetingRow, 'id' | 'projectId' | 'createdByUserId'>;
    readonly roster: readonly RosterEntry[];
    readonly answers: readonly ProviderAnswer[];
    readonly provider: 'google' | 'microsoft';
  },
): Promise<void> {
  const { meeting, roster, provider } = input;
  const byEmail = new Map(roster.map((entry) => [entry.email.toLowerCase(), entry]));
  const organizer = roster.find((entry) => entry.userId === meeting.createdByUserId) ?? null;
  const done = new Set<string>();

  for (const answer of input.answers) {
    const entry =
      byEmail.get(answer.email.toLowerCase()) ?? (answer.self === true ? organizer : null) ?? null;
    if (!entry) continue;
    const key = `${entry.kind}:${entry.id}`;
    if (done.has(key)) continue;
    done.add(key);

    const isOrganizer = entry.userId !== null && entry.userId === meeting.createdByUserId;
    const rsvp = answer.rsvp;
    // "No answer yet" never takes the organizer off their own meeting.
    if (isOrganizer && rsvp === 'invited') continue;

    const changed = entry.rsvp !== rsvp;
    if (changed) await deps.calendar.setRosterRsvp(tx, context, entry, meeting.id, rsvp);
    if (rsvp === 'invited') continue;

    let alreadyAnsweredInTManage = false;
    if (entry.kind === 'member' && entry.membershipId !== null) {
      const own = await deps.rsvps.findByMember(tx, context, meeting.id, entry.membershipId);
      const row = { meetingId: meeting.id, memberId: entry.membershipId, response: rsvp };
      if (!own) {
        await deps.rsvps.insert(tx, context, row);
      } else if (own.response === rsvp) {
        alreadyAnsweredInTManage = true;
      } else if (changed) {
        await deps.rsvps.updateResponse(tx, context, row);
      }
    }

    if (changed && !isOrganizer && !alreadyAnsweredInTManage && deps.outbox) {
      await deps.outbox.append(tx, context, {
        type: 'meeting.attendee_responded.v1',
        aggregateId: meeting.id,
        payload: {
          meetingId: meeting.id,
          projectId: meeting.projectId,
          attendeeKind: entry.kind,
          attendeeId: entry.id,
          attendeeUserId: entry.userId,
          response: rsvp,
          provider,
        },
      });
    }
  }
}
