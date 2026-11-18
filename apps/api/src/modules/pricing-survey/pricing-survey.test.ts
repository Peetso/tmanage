import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { PricingSurveyController } from './pricing-survey.controller.js';
import { buildPlatformPricingSurveyView } from './pricing-survey-platform.controller.js';
import { PricingSurveyRepository } from './pricing-survey.repository.js';
import type { PricingSurveyState } from './pricing-survey.repository.js';
import { PRICING_SURVEY_NOTE_MAX } from './pricing-survey.rules.js';

const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b2';
const NOW = new Date('2026-11-18T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function contextFor(organizationId: string, membershipId = 'm1'): TenantContext {
  return { organizationId, membershipId, userId: 'u1' } as TenantContext;
}

function principal(
  role: string,
  kind: 'internal' | 'client' = 'internal',
  organizationId = ORG_A,
): Principal {
  return {
    userId: 'u1',
    organizationId,
    kind,
    role,
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? 'c1' : null,
    projectIds: [],
    hasOrgWideScope: kind === 'internal',
  } as Principal;
}

/** Answers keyed by organization and membership, like the table's unique key. */
class FakeRepository {
  readonly answers = new Map<
    string,
    { outcome: string; band: string | null; note: string | null }
  >();
  createdAt = new Map<string, Date>([
    [ORG_A, new Date(NOW.getTime() - 30 * DAY)],
    [ORG_B, new Date(NOW.getTime() - 30 * DAY)],
  ]);
  duplicateOnInsert = false;
  readState = (_r: unknown, context: TenantContext): Promise<PricingSurveyState> =>
    Promise.resolve({
      workspaceCreatedAt: this.createdAt.get(context.organizationId) ?? null,
      alreadyResponded: this.answers.has(`${context.organizationId}/${context.membershipId}`),
    });
  insert = (
    _r: unknown,
    context: TenantContext,
    answer: { outcome: string; band: string | null; note: string | null },
  ): Promise<void> => {
    const key = `${context.organizationId}/${context.membershipId}`;
    if (this.duplicateOnInsert || this.answers.has(key)) {
      return Promise.reject(Object.assign(new Error('Duplicate entry'), { errno: 1062 }));
    }
    this.answers.set(key, { outcome: answer.outcome, band: answer.band, note: answer.note });
    return Promise.resolve();
  };
}

function controllerWith(repo: FakeRepository): PricingSurveyController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new PricingSurveyController(
    database,
    repo as unknown as PricingSurveyRepository,
    () => NOW,
  );
}

async function status(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return error === null ? 200 : (error as ApiError).status;
}

describe('PricingSurveyController (57-17 WTP)', () => {
  it('shows the card to owners and admins, never to members, managers or guests', async () => {
    const controller = controllerWith(new FakeRepository());
    const context = contextFor(ORG_A);
    for (const role of ['owner', 'org_admin', 'workspace_admin']) {
      expect((await controller.read(context, principal(role))).show).toBe(true);
    }
    for (const role of ['member', 'manager', 'moderator', 'guest', 'platform_support']) {
      expect((await controller.read(context, principal(role))).show).toBe(false);
    }
  });

  it('refuses an answer or a skip from a member with 403 and stores nothing', async () => {
    const repo = new FakeRepository();
    const controller = controllerWith(repo);
    const context = contextFor(ORG_A);
    expect(await status(controller.answer(context, principal('member'), { band: '5_9' }))).toBe(
      403,
    );
    expect(await status(controller.skip(context, principal('guest')))).toBe(403);
    expect(repo.answers.size).toBe(0);
  });

  it('never shows the card to a client, portal user or client admin, and refuses their writes', async () => {
    const repo = new FakeRepository();
    const controller = controllerWith(repo);
    const context = contextFor(ORG_A);
    for (const role of ['client_admin', 'client_reviewer', 'client_member', 'client_viewer']) {
      expect((await controller.read(context, principal(role, 'client'))).show).toBe(false);
      expect(
        await status(controller.answer(context, principal(role, 'client'), { band: 'nothing' })),
      ).toBe(403);
    }
    // A client principal carrying an internal role name is still a client.
    expect((await controller.read(context, principal('owner', 'client'))).show).toBe(false);
    expect(repo.answers.size).toBe(0);
  });

  it('waits until the workspace is 14 days old, on the read and on the write', async () => {
    const repo = new FakeRepository();
    const controller = controllerWith(repo);
    const context = contextFor(ORG_A);
    repo.createdAt.set(ORG_A, new Date(NOW.getTime() - 13 * DAY));
    expect((await controller.read(context, principal('owner'))).show).toBe(false);
    expect(await status(controller.answer(context, principal('owner'), { band: '5_9' }))).toBe(403);
    expect(await status(controller.skip(context, principal('owner')))).toBe(403);
    expect(repo.answers.size).toBe(0);
    repo.createdAt.set(ORG_A, new Date(NOW.getTime() - 14 * DAY));
    expect((await controller.read(context, principal('owner'))).show).toBe(true);
  });

  it('takes one answer or skip per person: the second is 409 and the card stays hidden', async () => {
    const repo = new FakeRepository();
    const controller = controllerWith(repo);
    const context = contextFor(ORG_A);
    const sent = await controller.answer(context, principal('owner'), {
      band: '10_15',
      note: '  Fair if clients are free  ',
    });
    expect(sent).toEqual({ show: false, outcome: 'answered' });
    expect(repo.answers.get(`${ORG_A}/m1`)).toEqual({
      outcome: 'answered',
      band: '10_15',
      note: 'Fair if clients are free',
    });
    expect(await status(controller.answer(context, principal('owner'), { band: 'nothing' }))).toBe(
      409,
    );
    expect(await status(controller.skip(context, principal('owner')))).toBe(409);
    expect((await controller.read(context, principal('owner'))).show).toBe(false);
    // Another admin of the same workspace still gets their own question.
    expect((await controller.read(contextFor(ORG_A, 'm2'), principal('org_admin'))).show).toBe(
      true,
    );
  });

  it('maps a racing second insert (the unique key) to 409', async () => {
    const repo = new FakeRepository();
    repo.duplicateOnInsert = true;
    expect(await status(controllerWith(repo).skip(contextFor(ORG_A), principal('owner')))).toBe(
      409,
    );
  });

  it('keeps answers per workspace: an answer in one does not hide the card in another', async () => {
    const repo = new FakeRepository();
    const controller = controllerWith(repo);
    await controller.skip(contextFor(ORG_A), principal('owner'));
    expect(repo.answers.get(`${ORG_A}/m1`)?.outcome).toBe('skipped');
    expect((await controller.read(contextFor(ORG_A), principal('owner'))).show).toBe(false);
    expect(
      (await controller.read(contextFor(ORG_B), principal('owner', 'internal', ORG_B))).show,
    ).toBe(true);
  });

  it('validates the band and caps the note at 500 characters', async () => {
    const repo = new FakeRepository();
    const controller = controllerWith(repo);
    const context = contextFor(ORG_A);
    expect(await status(controller.answer(context, principal('owner'), { band: '99' }))).toBe(400);
    expect(await status(controller.answer(context, principal('owner'), {}))).toBe(400);
    expect(
      await status(
        controller.answer(context, principal('owner'), {
          band: 'under_5',
          note: 'x'.repeat(PRICING_SURVEY_NOTE_MAX + 1),
        }),
      ),
    ).toBe(400);
    expect(
      await status(controller.answer(context, principal('owner'), { band: 'under_5', note: 5 })),
    ).toBe(400);
    expect(repo.answers.size).toBe(0);
    await controller.answer(context, principal('owner'), {
      band: 'under_5',
      note: 'x'.repeat(PRICING_SURVEY_NOTE_MAX),
    });
    expect(repo.answers.get(`${ORG_A}/m1`)?.note).toHaveLength(PRICING_SURVEY_NOTE_MAX);
  });
});

describe('PricingSurveyRepository (57-17 WTP) — tenant scoping', () => {
  it('binds every statement to the context organization and the acting membership', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const runner = {
      execute: (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return Promise.resolve([]);
      },
    } as unknown as TenantQueryRunner;
    const repository = new PricingSurveyRepository();
    const context = contextFor(ORG_B, 'm9');
    await repository.readState(runner, context);
    await repository.insert(runner, context, {
      outcome: 'answered',
      band: 'over_15',
      note: null,
      answeredAt: NOW,
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.sql).toMatch(/where o\.id = \?/);
    expect(calls[0]?.params).toEqual([ORG_B]);
    expect(calls[1]?.sql).toMatch(/psa\.organization_id = \? and psa\.membership_id = \?/);
    expect(calls[1]?.params).toEqual([ORG_B, 'm9']);
    expect(calls[2]?.params.slice(1, 3)).toEqual([ORG_B, 'm9']);
  });
});

describe('buildPlatformPricingSurveyView (57-17 WTP)', () => {
  it('counts answers by band, counts skips, and lists rows newest first as given', () => {
    const view = buildPlatformPricingSurveyView([
      {
        organizationName: 'Nile Studio',
        outcome: 'answered',
        band: '5_9',
        note: 'ok',
        answeredAt: NOW,
      },
      { organizationName: 'Atlas', outcome: 'skipped', band: null, note: null, answeredAt: NOW },
      { organizationName: 'Atlas', outcome: 'answered', band: '5_9', note: null, answeredAt: NOW },
    ]);
    expect(view.answered).toBe(2);
    expect(view.skipped).toBe(1);
    expect(view.byBand.find((entry) => entry.band === '5_9')?.count).toBe(2);
    expect(view.byBand.map((entry) => entry.band)).toEqual([
      'nothing',
      'under_5',
      '5_9',
      '10_15',
      'over_15',
    ]);
    expect(view.rows[0]).toEqual({
      organizationName: 'Nile Studio',
      outcome: 'answered',
      band: '5_9',
      note: 'ok',
      answeredAt: NOW.toISOString(),
    });
  });
});
