import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type {
  ClientJourneyStepRow,
  ClientProjectionRow,
  ProjectMilestoneRow,
  WorkFormRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PublicFormsRepository } from '../public-forms/public-forms.repository.js';
import type { ClientReview } from '../approvals/client-review.js';
import { deriveJourney } from './portal-journey.js';
import type { JourneyEvidence } from './portal-journey.js';
import { PortalJourneyService } from './portal-journey.service.js';
import type { PortalJourneyRepository } from './portal-journey.repository.js';
import type { JourneyStepsRepository } from './journey-steps.repository.js';

const milestone = (id: string, status: ProjectMilestoneRow['status']) =>
  ({ id, title: `t-${id}`, clientTitle: null, dueOn: null, status }) as ProjectMilestoneRow;
const version = (deliverableId: string, id: string, at: string) =>
  ({
    deliverableId,
    deliverableVersionId: id,
    publishedAt: new Date(at),
    projection: { title: id, decision: null },
  }) as ClientProjectionRow;
const awaitingYou: ClientReview = { state: 'awaiting_decision', awaitingYou: true };
const reviews = (entries: Record<string, ClientReview>): ReadonlyMap<string, ClientReview> =>
  new Map(Object.entries(entries));
const step = (id: string, kind: ClientJourneyStepRow['kind'], more: object = {}) =>
  ({
    id,
    kind,
    title: id,
    refId: null,
    evidenceId: null,
    projectId: 'own-project',
    clientOrganizationId: 'client-a',
    createdAt: new Date('2026-11-10'),
    ...more,
  }) as ClientJourneyStepRow;
const none: JourneyEvidence = {
  signedRequestIds: new Set(),
  acceptedMeetingIds: new Set(),
  lastUploadAt: null,
};
const principal = {
  kind: 'client',
  role: 'client_member',
  organizationId: 'org',
  clientOrganizationId: 'client-a',
  projectIds: ['own-project'],
  hasOrgWideScope: false,
  membershipStatus: 'active',
} as unknown as Principal;
const context = { organizationId: 'org' } as TenantContext;

describe('52-27 client journey', () => {
  it('marks steps done/now/next and picks the oldest newest version awaiting you as the turn', () => {
    const journey = deriveJourney(
      'p1',
      { steps: [], evidence: none },
      [milestone('a', 'met'), milestone('b', 'missed'), milestone('c', 'planned')],
      [
        version('d1', 'd1-v2', '2026-11-12'),
        version('d2', 'd2-v1', '2026-11-11'),
        version('d1', 'd1-v1', '2026-11-01'),
      ],
      reviews({ 'd1-v2': awaitingYou, 'd2-v1': awaitingYou, 'd1-v1': awaitingYou }),
    );
    expect(journey.steps.map((s) => s.state)).toEqual(['done', 'now', 'next']);
    expect(journey.yourTurn).toMatchObject({ kind: 'review', deliverableVersionId: 'd2-v1' });
    expect(journey.completed).toBe(false);
  });

  it('never offers a decided, unasked or someone-else version as your turn (TESTUX P1 4/5)', () => {
    const versions = [
      version('d1', 'approved', '2026-11-10'),
      version('d2', 'asked-of-other', '2026-11-09'),
      version('d3', 'shared-only', '2026-11-08'),
      version('d4', 'waiting', '2026-11-11'),
    ];
    const live = reviews({
      approved: { state: 'approved', awaitingYou: false },
      'asked-of-other': { state: 'awaiting_decision', awaitingYou: false },
      waiting: awaitingYou,
    });
    const journey = deriveJourney('p1', { steps: [], evidence: none }, [], versions, live);
    expect(journey.yourTurn).toMatchObject({ kind: 'review', deliverableVersionId: 'waiting' });

    const afterDecision = reviews({ approved: { state: 'approved', awaitingYou: false } });
    expect(
      deriveJourney('p1', { steps: [], evidence: none }, [], versions, afterDecision).yourTurn,
    ).toBeNull();
  });

  it('completes a step only from its server-side evidence', () => {
    const steps = [
      step('f', 'form', { refId: 'form-1', evidenceId: 'sub-1' }),
      step('s', 'sign', { refId: 'req-1' }),
      step('u', 'upload'),
    ];
    const without = deriveJourney('p1', { steps, evidence: none }, [], [], new Map());
    expect(without.steps.map((s) => s.state)).toEqual(['done', 'now', 'next']);
    expect(without.yourTurn).toEqual({ kind: 'sign', stepId: 's', title: 's', targetId: 'req-1' });

    const evidence = {
      ...none,
      signedRequestIds: new Set(['req-1']),
      lastUploadAt: new Date('2026-11-01'), // before the step was set: not this step's upload
    };
    const signed = deriveJourney('p1', { steps, evidence }, [], [], new Map());
    expect(signed.steps.map((s) => s.state)).toEqual(['done', 'done', 'now']);
    expect(signed.yourTurn).toMatchObject({ kind: 'upload', targetId: null });
  });
});

describe('52-27 portal journey service', () => {
  const unreachable = {
    read: () => Promise.reject(new Error('read before the relation check')),
  } as unknown as TenantDatabase;

  it("refuses another client's project with 404 before reading", async () => {
    const service = new PortalJourneyService(unreachable, {} as PortalJourneyRepository);
    await expect(service.forProject(context, principal, 'other-project')).rejects.toMatchObject({
      status: 404,
    });
  });

  const form = { id: 'form-1', name: 'Brief', fieldsJson: [] } as unknown as WorkFormRow;
  const serviceFor = (found: ClientJourneyStepRow, writes: string[]) => {
    const database = {
      read: (_: unknown, work: (runner: unknown) => unknown) => work({}),
      transaction: (_: unknown, work: (runner: unknown) => unknown) => work({}),
    } as unknown as TenantDatabase;
    const steps = {
      findById: () => Promise.resolve(found),
      recordFormEvidence: () => (writes.push('evidence'), Promise.resolve(true)),
    } as unknown as JourneyStepsRepository;
    const forms = {
      findForm: () => Promise.resolve(form),
      insertSubmission: () => (writes.push('submission'), Promise.resolve('sub-1')),
    } as unknown as PublicFormsRepository;
    return new PortalJourneyService(database, {} as PortalJourneyRepository, steps, forms);
  };

  it("answers 404 for another client's form step and writes nothing", async () => {
    const writes: string[] = [];
    const other = step('f', 'form', { refId: 'form-1', clientOrganizationId: 'client-b' });
    await expect(
      serviceFor(other, writes).submitForm(context, principal, 'f', {}),
    ).rejects.toMatchObject({ status: 404 });
    expect(writes).toEqual([]);
  });

  it('stores the submission before it records the step, and refuses a second answer', async () => {
    const writes: string[] = [];
    const own = step('f', 'form', { refId: 'form-1' });
    await serviceFor(own, writes).submitForm(context, principal, 'f', {});
    expect(writes).toEqual(['submission', 'evidence']);

    const answered = step('f', 'form', { refId: 'form-1', evidenceId: 'sub-1' });
    await expect(
      serviceFor(answered, []).submitForm(context, principal, 'f', {}),
    ).rejects.toMatchObject({ status: 409 });
  });
});
