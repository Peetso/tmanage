import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AdminBlockedFilesScreen } from '../src/components/screens/AdminBlockedFilesScreen';
import { AdminSecuritySignalsScreen } from '../src/components/screens/AdminSecuritySignalsScreen';
import { blockReason, filterBlocked } from '../src/lib/api/admin-blocked-files';
import type { BlockedFileView } from '../src/lib/api/admin-blocked-files';
import { signalQuery } from '../src/lib/api/admin-security-signals';
import { barHeights, funnelPercents, growthPath, percent } from '../src/lib/api/platform-growth';
import type { GrowthFigures as Figures } from '../src/lib/api/platform-growth';
import { GrowthFigures } from '../src/components/platform/activity/GrowthFigures';

/** R44 L2: 56-06 Blocked files, 56-23 Security signals (owner), 57-09 Growth helpers. */

const SLUG = 'northstar-studio';
const calls: { method: string; url: string }[] = [];

function fakeClient(answer: (method: string, url: string) => unknown): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const body = answer(method, url);
      return Promise.resolve(
        body === null
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQueries(children: ReactNode) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(
    ['shell', 'organizations'],
    [{ id: 'o1', slug: SLUG, name: 'Northstar Studio', role: 'owner' }],
  );
  return <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
}

const FILE: BlockedFileView = {
  ...{ id: 'f1', name: 'invoice.pdf.exe', extension: 'EXE', detectedMimeType: null },
  ...{ declaredMimeType: 'application/pdf', sizeBytes: 10, reason: 'malware_detected' },
  ...{ uploadedBy: 'Sara Ali', blockedAt: '2026-11-07T09:00:00Z' },
};

describe('56-06 Blocked files', () => {
  it('lists blocked uploads with the reason and deletes one through the API', async () => {
    calls.length = 0;
    const client = fakeClient((method) => (method === 'POST' ? null : { files: [FILE] }));
    render(
      withQueries(
        <AdminBlockedFilesScreen organizationSlug={SLUG} organizationName="N" client={client} />,
      ),
    );
    expect(await screen.findByText('invoice.pdf.exe')).toBeInTheDocument();
    expect(screen.getAllByText('Malware found').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Delete now' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/blocked/f1/delete'))).toBe(
        true,
      ),
    );
  });

  it('maps unknown codes to "other" and filters by reason', () => {
    expect(blockReason('size_exceeded')).toBe('other');
    const files = [FILE, { ...FILE, id: 'f2', reason: 'type_mismatch' }];
    expect(filterBlocked(files, 'type_mismatch').map((f) => f.id)).toEqual(['f2']);
    expect(filterBlocked(files, 'all')).toHaveLength(2);
  });
});

describe('56-23 Security signals (owner)', () => {
  const signal = {
    ...{ id: 's1', organizationId: 'o1', ruleKey: 'mass_export', severity: 'high' },
    label: { en: 'Several exports by one person', ar: 'عمليات تصدير متعددة من شخص واحد' },
    ...{ subjectType: 'user', subjectId: null, hasSource: true, count: 4 },
    ...{ windowStart: '2026-11-07T09:00:00Z', firstSeen: '2026-11-07T09:00:00Z' },
    ...{ lastSeen: '2026-11-07T09:00:00Z', notifyStatus: 'sent', reviewedAt: null },
  };

  it('asks for unreviewed signals and marks one reviewed', async () => {
    calls.length = 0;
    const client = fakeClient((method) =>
      method === 'POST'
        ? { ...signal, reviewedAt: '2026-11-08T10:00:00Z' }
        : { events: [signal], nextCursor: null },
    );
    render(
      withQueries(
        <AdminSecuritySignalsScreen organizationSlug={SLUG} organizationName="N" client={client} />,
      ),
    );
    expect(
      await screen.findByRole('rowheader', { name: 'Several exports by one person' }),
    ).toBeInTheDocument();
    expect(calls[calls.length - 1]?.url).toContain('reviewed=false');
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/events/s1/reviewed'))).toBe(
        true,
      ),
    );
  });

  it('builds the filter query: kind, review state and period', () => {
    const now = new Date('2026-11-08T00:00:00Z');
    const query = new URLSearchParams(
      signalQuery({ review: 'all', kind: 'permission_churn', period: '7d' }, now),
    );
    expect(query.get('kind')).toBe('permission_churn');
    expect(query.has('reviewed')).toBe(false);
    expect(query.get('from')).toBe('2026-11-01T00:00:00.000Z');
    expect(signalQuery({ review: 'open', kind: null, period: 'all' }, now)).not.toContain('from');
  });
});

describe('57-09 Growth', () => {
  it('scales bars, funnel steps and rates for the charts', () => {
    const row = (signups: number) => ({
      ...{ periodStart: '2026-10-01', signups, activationRate7d: null },
      ...{ serviceActivationRate14d: null, timeToFirstProjectP50Hours: null },
      approvalTurnaroundP50Hours: null,
    });
    expect(barHeights([row(50), row(100)])).toEqual([50, 100]);
    expect(barHeights([row(0)])).toEqual([0]);
    const steps = funnelPercents([
      { step: 'org', count: 200 },
      { step: 'project', count: 76 },
    ]);
    expect(steps.map((s) => s.percent)).toEqual([100, 38]);
    expect(percent(0.384)).toBe(38);
    expect(percent(null)).toBeNull();
    expect(growthPath('week')).toBe('/v1/platform/activity/growth?period=week');
  });
});

describe('62-A3 Growth figures (B14)', () => {
  const now = new Date('2026-11-19T10:00:00Z');
  const FILLED: Figures = {
    weeklyActiveCompanies: { weekStart: '2026-11-16', active: 142, companies: 384 },
    firstProjectFinished: { within30d: 0.35, within60d: 0.44 },
    timeToFirstOutcomeP50Hours: 76.8,
    ai: {
      month: '2026-11-01',
      tasksRun: 40,
      tasksCompleted: 31,
      creditsUsed: 2500,
      creditsCap: 100_000,
    },
    costPerActiveCompany: { available: true, month: '2026-11-01', cents: 2700 },
    margin: { available: false, reason: 'beta_free' },
  };
  const EMPTY: Figures = {
    weeklyActiveCompanies: null,
    firstProjectFinished: { within30d: null, within60d: null },
    timeToFirstOutcomeP50Hours: null,
    ai: {
      month: '2026-11-01',
      tasksRun: null,
      tasksCompleted: null,
      creditsUsed: null,
      creditsCap: 100_000,
    },
    costPerActiveCompany: { available: false, reason: 'not_set' },
    margin: { available: false, reason: 'beta_free' },
  };

  it('shows each value with its own period, and the meter value under the bar', () => {
    render(<GrowthFigures figures={FILLED} now={now} />);
    expect(screen.getByText('142')).toBeInTheDocument();
    expect(screen.getByText('this week', { exact: false })).toBeInTheDocument();
    const meters = screen.getAllByRole('meter');
    expect(meters.length).toBe(4);
    for (const meter of meters) expect(meter.textContent).toBe('');
    expect(meters[0]?.getAttribute('aria-valuenow')).toBe('37');
    expect(screen.getByText('35 %')).toBeInTheDocument();
    expect(screen.getByText(/3\.2/u)).toBeInTheDocument();
    expect(screen.getByText('$27.00')).toBeInTheDocument();
    expect(screen.getByText('Not available in the free beta')).toBeInTheDocument();
  });

  it('says no data yet for AI (no meter), not set with a button for unit costs, never 0', () => {
    render(<GrowthFigures figures={EMPTY} now={now} />);
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getAllByText('No data yet').length).toBeGreaterThanOrEqual(6);
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set unit costs' }).getAttribute('href')).toBe(
      '/platform/settings#unit-costs',
    );
  });
});
