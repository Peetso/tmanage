import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { MeetingsService } from './meetings.service.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { MeetingNotesRepository } from './meeting-notes.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingNoteRow, MeetingRow } from '../../common/database/schema.js';

/**
 * CAL-01 / MTG-01 second slice (x105) service proofs, database-free over the module's fakes and
 * the module's **real** `authorize`. The migration and the tenant-scoped SQL round-trip are
 * proven separately in `apps/api/test/migrator.db.test.ts` and
 * `apps/api/test/calendar-002-meeting-notes.db.test.ts`; here the subject is the note service's
 * own logic — the create→list round-trip, the relation gate, and the Known-trap order (an
 * unknown or cross-tenant meeting id is a 404 with no write, never a 500).
 *
 * The fake note `list` deliberately does **not** apply the tenant scope the real SQL applies, so
 * the test relies on the service having authorised the meeting before the read; the relation gate
 * lives on the meeting, and the notes inherit it.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const MEETING = 'meeting-0000-0000-0000-0000-000000000001';
/** A meeting id that resolves to no row inside the tenant (unknown or another tenant's). */
const UNKNOWN_MEETING = 'meeting-0000-0000-0000-0000-0000000000ff';
const USER = 'user-0000-0000-0000-0000-000000000001';

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/**
 * A service over an in-memory note store whose `list` omits the tenant scope on purpose.
 *
 * `meetingsById` is the set of meetings the fake `MeetingsRepository.findById` resolves inside
 * the tenant; anything else returns `null`, standing in for an unknown or cross-tenant meeting.
 * The note store's `create` is what a write reaches, so a meeting must resolve *and* the relation
 * check pass for a row to be appended.
 */
function serviceWith(seed: readonly MeetingNoteRow[] = []): {
  service: MeetingsService;
  store: MeetingNoteRow[];
} {
  const store: MeetingNoteRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const meetingsRepo = {
    findById: async (_runner: unknown, _ctx: unknown, meetingId: string) =>
      meetingId === MEETING
        ? ({ id: MEETING, organizationId: ORG, projectId: PROJECT } as unknown as MeetingRow)
        : null,
  } as unknown as MeetingsRepository;

  const notesRepo = {
    list: async (
      _runner: unknown,
      _ctx: unknown,
      options: { readonly meetingId: string; readonly after?: string },
    ) =>
      store.filter(
        (row) =>
          row.meetingId === options.meetingId &&
          (options.after === undefined || row.id > options.after),
      ),
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly meetingId: string;
        readonly kind: 'note' | 'decision';
        readonly body: string;
        readonly authorUserId: string;
      },
    ) => {
      const row = {
        id: `note-0000-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        meetingId: input.meetingId,
        kind: input.kind,
        body: input.body,
        authorUserId: input.authorUserId,
        createdAt: new Date(),
      } as MeetingNoteRow;
      store.push(row);
      return row;
    },
  } as unknown as MeetingNotesRepository;

  const projects = {} as unknown as ProjectsRepository;
  return { service: new MeetingsService(database, meetingsRepo, projects, notesRepo), store };
}

describe('MeetingsService notes/decisions (x105)', () => {
  it('captures a note and a decision, then reads them back deterministically for a member', async () => {
    const { service } = serviceWith();

    const note = await service.createNote(context, member([PROJECT]), {
      meetingId: MEETING,
      kind: 'note',
      body: 'A loose note',
    });
    const decision = await service.createNote(context, member([PROJECT]), {
      meetingId: MEETING,
      kind: 'decision',
      body: 'We ship Friday',
    });

    expect(note.kind).toBe('note');
    expect(decision.kind).toBe('decision');
    expect(note.authorUserId).toBe(USER);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(note)).not.toContain(ORG);

    const listed = await service.listNotes(context, member([PROJECT]), { meetingId: MEETING });
    expect(listed.map((n) => n.id)).toEqual([note.id, decision.id]);
    expect(listed.map((n) => n.kind)).toEqual(['note', 'decision']);
  });

  it('refuses a capture into a meeting the caller is not on the project relation of, as not-found', async () => {
    const { service, store } = serviceWith();
    const error = await service
      .createNote(context, member([]), { meetingId: MEETING, kind: 'note', body: 'Sneaky' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('refuses a capture naming an unknown or cross-tenant meeting as not-found, and writes nothing (Known trap)', async () => {
    // An org-wide role (owner) passes the relation gate, so without the tenant-scoped meeting
    // resolution an unknown meetingId would fall through to the composite foreign key and surface
    // as a 500. Resolving the meeting first maps the lookup miss to 404 with no write.
    const { service, store } = serviceWith();
    const error = await service
      .createNote(context, member([], true), {
        meetingId: UNKNOWN_MEETING,
        kind: 'note',
        body: 'No such meeting',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('hides a meeting’s notes from a non-member as not-found rather than an empty list', async () => {
    const seeded = {
      id: 'note-0000-0000-0000-0000-000000000010',
      organizationId: ORG,
      meetingId: MEETING,
      kind: 'note',
      body: 'Members only',
      authorUserId: USER,
      createdAt: new Date(),
    } as MeetingNoteRow;
    const { service } = serviceWith([seeded]);

    const error = await service
      .listNotes(context, member([]), { meetingId: MEETING })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);

    // An org-wide role passes the relation gate and reads the meeting's notes.
    const asOwner = await service.listNotes(context, member([], true), { meetingId: MEETING });
    expect(asOwner.map((n) => n.id)).toEqual([seeded.id]);
  });

  it('returns not-found when listing an unknown meeting', async () => {
    const { service } = serviceWith();
    const error = await service
      .listNotes(context, member([], true), { meetingId: UNKNOWN_MEETING })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});
