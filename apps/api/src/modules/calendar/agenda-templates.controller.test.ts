import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { AgendaTemplatesController } from './agenda-templates.controller.js';
import { AgendaTemplatesService } from './agenda-templates.service.js';
import type { AgendaTemplatesRepository } from './agenda-templates.repository.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { MeetingNotesRepository } from './meeting-notes.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  MeetingAgendaTemplateRow,
  MeetingNoteRow,
  MeetingRow,
} from '../../common/database/schema.js';

/**
 * CAL agenda templates (x314) — the controller over a real {@link AgendaTemplatesService} (real
 * `authorize()`) with in-memory repositories. The migration and the tenant-scoped SQL round-trip are
 * the chain's DB suite; here the subject is the slice's own decisions: the create→list→apply path
 * with idempotent seeding, the capability refusal on create, and the tenant-scoped 404 on apply.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000000000001';
const AT = new Date('2026-10-01T00:00:00.000Z');

function principal(role: Principal['role'], projectIds: readonly string[] = []): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [...projectIds],
    hasOrgWideScope: role === 'owner',
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function harness(seedMeetings: readonly MeetingRow[] = []): {
  controller: AgendaTemplatesController;
  templateStore: MeetingAgendaTemplateRow[];
  noteStore: MeetingNoteRow[];
} {
  const templateStore: MeetingAgendaTemplateRow[] = [];
  const noteStore: MeetingNoteRow[] = [];
  const meetings = [...seedMeetings];
  let seq = 0;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const templatesRepo = {
    list: async (_r: unknown, ctx: TenantContext) =>
      templateStore.filter((row) => row.organizationId === ctx.organizationId),
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      templateStore.find((row) => row.organizationId === ctx.organizationId && row.id === id) ??
      null,
    create: async (
      _r: unknown,
      ctx: TenantContext,
      input: { name: string; items: MeetingAgendaTemplateRow['itemsJson']; createdBy: string },
    ) => {
      const row = {
        id: `template-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        name: input.name,
        itemsJson: input.items,
        createdBy: input.createdBy,
        createdAt: AT,
        updatedAt: AT,
      } as MeetingAgendaTemplateRow;
      templateStore.push(row);
      return row;
    },
  } as unknown as AgendaTemplatesRepository;

  const meetingsRepo = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      meetings.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
  } as unknown as MeetingsRepository;

  const notesRepo = {
    list: async (_r: unknown, ctx: TenantContext, options: { meetingId: string }) =>
      noteStore.filter(
        (row) => row.organizationId === ctx.organizationId && row.meetingId === options.meetingId,
      ),
    create: async (
      _r: unknown,
      ctx: TenantContext,
      input: {
        meetingId: string;
        kind: MeetingNoteRow['kind'];
        body: string;
        authorUserId: string;
      },
    ) => {
      const row = {
        id: `note-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        meetingId: input.meetingId,
        kind: input.kind,
        body: input.body,
        authorUserId: input.authorUserId,
        createdAt: AT,
      } as MeetingNoteRow;
      noteStore.push(row);
      return row;
    },
  } as unknown as MeetingNotesRepository;

  const service = new AgendaTemplatesService(database, templatesRepo, meetingsRepo, notesRepo);
  return { controller: new AgendaTemplatesController(service), templateStore, noteStore };
}

function meetingRow(id: string, organizationId: string): MeetingRow {
  return {
    id,
    organizationId,
    projectId: PROJECT,
    title: 'Sync',
    startsAt: AT,
    agendaNote: null,
    createdByUserId: USER,
    createdAt: AT,
    updatedAt: AT,
  } as MeetingRow;
}

describe('AgendaTemplatesController', () => {
  it('creates a template, lists it, then applies it to a meeting seeding notes idempotently', async () => {
    const meeting = meetingRow('meeting-0000-0000-0000-000000000001', ORG);
    const { controller, noteStore } = harness([meeting]);
    const owner = principal('owner');

    const created = await controller.create(context, owner, {
      name: 'Standup',
      items: [{ title: 'Blockers' }, { title: 'Updates' }],
    });
    expect(created.name).toBe('Standup');
    expect(created.items.map((i) => i.title)).toEqual(['Blockers', 'Updates']);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(created)).not.toContain(ORG);

    const listed = await controller.list(context, owner);
    expect(listed.templates.map((t) => t.id)).toEqual([created.id]);

    const first = await controller.apply(context, owner, meeting.id, { templateId: created.id });
    expect(first).toMatchObject({ seeded: 2, skipped: 0 });
    expect(noteStore.map((n) => n.body).sort()).toEqual(['Blockers', 'Updates']);

    // Re-applying the same template seeds nothing new — identical titles are skipped.
    const second = await controller.apply(context, owner, meeting.id, { templateId: created.id });
    expect(second).toMatchObject({ seeded: 0, skipped: 2 });
    expect(noteStore).toHaveLength(2);
  });

  it('refuses a create from a role without meeting.write as 403, writing nothing', async () => {
    const { controller, templateStore } = harness();
    // A guest holds meeting.read but not meeting.write.
    const error = await controller
      .create(context, principal('guest'), { name: 'Nope', items: [{ title: 'x' }] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(templateStore).toHaveLength(0);
  });

  it('answers 404 with no write when applying a template to another tenant’s meeting id', async () => {
    // The meeting belongs to a different tenant, so the acting tenant's scoped lookup finds nothing.
    const foreign = meetingRow(
      'meeting-0000-0000-0000-000000000009',
      'organization-other-00000002',
    );
    const { controller, noteStore } = harness([foreign]);

    const error = await controller
      .apply(context, principal('owner'), foreign.id, { templateId: 'template-anything' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(noteStore).toHaveLength(0);
  });
});
