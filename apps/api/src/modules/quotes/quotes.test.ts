import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { PublicLinkRow, QuoteLineRow, QuoteRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { computeTotals, contentHash, validateQuote } from './quote-content.js';
import { conversionPlan } from './quote-conversion.js';
import { quoteTarget } from './quote-target.js';
import type { QuotesRepository } from './quotes.repository.js';
import { QuotesService } from './quotes.service.js';

const now = new Date('2026-10-30T10:00:00.000Z');
const runner = {} as TenantQueryRunner;
const context = { organizationId: 'org-1' } as TenantContext;
const quote = {
  id: 'q-1',
  number: 'Q-0001',
  title: 'Website',
  currency: 'USD',
  language: 'en',
  clientOrganizationId: null,
  leadName: 'Lead',
  leadEmail: null,
  validUntil: new Date('2026-11-30T23:59:59.999Z'),
  termsText: null,
  subtotalMinor: 100,
  taxMinor: 0,
  totalMinor: 100,
  status: 'sent',
  contentHash: 'h'.repeat(64),
} as QuoteRow;

describe('52-08 quotes', () => {
  it('computes totals on the server in exact half-up minor units', () => {
    const t = computeTotals([
      { description: 'a', unit: 'hour', quantityCenti: 150, unitPriceMinor: 333, taxBp: 1400 },
      { description: 'b', unit: 'item', quantityCenti: 100, unitPriceMinor: 999_999_999, taxBp: 0 },
    ]);
    expect(t.lines.map((l) => [l.lineNetMinor, l.lineTaxMinor])).toEqual([
      [500, 70],
      [999_999_999, 0],
    ]);
    expect(t.totalMinor).toBe(500 + 70 + 999_999_999);
  });

  it('refuses a quantity with more than two decimals and needs a client or lead', () => {
    const base = { title: 'x', currency: 'USD', leadName: 'L' };
    const line = { description: 'd', unitPriceMinor: 1 };
    expect(() => validateQuote({ ...base, lines: [{ ...line, quantity: 1.005 }] }, now)).toThrow();
    expect(() => validateQuote({ title: 'x', currency: 'USD', lines: [line] }, now)).toThrow();
  });

  it('binds a content hash that changes with any accepted content', () => {
    expect(contentHash(quote, [])).toBe(contentHash({ ...quote }, []));
    expect(contentHash({ ...quote, totalMinor: 101 }, [])).not.toBe(contentHash(quote, []));
  });

  it('reaches only a sent, unexpired quote and moves it on the link decision', async () => {
    const repository = {
      find: vi.fn().mockResolvedValue(quote),
      lines: vi.fn().mockResolvedValue([]),
      decide: vi.fn().mockResolvedValue(true),
    };
    const audit = { record: vi.fn() };
    const target = quoteTarget({ repository, audit, now: () => now });
    expect(target.decisionsRequiringCode).toEqual(['accept']);
    expect((await target.resolve(runner, context, 'q-1'))?.versionHash).toBe(quote.contentHash);
    repository.find.mockResolvedValueOnce({ ...quote, status: 'draft' });
    expect(await target.resolve(runner, context, 'q-1')).toBeNull();
    const link = { id: 'l-1', targetId: 'q-1', versionHash: quote.contentHash } as PublicLinkRow;
    await target.onDecision?.(runner, context, link, 'accept');
    expect(repository.decide).toHaveBeenCalledWith(
      runner,
      context,
      'q-1',
      quote.contentHash,
      'accepted',
      now,
    );
    repository.decide.mockResolvedValueOnce(false);
    await expect(target.onDecision?.(runner, context, link, 'decline')).rejects.toThrow();
  });
});

describe('52-08 quotes · convert to project', () => {
  const owner = {
    userId: 'u-1',
    organizationId: 'org-1',
    kind: 'internal',
    role: 'owner',
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as unknown as Principal;
  const accepted = {
    ...quote,
    status: 'accepted',
    sentAt: now,
    sentLinkId: null,
    decidedAt: now,
    convertedProjectId: null,
    convertedAt: null,
    version: 3,
    createdAt: now,
    updatedAt: now,
  } as QuoteRow;
  const lines = [
    { position: 1, description: 'Design' },
    { position: 0, description: 'Discovery' },
  ] as QuoteLineRow[];

  function harness(row: QuoteRow) {
    const repository = {
      find: vi.fn().mockResolvedValue(row),
      lines: vi.fn().mockResolvedValue(lines),
      clientExists: vi.fn().mockResolvedValue(false),
      markConverted: vi.fn().mockResolvedValue(true),
    };
    const projects = {
      requireMayCreate: vi.fn().mockResolvedValue(undefined),
      createInTransaction: vi.fn().mockResolvedValue({ id: 'p-1' }),
    };
    const conversion = {
      workspaceFor: vi.fn().mockResolvedValue('w-1'),
      shareWithClient: vi.fn(),
      addMilestone: vi.fn(),
      addWorkItem: vi.fn(),
    };
    const audit = { record: vi.fn() };
    const database = {
      read: (_c: TenantContext, fn: (r: TenantQueryRunner) => unknown) => fn(runner),
      transaction: (_c: TenantContext, fn: (r: TenantQueryRunner) => unknown) => fn(runner),
    };
    const service = new QuotesService({
      database: database as never,
      repository: repository as unknown as QuotesRepository,
      audit,
      links: { createInTransaction: vi.fn() },
      projects: projects as never,
      conversion,
      now: () => now,
    });
    return { service, repository, projects, conversion, audit };
  }

  it('plans the project from the quote: its name, one milestone, one work item per line in order', () => {
    const plan = conversionPlan(accepted, lines);
    expect(plan.projectName).toBe('Q-0001 · Website');
    expect(plan.milestoneTitle).toBe(plan.projectName);
    expect(plan.workItemTitles).toEqual(['Discovery', 'Design']);
  });

  it('creates the project, the milestone and the work items and links the quote back', async () => {
    const h = harness(accepted);
    const result = await h.service.convert(
      context,
      owner,
      '0190f1e2-0000-7000-8000-000000000001',
      {},
    );
    expect(result).toMatchObject({ projectId: 'p-1', created: true });
    expect(result.quote.convertedProjectId).toBe('p-1');
    expect(h.projects.createInTransaction).toHaveBeenCalledWith(runner, context, {
      workspaceId: 'w-1',
      name: 'Q-0001 · Website',
    });
    expect(h.conversion.addMilestone).toHaveBeenCalledTimes(1);
    expect(h.conversion.addWorkItem.mock.calls.map((c) => c[3])).toEqual(['Discovery', 'Design']);
    expect(h.repository.markConverted).toHaveBeenCalledWith(runner, context, 'q-1', 'p-1', now);
    expect(h.audit.record.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'quote.converted' });
  });

  it('is idempotent: a converted quote opens its project and creates nothing', async () => {
    const h = harness({ ...accepted, convertedProjectId: 'p-9' });
    const result = await h.service.convert(
      context,
      owner,
      '0190f1e2-0000-7000-8000-000000000001',
      {},
    );
    expect(result).toMatchObject({ projectId: 'p-9', created: false });
    expect(h.projects.createInTransaction).not.toHaveBeenCalled();
  });

  it('refuses a quote that is not accepted', async () => {
    const h = harness({ ...accepted, status: 'sent' });
    await expect(
      h.service.convert(context, owner, '0190f1e2-0000-7000-8000-000000000001', {}),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.projects.createInTransaction).not.toHaveBeenCalled();
  });
});

describe('52-10 quote PDF in the portal', () => {
  const QUOTE_ID = '0193a1b2-7c3d-7e4f-8a5b-6c7d8e9f0a1b';
  const pdfService = (row: Partial<QuoteRow>) =>
    new QuotesService({
      database: {
        read: async (_c: unknown, work: (r: unknown) => unknown) => work(runner),
      } as never,
      repository: {
        find: async () => ({
          ...quote,
          sentAt: now,
          decidedAt: null,
          convertedAt: null,
          createdAt: now,
          updatedAt: now,
          clientOrganizationId: 'acme',
          ...row,
        }),
        lines: async () => [],
        clientName: async () => 'Acme',
      } as unknown as QuotesRepository,
      audit: {} as never,
      links: {} as never,
    });
  const client = (clientOrganizationId: string) =>
    ({
      userId: 'client-user-1',
      organizationId: 'org-1',
      kind: 'client',
      role: 'client_admin',
      membershipId: 'membership-client-1',
      membershipStatus: 'active',
      clientOrganizationId,
      projectIds: [],
      hasOrgWideScope: false,
    }) as unknown as Principal;

  it("gives a client its own sent quote and nobody else's, nor a draft", async () => {
    const file = await pdfService({}).portalPdf(context, client('acme'), QUOTE_ID, 'ar');
    expect(file.fileName).toBe('quote-Q-0001.pdf');
    expect(file.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    for (const [row, who] of [
      [{}, 'globex'],
      [{ clientOrganizationId: null }, 'acme'],
      [{ status: 'draft' }, 'acme'],
    ] as const) {
      await expect(
        pdfService(row as Partial<QuoteRow>).portalPdf(context, client(who), QUOTE_ID, 'en'),
      ).rejects.toMatchObject({ status: 404 });
    }
  });
});
