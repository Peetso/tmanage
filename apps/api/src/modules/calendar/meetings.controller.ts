import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MEETINGS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  MeetingAttachmentInput,
  MeetingAttendeeInput,
  MeetingGuestEntry,
  MeetingGuestInput,
  MeetingNoteView,
  MeetingOverviewView,
  MeetingView,
  MeetingsService,
} from './meetings.service.js';
import { hasAnyOption, normaliseEmail, parseMeetingOptions } from './meeting-options.js';
import type { MeetingNoteKind } from './meeting-notes.repository.js';

/**
 * CAL-01 / MTG-01 (x90). The first calendar endpoints: create a project meeting, and list a
 * project's meetings.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the body, a
 * header, or its own `:orgSlug` segment: it receives the `TenantContext` that
 * `TenantContextGuard` built from a membership row and passes it on. The body shapes carry no
 * tenant field, so there is nothing for a caller to supply and nothing for a handler to prefer
 * over the context.
 */

interface CreateMeetingBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
  /** An ISO-8601 instant, e.g. `2026-10-01T14:00:00.000Z`. */
  readonly startsAt?: unknown;
  /** Audit gap 8: optional ISO-8601 end instant, strictly after `startsAt`. */
  readonly endsAt?: unknown;
  readonly agendaNote?: unknown;
  /** Audit gap 8 (COL-09): members to invite; the organizer is always added. */
  readonly attendeeUserIds?: unknown;
  /** 0237. `[{userId, optional}]`, `[{email, displayName?, optional}]`, picked files. */
  readonly attendees?: unknown;
  readonly guests?: unknown;
  readonly attachments?: unknown;
  /** 0237. The event options (`allDay`, `timeZone`, `rrule`, `conference`, …). */
  readonly [option: string]: unknown;
}

interface UpdateMeetingBody {
  readonly [option: string]: unknown;
  readonly title?: unknown;
  readonly startsAt?: unknown;
  readonly endsAt?: unknown;
  readonly agendaNote?: unknown;
}

/** The most attendees one create may name. */
const MAX_ATTENDEES = 100;

/** `meetings.title` is `VARCHAR(300)`. */
const MAX_TITLE_LENGTH = 300;
/** `meetings.agenda_note` is `TEXT`; this is a form field, not a document. */
const MAX_AGENDA_LENGTH = 8_000;
/** `meeting_notes.body` is `TEXT`; a note or a decision is prose a person types, not a document. */
const MAX_NOTE_BODY_LENGTH = 8_000;
const NOTE_KINDS: readonly MeetingNoteKind[] = ['note', 'decision'];

interface CreateMeetingNoteBody {
  readonly kind?: unknown;
  readonly body?: unknown;
}

@Controller('v1/organizations/:orgSlug/meetings')
export class MeetingsController {
  constructor(@Inject(MEETINGS_SERVICE) private readonly meetings: MeetingsService) {}

  @Get()
  @RequireCapability('meeting.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('includeCancelled') includeCancelled?: string,
  ): Promise<{ readonly meetings: readonly MeetingView[] }> {
    // 0237 (owner bug 1): no project = every meeting the caller may read, in a time window.
    if (projectId === undefined || projectId === '') {
      const details: { field: string; message: string }[] = [];
      const fromAt = from === undefined ? undefined : parseInstant(from, details, 'from');
      const toAt = to === undefined ? undefined : parseInstant(to, details, 'to');
      if (details.length > 0) {
        throw new ApiError(400, 'validation_failed', 'The request is invalid', details);
      }
      return {
        meetings: await this.meetings.listWindow(context, principal, {
          ...(fromAt ? { from: fromAt } : {}),
          ...(toAt ? { to: toAt } : {}),
          includeCancelled: includeCancelled === 'true',
        }),
      };
    }
    if (typeof projectId !== 'string') {
      throw new ApiError(400, 'validation_failed', 'projectId must be a string', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      meetings: await this.meetings.list(context, principal, {
        projectId,
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateMeetingBody,
  ): Promise<MeetingView> {
    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const agendaNote =
      typeof body?.agendaNote === 'string' && body.agendaNote !== '' ? body.agendaNote : undefined;

    const details = [
      ...(projectId ? [] : [{ field: 'projectId', message: 'must be a non-empty string' }]),
      ...(title ? [] : [{ field: 'title', message: 'must be a non-empty string' }]),
      ...(title && title.length > MAX_TITLE_LENGTH
        ? [{ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(agendaNote !== undefined && agendaNote.length > MAX_AGENDA_LENGTH
        ? [{ field: 'agendaNote', message: `must be ${MAX_AGENDA_LENGTH} characters or fewer` }]
        : []),
    ];

    const startsAt = parseInstant(body?.startsAt, details);
    const endsAt = parseOptionalInstant(body?.endsAt, details, 'endsAt');
    const attendeeUserIds = parseUserIds(body?.attendeeUserIds, details);
    // 0237. Every Google Calendar option, guests by email and Drive/OneDrive attachments.
    const options = parseMeetingOptions(body as Record<string, unknown>, details);
    const attendees = parseAttendees(body?.attendees, details);
    const guests = parseGuests(body?.guests, details);
    const attachments = parseAttachments(body?.attachments, details);

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through: the
    // guard is on a separate array rather than on these bindings.
    if (!projectId || !title || !startsAt) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.meetings.create(context, principal, {
      projectId,
      title,
      startsAt,
      ...(endsAt ? { endsAt } : {}),
      ...(agendaNote === undefined ? {} : { agendaNote }),
      ...(attendeeUserIds ? { attendeeUserIds } : {}),
      ...(hasAnyOption(options) ? { options } : {}),
      ...(attendees ? { attendees } : {}),
      ...(guests ? { guests } : {}),
      ...(attachments ? { attachments } : {}),
    });
  }

  /**
   * Audit gap 8 (COL-06): edit a meeting after creation — title, start, end (after start) and the
   * agenda note. Absent fields are left alone; `endsAt`/`agendaNote` accept `null` to clear.
   */
  @Patch(':meetingId')
  @RequireCapability('meeting.write')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: UpdateMeetingBody,
  ): Promise<MeetingView> {
    const details: { field: string; message: string }[] = [];
    if (!meetingId) details.push({ field: 'meetingId', message: 'must be a non-empty string' });

    let title: string | undefined;
    if (body?.title !== undefined) {
      title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) details.push({ field: 'title', message: 'must be a non-empty string' });
      else if (title.length > MAX_TITLE_LENGTH) {
        details.push({
          field: 'title',
          message: `must be ${MAX_TITLE_LENGTH} characters or fewer`,
        });
      }
    }

    let agendaNote: string | null | undefined;
    if (body?.agendaNote !== undefined) {
      if (body.agendaNote === null || body.agendaNote === '') agendaNote = null;
      else if (typeof body.agendaNote !== 'string') {
        details.push({ field: 'agendaNote', message: 'must be a string or null' });
      } else if (body.agendaNote.length > MAX_AGENDA_LENGTH) {
        details.push({
          field: 'agendaNote',
          message: `must be ${MAX_AGENDA_LENGTH} characters or fewer`,
        });
      } else agendaNote = body.agendaNote;
    }

    const startsAt =
      body?.startsAt === undefined ? undefined : parseInstant(body.startsAt, details);
    const endsAt = parseOptionalInstant(body?.endsAt, details, 'endsAt');
    const options = parseMeetingOptions(body as Record<string, unknown>, details);

    if (
      details.length === 0 &&
      title === undefined &&
      agendaNote === undefined &&
      startsAt === undefined &&
      endsAt === undefined &&
      !hasAnyOption(options)
    ) {
      details.push({ field: 'body', message: 'must change at least one field' });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.meetings.update(context, principal, meetingId, {
      ...(title !== undefined ? { title } : {}),
      ...(startsAt !== undefined ? { startsAt } : {}),
      ...(endsAt !== undefined ? { endsAt } : {}),
      ...(agendaNote !== undefined ? { agendaNote } : {}),
      ...(hasAnyOption(options) ? { options } : {}),
    });
  }

  /**
   * 0237 (owner bug 2). The meeting page in one read: the meeting, its options, everyone invited
   * with their answer, the Meet/Teams link and sync state, and the attachments. A sub-path, not a
   * bare `GET :meetingId`, which would clash with the sibling `agenda`/`grid` routes.
   */
  @Get(':meetingId/overview')
  @RequireCapability('meeting.read')
  async overview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingOverviewView> {
    return this.meetings.overview(context, principal, meetingId);
  }

  /** 0237. Cancel; the organizer's calendar event is deleted and Google/Outlook tell the guests. */
  @Post(':meetingId/cancel')
  @RequireCapability('meeting.write')
  @HttpCode(200)
  async cancel(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingView> {
    return this.meetings.cancel(context, principal, meetingId);
  }

  /** 0237. "Retry": push to the organizer's calendar again and pull the answers back. */
  @Post(':meetingId/sync')
  @RequireCapability('meeting.write')
  @HttpCode(200)
  async sync(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<MeetingOverviewView> {
    return this.meetings.syncNow(context, principal, meetingId);
  }

  @Get(':meetingId/guests')
  @RequireCapability('meeting.read')
  async listGuests(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
  ): Promise<{ readonly guests: readonly MeetingGuestEntry[] }> {
    return { guests: await this.meetings.listGuests(context, principal, meetingId) };
  }

  /** 0237. Invite someone by email who is not a TManage user. */
  @Post(':meetingId/guests')
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async addGuest(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: unknown,
  ): Promise<MeetingGuestEntry> {
    const details: { field: string; message: string }[] = [];
    const guest = parseGuest(body, details, 'body');
    if (!guest || details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    return this.meetings.addGuest(context, principal, meetingId, guest);
  }

  @Delete(':meetingId/guests/:guestId')
  @RequireCapability('meeting.write')
  @HttpCode(204)
  async removeGuest(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Param('guestId') guestId: string,
  ): Promise<void> {
    await this.meetings.removeGuest(context, principal, meetingId, guestId);
  }

  /**
   * List a meeting's captured notes and decisions (x105). The meeting is named by the path — the
   * service resolves it tenant-scoped and relation-checks the caller before the read, so an
   * unknown or unreadable meeting is a 404, never an empty list that would confirm existence.
   */
  @Get(':meetingId/notes')
  @RequireCapability('meeting.read')
  async listNotes(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly notes: readonly MeetingNoteView[] }> {
    if (typeof meetingId !== 'string' || meetingId === '') {
      throw new ApiError(400, 'validation_failed', 'meetingId is required', [
        { field: 'meetingId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      notes: await this.meetings.listNotes(context, principal, {
        meetingId,
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  /**
   * Capture a note or a decision against a meeting (x105). The meeting is named by the path and
   * resolved tenant-scoped before the relation check (the Known-trap order), so an unknown or
   * cross-tenant meeting id is a 404 with no write, never a 500.
   */
  @Post(':meetingId/notes')
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async createNote(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: CreateMeetingNoteBody,
  ): Promise<MeetingNoteView> {
    const kind =
      typeof body?.kind === 'string' && (NOTE_KINDS as readonly string[]).includes(body.kind)
        ? (body.kind as MeetingNoteKind)
        : undefined;
    const noteBody = typeof body?.body === 'string' ? body.body.trim() : undefined;

    const details = [
      ...(meetingId ? [] : [{ field: 'meetingId', message: 'must be a non-empty string' }]),
      ...(kind ? [] : [{ field: 'kind', message: "must be 'note' or 'decision'" }]),
      ...(noteBody ? [] : [{ field: 'body', message: 'must be a non-empty string' }]),
      ...(noteBody && noteBody.length > MAX_NOTE_BODY_LENGTH
        ? [{ field: 'body', message: `must be ${MAX_NOTE_BODY_LENGTH} characters or fewer` }]
        : []),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!meetingId || !kind || !noteBody) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.meetings.createNote(context, principal, {
      meetingId,
      kind,
      body: noteBody,
    });
  }
}

/**
 * Validate an ISO-8601 instant and return it as a `Date`, or add a field error.
 *
 * A meeting's start is a point in time, not a calendar date (unlike `projects.forecast_at`), so
 * it is parsed to a `Date` and stored as a UTC instant. `undefined` for an absent or rejected
 * value alike; the caller reads `details` to tell them apart.
 */
function parseInstant(
  raw: unknown,
  details: { field: string; message: string }[],
  field = 'startsAt',
): Date | undefined {
  if (raw === undefined || raw === null || raw === '') {
    details.push({ field, message: 'is required' });
    return undefined;
  }
  if (typeof raw !== 'string') {
    details.push({ field, message: 'must be an ISO-8601 date-time string' });
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: 'must be an ISO-8601 date-time string' });
    return undefined;
  }
  return parsed;
}

/** Audit gap 8: an optional instant — `undefined` when absent, `null` when explicitly cleared. */
function parseOptionalInstant(
  raw: unknown,
  details: { field: string; message: string }[],
  field: string,
): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  return parseInstant(raw, details, field) ?? undefined;
}

/** Audit gap 8: an optional array of non-empty user-id strings (at most 100). */
function parseUserIds(
  raw: unknown,
  details: { field: string; message: string }[],
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_ATTENDEES ||
    raw.some((id) => typeof id !== 'string' || id === '')
  ) {
    details.push({
      field: 'attendeeUserIds',
      message: `must be an array of at most ${MAX_ATTENDEES} user ids`,
    });
    return undefined;
  }
  return raw as string[];
}

const MAX_GUESTS = 100;
const MAX_ATTACHMENTS = 20;

/** 0237. `[{userId, optional?}]` (at most 100). */
function parseAttendees(
  raw: unknown,
  details: { field: string; message: string }[],
): readonly MeetingAttendeeInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const valid =
    Array.isArray(raw) &&
    raw.length <= MAX_ATTENDEES &&
    raw.every(
      (a) =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as { userId?: unknown }).userId === 'string' &&
        (a as { userId: string }).userId !== '' &&
        ['undefined', 'boolean'].includes(typeof (a as { optional?: unknown }).optional),
    );
  if (!valid) {
    details.push({
      field: 'attendees',
      message: `must be at most ${MAX_ATTENDEES} of {userId, optional?}`,
    });
    return undefined;
  }
  return (raw as { userId: string; optional?: boolean }[]).map((a) => ({
    userId: a.userId,
    optional: a.optional === true,
  }));
}

/** 0237. One `{email, displayName?, optional?}`. */
function parseGuest(
  raw: unknown,
  details: { field: string; message: string }[],
  field: string,
): MeetingGuestInput | undefined {
  const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    email?: unknown;
    displayName?: unknown;
    optional?: unknown;
  };
  const email = normaliseEmail(entry.email);
  const displayName =
    entry.displayName === undefined || entry.displayName === null || entry.displayName === ''
      ? null
      : typeof entry.displayName === 'string' && entry.displayName.length <= 190
        ? entry.displayName.trim()
        : undefined;
  if (
    !email ||
    displayName === undefined ||
    !['undefined', 'boolean'].includes(typeof entry.optional)
  ) {
    details.push({ field, message: 'must be {email, displayName?, optional?} with a valid email' });
    return undefined;
  }
  return { email, displayName, optional: entry.optional === true };
}

function parseGuests(
  raw: unknown,
  details: { field: string; message: string }[],
): readonly MeetingGuestInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_GUESTS) {
    details.push({ field: 'guests', message: `must be an array of at most ${MAX_GUESTS} guests` });
    return undefined;
  }
  const out: MeetingGuestInput[] = [];
  for (const entry of raw) {
    const guest = parseGuest(entry, details, 'guests');
    if (!guest) return undefined;
    if (!out.some((g) => g.email === guest.email)) out.push(guest);
  }
  return out;
}

/**
 * 0237. Files picked with the Drive/OneDrive pickers. Only the provider's own https links are kept,
 * so a meeting can never carry an arbitrary URL dressed as an attachment.
 */
const ATTACHMENT_HOSTS: Record<'google_drive' | 'onedrive', RegExp> = {
  google_drive: /^https:\/\/(drive|docs)\.google\.com\//,
  onedrive: /^https:\/\/(onedrive\.live\.com|1drv\.ms|[a-z0-9-]+\.sharepoint\.com)\//,
};

function parseAttachments(
  raw: unknown,
  details: { field: string; message: string }[],
): readonly MeetingAttachmentInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const message = `must be at most ${MAX_ATTACHMENTS} of {provider, fileId, title, mimeType, webUrl}`;
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) {
    details.push({ field: 'attachments', message });
    return undefined;
  }
  const out: MeetingAttachmentInput[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    const provider = entry?.['provider'];
    const fileId = entry?.['fileId'];
    const title = entry?.['title'];
    const mimeType = entry?.['mimeType'];
    const webUrl = entry?.['webUrl'];
    const driveId = entry?.['driveId'];
    if (
      (provider !== 'google_drive' && provider !== 'onedrive') ||
      typeof fileId !== 'string' ||
      !/^[A-Za-z0-9_!.-]{1,255}$/.test(fileId) ||
      typeof title !== 'string' ||
      title.trim() === '' ||
      title.length > 255 ||
      typeof mimeType !== 'string' ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ||
      typeof webUrl !== 'string' ||
      webUrl.length > 1024 ||
      !ATTACHMENT_HOSTS[provider].test(webUrl) ||
      (driveId !== undefined &&
        driveId !== null &&
        (typeof driveId !== 'string' || driveId.length > 128))
    ) {
      details.push({ field: 'attachments', message });
      return undefined;
    }
    out.push({
      provider,
      fileId,
      driveId: typeof driveId === 'string' ? driveId : null,
      title: title.trim(),
      mimeType,
      webUrl,
    });
  }
  return out;
}
