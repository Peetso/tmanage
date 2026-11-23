/**
 * AI action details — calendar (focus blocks, meeting series/recurrence, meetings, agenda,
 * action items, attendees, notes, RSVP, time polls, ICS).
 *
 * Slice S3 (registry wave B). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * Inviting an attendee notifies that person (`notifies` → `openWorldHint`). Enum values are
 * mirrored from the controllers (freq, RSVP response, action-item status).
 */
import { z } from 'zod';
import { CALENDAR_GRID_RANGES } from '../../calendar/grid.service.js';
import {
  neededWhen,
  exactlyOne,
  atLeastOne,
  det,
  queryArgs,
  listArgs,
  pathOnly,
  bodyArgs,
  f,
  type AiActionDetail,
} from './detail.js';

// = calendar/meeting-series.repository.ts:MEETING_SERIES_FREQS
const freq = z.enum(['daily', 'weekly', 'monthly']);
const rsvpResponse = z.enum(['accepted', 'declined', 'tentative']);
const actionItemStatus = z.enum(['open', 'done']);
// = calendar/meeting-attendees.controller.ts:RSVPS
const attendeeRsvp = z.enum(['invited', 'accepted', 'declined']);
// = calendar/occurrence-override.repository.ts:MEETING_OCCURRENCE_OVERRIDE_STATUSES
const overrideStatus = z.enum(['moved', 'cancelled']);
// = calendar/time-poll.controller.ts:VOTE_CHOICES
const voteChoice = z.enum(['yes', 'maybe', 'no']);
// = calendar/meetings.controller.ts:NOTE_KINDS
const noteKind = z.enum(['note', 'decision']);
/** = calendar/agenda-templates.controller.ts: 1 to MAX_ITEMS (100) items, each a title of at most 300. */
const agendaItems = z
  .array(z.object({ title: f.shortText(300) }).strict())
  .min(1)
  .max(100);
/** A calendar day on the wire, `YYYY-MM-DD` (the controllers' `ISO_DATE`/`DATE_ONLY`). */
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');

export const calendarDetails: readonly AiActionDetail[] = [
  det({
    id: 'calendar.focus_blocks.list',
    title: 'List your focus blocks',
    description:
      'Your protected focus-time blocks that start in a window. from and to are ISO instants, to after from, at most 366 days apart.',
    input: queryArgs([], {
      from: f.iso().describe('Window start, an ISO-8601 instant (inclusive)'),
      to: f.iso().describe('Window end, an ISO-8601 instant (exclusive)'),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Focus blocks',
        args: { from: '2026-10-19T00:00:00Z', to: '2026-10-26T00:00:00Z' },
      },
    ],
  }),
  det({
    id: 'calendar.focus_blocks.create',
    title: 'Create a focus block',
    description: 'Block out protected focus time on your calendar.',
    input: bodyArgs([], {
      startsAt: f.iso(),
      endsAt: f.iso().describe('After startsAt, at most 24 hours later'),
      title: f.shortText(200),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Morning deep work',
        args: {
          startsAt: '2026-10-21T09:00:00Z',
          endsAt: '2026-10-21T11:00:00Z',
          title: 'Deep work',
        },
      },
    ],
  }),
  det({
    id: 'calendar.focus_blocks.delete',
    title: 'Delete a focus block',
    description: 'Remove a focus-time block. Confirm-class.',
    input: pathOnly('id'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { id: 'focus_1' } }],
  }),
  det({
    id: 'meeting_series.list',
    title: 'List meeting series',
    description: 'The recurring meeting series in this workspace.',
    input: listArgs([], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'Series', args: {} }],
  }),
  det({
    id: 'meeting_series.create',
    title: 'Create a meeting series',
    description: 'Create a recurring meeting series.',
    input: bodyArgs([], {
      title: f.shortText(300),
      freq,
      interval: f.int(1, 366).describe('Repeat every N days, weeks or months (1 = every one)'),
      until: day().nullable().optional().describe('Last day of the series, YYYY-MM-DD'),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Weekly standup', args: { title: 'Standup', freq: 'weekly', interval: 1 } },
    ],
  }),
  det({
    id: 'meeting_series.occurrences.list',
    title: 'List series occurrences',
    description:
      'The occurrences of a meeting series in a window of days (from and to as YYYY-MM-DD, at most 90 days apart).',
    input: queryArgs(['seriesId'], { from: day(), to: day() }),
    redact: 'standard',
    examples: [
      {
        summary: 'Occurrences',
        args: { seriesId: 'series_1', from: '2026-10-01', to: '2026-10-31' },
      },
    ],
  }),
  det({
    id: 'meeting_series.occurrences.get',
    title: 'Get a series occurrence',
    description: 'One occurrence of a meeting series by date.',
    input: pathOnly('seriesId', 'date'),
    redact: 'standard',
    examples: [{ summary: 'By date', args: { seriesId: 'series_1', date: '2026-10-21' } }],
  }),
  det({
    id: 'meeting_series.occurrences.create',
    title: 'Override a series occurrence',
    description:
      'Move or cancel one occurrence of a meeting series. A moved occurrence sets at least one of ' +
      'newDate, newStartTime or newTitle; a cancelled one sets none of them.',
    input: neededWhen(
      bodyArgs(['seriesId', 'date'], {
        status: overrideStatus,
        newDate: day().nullable().optional(),
        newStartTime: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be HH:MM or HH:MM:SS')
          .nullable()
          .optional()
          .describe('New start time of day, HH:MM (24-hour)'),
        newTitle: f.shortText(300).nullable().optional(),
      }),
      'status',
      'moved',
      ['newDate', 'newStartTime', 'newTitle'],
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'Cancel one',
        args: { seriesId: 'series_1', date: '2026-10-28', status: 'cancelled' },
      },
      {
        summary: 'Move one',
        args: { seriesId: 'series_1', date: '2026-10-21', status: 'moved', newDate: '2026-10-22' },
      },
    ],
  }),
  det({
    id: 'meeting_series.occurrences.delete',
    title: 'Cancel a series occurrence',
    description: 'Cancel one occurrence of a meeting series. Confirm-class.',
    input: pathOnly('seriesId', 'date'),
    redact: 'standard',
    examples: [{ summary: 'Cancel', args: { seriesId: 'series_1', date: '2026-10-21' } }],
  }),
  det({
    id: 'meetings.list',
    title: 'List meetings',
    description:
      'The meetings you can see. With projectId: that project, paged. Without: every meeting you can read, optionally in a from/to window.',
    input: listArgs(
      [],
      {
        projectId: f.id().optional(),
        from: f.iso().optional().describe('Without projectId: window start, an ISO instant'),
        to: f.iso().optional().describe('Without projectId: window end, an ISO instant'),
        includeCancelled: f
          .bool()
          .optional()
          .describe('Without projectId: include cancelled meetings'),
      },
      { cursor: 'after' },
    ),
    redact: 'standard',
    examples: [{ summary: 'Meetings', args: {} }],
  }),
  det({
    id: 'meetings.create',
    title: 'Create a meeting',
    description: 'Schedule a new meeting in a project.',
    input: bodyArgs([], {
      projectId: f.id(),
      title: f.shortText(300),
      startsAt: f.iso(),
      endsAt: f.iso().optional(),
      agendaNote: f.text(8_000).optional(),
      attendeeUserIds: z.array(f.id()).max(100).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Kickoff',
        args: {
          projectId: '01a20864-92a3-7a1c-b107-397ebef031dc',
          title: 'Project kickoff',
          startsAt: '2026-10-22T14:00:00Z',
        },
      },
    ],
  }),
  det({
    id: 'meetings.update',
    title: 'Edit a meeting',
    description: 'Change a meeting’s title, start, end or agenda note. Send at least one of them.',
    input: atLeastOne(
      bodyArgs(['meetingId'], {
        title: f.shortText(300).optional(),
        startsAt: f.iso().optional(),
        endsAt: f.iso().nullable().optional(),
        agendaNote: f.text(8_000).nullable().optional(),
      }),
      ['title', 'startsAt', 'endsAt', 'agendaNote'],
    ),
    redact: 'standard',
    examples: [
      { summary: 'Move end', args: { meetingId: 'mtg_1', endsAt: '2026-10-22T15:00:00Z' } },
    ],
  }),
  // 0237. The meeting page, cancel and re-send to the organizer's Google calendar.
  det({
    id: 'meetings.overview',
    title: 'Get a meeting page',
    description:
      'One meeting with its options, everyone invited and their answer, the video link and attachments.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    examples: [{ summary: 'Meeting page', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.cancel',
    title: 'Cancel a meeting',
    description:
      'Cancel a meeting; its calendar event is deleted and every guest is told. Confirm-class.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Cancel', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.delete',
    title: 'Remove a cancelled meeting',
    description:
      'Remove a cancelled meeting from the calendar. Only a cancelled meeting can be removed. Confirm-class.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.sync',
    title: 'Sync a meeting with the calendar',
    description: 'Send a meeting to its organizer’s calendar again and read the answers back.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Retry', args: { meetingId: 'mtg_1' } }],
  }),
  // 53-12. The call card, Join and attendance.
  det({
    id: 'meetings.call.get',
    title: 'Get a meeting call link',
    description:
      'The meeting call: provider, host and whether Join is open. The link itself only for people invited.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    examples: [{ summary: 'Call link', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.join',
    title: 'Join a meeting',
    description:
      'Join a meeting you are invited to: marks you present and returns the call link. Confirm-class.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    examples: [{ summary: 'Join', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.attendance.list',
    title: 'List meeting attendance',
    description: 'Who joined a meeting, when, who was late and who was absent.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    examples: [{ summary: 'Attendance', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.call.set',
    title: 'Set a meeting call link',
    description:
      'Paste the call link (Google Meet, Teams, Zoom, Webex, Whereby or Jitsi, https only), or null to remove it.',
    input: bodyArgs(['meetingId'], { url: f.shortText(1024).nullable() }),
    redact: 'standard',
    examples: [
      {
        summary: 'Meet link',
        args: { meetingId: 'mtg_1', url: 'https://meet.google.com/abc-defg-hij' },
      },
    ],
  }),
  det({
    id: 'meetings.attendance.set',
    title: 'Correct meeting attendance',
    description: 'Mark someone on the meeting present or absent by hand. Confirm-class.',
    input: bodyArgs(['meetingId', 'userId'], { status: z.enum(['present', 'absent']) }),
    redact: 'standard',
    examples: [
      { summary: 'Mark present', args: { meetingId: 'mtg_1', userId: 'usr_1', status: 'present' } },
    ],
  }),
  det({
    id: 'meetings.quick_room.start',
    title: 'Start a quick room for a meeting',
    description:
      "Give a meeting a private video room on Jitsi's free public servers (replaces its call link).",
    input: pathOnly('meetingId'),
    redact: 'standard',
    examples: [{ summary: 'Quick room', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.quick_room.create',
    title: 'Start a quick room now',
    description: 'Create a 30-minute meeting that starts now in a project, with a quick room.',
    input: bodyArgs([], { projectId: f.id(), title: f.shortText(300).optional() }),
    redact: 'standard',
    examples: [{ summary: 'Now', args: { projectId: 'prj_1', title: 'Quick sync' } }],
  }),
  det({
    id: 'meetings.action_items.list',
    title: 'List meeting action items',
    description: 'The action items for a meeting.',
    input: listArgs(['meetingId'], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'Action items', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.action_items.create',
    title: 'Add a meeting action item',
    description: 'Add an action item to a meeting and optionally assign an owner.',
    input: bodyArgs(['meetingId'], {
      title: f.shortText(300),
      ownerMembershipId: f.id().optional(),
      dueOn: f.iso().optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Add', args: { meetingId: 'mtg_1', title: 'Send recap' } }],
  }),
  det({
    id: 'meetings.action_items.update',
    title: 'Update a meeting action item',
    description: 'Change an action item’s status, owner or title.',
    input: bodyArgs(['meetingId', 'actionItemId'], {
      title: f.shortText(300).optional(),
      status: actionItemStatus.optional(),
      ownerMembershipId: f.id().optional(),
      dueOn: f.iso().optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Mark done', args: { meetingId: 'mtg_1', actionItemId: 'ai_2', status: 'done' } },
    ],
  }),
  det({
    id: 'meetings.action_items.delete',
    title: 'Delete a meeting action item',
    description: 'Remove an action item from a meeting. Confirm-class.',
    input: pathOnly('meetingId', 'actionItemId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { meetingId: 'mtg_1', actionItemId: 'ai_2' } }],
  }),
  det({
    id: 'meetings.apply_agenda_template.create',
    title: 'Apply an agenda template',
    description: 'Apply an agenda template to a meeting.',
    input: bodyArgs(['meetingId'], { templateId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Apply', args: { meetingId: 'mtg_1', templateId: 'atmpl_1' } }],
  }),
  det({
    id: 'meetings.attendees.list',
    title: 'List meeting attendees',
    description: 'The people invited to a meeting.',
    input: listArgs(['meetingId'], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'Attendees', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.attendees.create',
    title: 'Invite a meeting attendee',
    description:
      'Invite a team member (userId) or a client person of the project (clientUserId). They are ' +
      'notified. Inviting a client person (clientUserId) needs approval in TManage first.',
    input: exactlyOne(
      bodyArgs(['meetingId'], { userId: f.id().optional(), clientUserId: f.id().optional() }),
      ['userId', 'clientUserId'],
    ),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Invite', args: { meetingId: 'mtg_1', userId: 'user_3' } }],
  }),
  det({
    id: 'meetings.attendees.client_candidates.list',
    title: 'List client people who can attend',
    description: 'Client people of the meeting’s project who may be added as attendees.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    examples: [{ summary: 'Candidates', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.attendees.delete',
    title: 'Remove a meeting attendee',
    description: 'Remove a person from a meeting. Confirm-class.',
    input: pathOnly('meetingId', 'attendeeId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { meetingId: 'mtg_1', attendeeId: 'att_4' } }],
  }),
  det({
    id: 'meetings.attendees.update',
    title: 'Set a meeting attendee’s RSVP',
    description: 'Set an attendee’s answer on a meeting: invited, accepted or declined.',
    input: bodyArgs(['meetingId', 'attendeeId'], { rsvp: attendeeRsvp }),
    redact: 'standard',
    examples: [
      {
        summary: 'Accept',
        args: { meetingId: 'mtg_1', attendeeId: 'att_4', rsvp: 'accepted' },
      },
    ],
  }),
  det({
    id: 'meetings.ics.list',
    title: 'Get a meeting calendar file',
    description: 'The ICS calendar entry for a meeting.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    examples: [{ summary: 'ICS', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.notes.list',
    title: 'List meeting notes',
    description: 'The notes attached to a meeting.',
    input: listArgs(['meetingId'], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'Notes', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.notes.create',
    title: 'Add meeting notes',
    description: 'Add a note or a decision to a meeting.',
    input: bodyArgs(['meetingId'], { kind: noteKind, body: f.text(8_000) }),
    redact: 'standard',
    examples: [
      { summary: 'Add', args: { meetingId: 'mtg_1', kind: 'note', body: 'Discussed scope' } },
    ],
  }),
  det({
    id: 'meetings.note_drafts.list',
    title: 'List meeting note drafts',
    description: 'Draft notes from an AI assistant still waiting for a person to review them.',
    input: pathOnly('meetingId'),
    redact: 'standard',
    examples: [{ summary: 'Drafts', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.note_drafts.submit',
    title: 'Draft meeting notes for review',
    description:
      'Submit a draft note or decision for a meeting. It is not saved until a person reviews ' +
      'it in TManage and chooses Save or Discard.',
    input: bodyArgs(['meetingId'], {
      body: f.text(8_000),
      kind: noteKind.optional(),
      assistantName: f.text(120).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Draft',
        args: { meetingId: 'mtg_1', body: 'Launch moves to 20 Nov', assistantName: 'Claude' },
      },
    ],
  }),
  det({
    id: 'meetings.rsvp.list',
    title: 'List meeting RSVPs',
    description: 'Who has RSVPed to a meeting.',
    input: queryArgs(['meetingId']),
    redact: 'standard',
    examples: [{ summary: 'RSVPs', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.rsvp.set',
    title: 'RSVP to a meeting',
    description: 'Set your own RSVP for a meeting.',
    input: bodyArgs(['meetingId'], { response: rsvpResponse }),
    redact: 'standard',
    examples: [{ summary: 'Accept', args: { meetingId: 'mtg_1', response: 'accepted' } }],
  }),
  det({
    id: 'meetings.time_poll.list',
    title: 'Get a meeting time poll',
    description: 'The time-poll options for a meeting.',
    input: queryArgs(['meetingId']),
    redact: 'standard',
    examples: [{ summary: 'Poll', args: { meetingId: 'mtg_1' } }],
  }),
  det({
    id: 'meetings.time_poll.create',
    title: 'Create a meeting time poll',
    description:
      'Create a poll of candidate meeting times. Each option is a slot with startsAt and endsAt (ISO instants, end after start).',
    input: bodyArgs(['meetingId'], {
      options: z
        .array(z.object({ startsAt: f.iso(), endsAt: f.iso() }).strict())
        .min(1)
        .max(20),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Two options',
        args: {
          meetingId: 'mtg_1',
          options: [
            { startsAt: '2026-10-22T14:00:00Z', endsAt: '2026-10-22T15:00:00Z' },
            { startsAt: '2026-10-23T09:00:00Z', endsAt: '2026-10-23T10:00:00Z' },
          ],
        },
      },
    ],
  }),
  det({
    id: 'meetings.time_poll.options.vote.set',
    title: 'Vote in a meeting time poll',
    description: 'Cast your vote (yes, maybe or no) for a time-poll option.',
    input: bodyArgs(['meetingId', 'optionId'], { choice: voteChoice }),
    redact: 'standard',
    examples: [{ summary: 'Vote', args: { meetingId: 'mtg_1', optionId: 'opt_1', choice: 'yes' } }],
  }),
  det({
    id: 'meetings.agenda.list',
    title: 'Get your meeting agenda',
    description:
      'Your meetings day by day in a window of days (from and to as YYYY-MM-DD, at most 31 days apart).',
    input: queryArgs([], { from: day(), to: day() }),
    redact: 'standard',
    examples: [{ summary: 'Agenda', args: { from: '2026-10-19', to: '2026-10-25' } }],
  }),
  det({
    id: 'meetings.agenda_templates.list',
    title: 'List agenda templates',
    description: 'The agenda templates in this workspace.',
    input: listArgs([], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'Templates', args: {} }],
  }),
  det({
    id: 'meetings.agenda_templates.create',
    title: 'Create an agenda template',
    description:
      'Create a reusable meeting agenda template: a name and its agenda items, in order.',
    input: bodyArgs([], { name: f.shortText(300), items: agendaItems }),
    redact: 'standard',
    examples: [
      {
        summary: 'New template',
        args: { name: 'Weekly sync', items: [{ title: 'Wins' }, { title: 'Blockers' }] },
      },
    ],
  }),
  det({
    id: 'meetings.agenda_templates.set',
    title: 'Update an agenda template',
    description:
      'Replace a meeting agenda template: send its name and the full list of agenda items.',
    input: bodyArgs(['templateId'], { name: f.shortText(300), items: agendaItems }),
    redact: 'standard',
    examples: [
      {
        summary: 'Rename',
        args: {
          templateId: 'atmpl_1',
          name: 'Weekly sync v2',
          items: [{ title: 'Wins' }, { title: 'Blockers' }, { title: 'Next steps' }],
        },
      },
    ],
  }),
  det({
    id: 'meetings.agenda_templates.delete',
    title: 'Delete an agenda template',
    description: 'Delete a meeting agenda template. Confirm-class.',
    input: pathOnly('templateId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { templateId: 'atmpl_1' } }],
  }),
  det({
    id: 'meetings.grid.list',
    title: 'Get the meeting grid',
    description:
      'The meetings and series occurrences for the week (Monday-based) or month that contains the anchor day.',
    input: queryArgs([], {
      range: z.enum(CALENDAR_GRID_RANGES),
      anchor: day().describe('Any day in the week or month, YYYY-MM-DD'),
    }),
    redact: 'standard',
    examples: [{ summary: 'Grid', args: { range: 'week', anchor: '2026-10-21' } }],
  }),
];
