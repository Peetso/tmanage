import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { escapeCsvCell, toCsv } from './csv.js';
import {
  InsightsExportController,
  workloadCsv,
  type CsvHeaderWriter,
} from './insights-export.controller.js';
import type { InsightsService, InsightsWorkloadView } from './insights.service.js';

/**
 * INS-05 export — the read-only CSV download of the org-wide workload roll-up (x123). Database-free
 * proofs: the roll-up's tenant scope, per-project relation check and aggregation are already proven
 * in `insights-workload.test.ts` with the real `authorize`, so this file proves only the two things
 * the export itself owns — the CSV writer's escaping/injection guard, and that the controller reads
 * through the same tenant-scoped service and returns it as a `text/csv` download. The `work.read`
 * ceiling (the 403) is the global `CapabilityGuard`'s, gated by `@RequireCapability` and proven by
 * the e2e chain.
 */

const VIEW: InsightsWorkloadView = {
  projects: [
    { projectId: 'project-a', openItemCount: 6, scheduledItemCount: 4, assigneeCount: 3 },
    { projectId: 'project-b', openItemCount: 2, scheduledItemCount: 1, assigneeCount: 1 },
  ],
  totals: { projectCount: 2, assigneeCount: 3, openItemCount: 8, scheduledItemCount: 5 },
  computedAt: '2026-09-20T10:00:00.000Z',
};

const context = { organizationId: 'org-1' } as unknown as TenantContext;
const principal = { userId: 'u1', kind: 'internal' } as unknown as Principal;

function collect(reply: { headers: Map<string, string> }): CsvHeaderWriter {
  return {
    header: (name: string, value: string) => reply.headers.set(name, value),
  };
}

describe('CSV writer', () => {
  it('quotes RFC-4180 special characters and doubles interior quotes', () => {
    expect(escapeCsvCell('plain')).toBe('plain');
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCsvCell('line\r\nbreak')).toBe('"line\r\nbreak"');
    expect(toCsv([['x', 'y']])).toBe('x,y\r\n');
  });

  it('neutralises a formula prefix (CSV injection), including when the cell also needs quoting', () => {
    // A leading = + - @ (or the tab/CR that lead into one) is prefixed with a single quote.
    expect(escapeCsvCell('=1+2')).toBe("'=1+2");
    expect(escapeCsvCell('+cmd')).toBe("'+cmd");
    expect(escapeCsvCell('-2')).toBe("'-2");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    // Both guards apply: neutralised AND quoted because of the comma.
    expect(escapeCsvCell('=1,2')).toBe('"\'=1,2"');
  });
});

describe('workloadCsv', () => {
  it('projects the roll-up to a header, a row per project, and a totals row', () => {
    expect(workloadCsv(VIEW)).toBe(
      'Project,Open items,Scheduled,People\r\n' +
        'project-a,6,4,3\r\n' +
        'project-b,2,1,1\r\n' +
        'All projects (2),8,5,3\r\n',
    );
  });
});

describe('InsightsExportController.exportWorkload', () => {
  it('reads through the tenant-scoped workload service and returns it as a text/csv download', async () => {
    const orgWorkload = vi.fn(async () => VIEW);
    const service = { orgWorkload } as unknown as InsightsService;
    const reply = { headers: new Map<string, string>() };

    const file = await new InsightsExportController(service).exportWorkload(
      context,
      principal,
      collect(reply),
    );

    // The export goes through the same tenant-scoped read the JSON endpoint uses — no second query.
    expect(orgWorkload).toHaveBeenCalledWith(context, principal);

    expect(reply.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(reply.headers.get('content-disposition')).toBe('attachment; filename="workload.csv"');
    expect(reply.headers.get('x-content-type-options')).toBe('nosniff');
    expect(reply.headers.get('cache-control')).toBe('private, no-store');

    const body = await streamToString(file.getStream());
    expect(body).toBe(workloadCsv(VIEW));
  });
});

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
