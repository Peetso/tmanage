import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { type ApiError } from '../../common/http/errors.js';
import { MeetingsService } from './meetings.service.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { MeetingNotesRepository } from './meeting-notes.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingNoteRow, MeetingRow } from '../../common/database/schema.js';
import { neverByKey, routeKey } from '../ai-actions/registry/index.js';

/** 53-13: AI meeting-note drafts land pending and only a person's review saves or discards them. */
const ORG = 'org-1';
const MEETING = 'meeting-1';
const owner = {
  userId: 'user-1',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as unknown as Principal;
const context = { organizationId: ORG, userId: 'user-1' } as unknown as TenantContext;

function setup() {
  const store: MeetingNoteRow[] = [];
  const work = async (_c: unknown, fn: (r: unknown) => Promise<unknown>) => fn({});
  const database = { read: work, transaction: work } as unknown as TenantDatabase;
  const meetings = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      id === MEETING ? ({ id, organizationId: ORG, projectId: 'p-1' } as MeetingRow) : null,
  } as unknown as MeetingsRepository;
  const notes = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      store.find((n) => n.id === id) ?? null,
    list: async (_r: unknown, _c: unknown, o: { status?: string }) =>
      store.filter((n) => n.status === (o.status ?? 'saved')),
    createDraft: async (_r: unknown, _c: unknown, i: Record<string, string>) => {
      const row = { ...i, id: `d${store.length + 1}`, organizationId: ORG, status: 'pending', source: 'mcp', submittedAt: new Date(), createdAt: new Date() } as unknown as MeetingNoteRow; // prettier-ignore
      store.push(row);
      return row;
    },
    saveDraft: async (_r: unknown, _c: unknown, id: string, i: Partial<MeetingNoteRow>) =>
      Object.assign(
        store.find((n) => n.id === id)!,
        i,
        { status: 'saved' },
      ) !== undefined,
    discardDraft: async (_r: unknown, _c: unknown, id: string) =>
      store.splice(
        store.findIndex((n) => n.id === id),
        1,
      ).length > 0,
  } as unknown as MeetingNotesRepository;
  const service = new MeetingsService(database, meetings, {} as ProjectsRepository, notes);
  return { service, store };
}

describe('meeting note drafts from the customer AI (53-13)', () => {
  it('lands a submitted draft as pending with provenance, outside the saved notes', async () => {
    const { service } = setup();
    const draft = await service.submitNoteDraft(context, owner, { meetingId: MEETING, kind: 'note', body: 'Launch moves', assistantName: 'Claude' }); // prettier-ignore
    expect(draft).toMatchObject({ source: 'mcp', assistantName: 'Claude', authorUserId: 'user-1' });
    expect(await service.listNoteDrafts(context, owner, MEETING)).toHaveLength(1);
    expect(await service.listNotes(context, owner, { meetingId: MEETING })).toHaveLength(0);
  });

  it('saves a reviewed draft with the edits, discards another, and refuses a second review', async () => {
    const { service, store } = setup();
    const a = await service.submitNoteDraft(context, owner, { meetingId: MEETING, kind: 'note', body: 'x', assistantName: 'Claude' }); // prettier-ignore
    const b = await service.submitNoteDraft(context, owner, { meetingId: MEETING, kind: 'note', body: 'y', assistantName: 'Claude' }); // prettier-ignore
    const saved = await service.reviewNoteDraft(context, owner, { meetingId: MEETING, noteId: a.id, decision: 'save', kind: 'decision', body: 'Edited' }); // prettier-ignore
    expect(saved).toMatchObject({ kind: 'decision', body: 'Edited', source: 'mcp' });
    expect(store.find((n) => n.id === a.id)?.reviewedByUserId).toBe('user-1');
    expect(await service.reviewNoteDraft(context, owner, { meetingId: MEETING, noteId: b.id, decision: 'discard' })).toBeNull(); // prettier-ignore
    expect(store.map((n) => n.id)).toEqual([a.id]);
    const again = await service.reviewNoteDraft(context, owner, { meetingId: MEETING, noteId: a.id, decision: 'discard' }).catch((e: unknown) => e); // prettier-ignore
    expect((again as ApiError).status).toBe(404);
  });

  it('withholds the review route from every AI token (NEVER), while submit is an op', () => {
    const base = '/v1/organizations/:orgSlug/meetings/:meetingId/note-drafts';
    expect(neverByKey.has(routeKey('POST', `${base}/:noteId/review`))).toBe(true);
    expect(neverByKey.has(routeKey('POST', base))).toBe(false);
  });
});
