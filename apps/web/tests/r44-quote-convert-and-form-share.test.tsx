import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { buildContentSecurityPolicy, isEmbeddablePath } from '../src/lib/csp';
import { QuoteConvertCard } from '../src/components/screens/quotes/QuoteConvertCard';
import type { QuoteDocument } from '../src/components/screens/quotes/QuoteApi';
import {
  EMBED_SANDBOX,
  WorkFormShareExtras,
  embedSnippet,
} from '../src/components/screens/WorkFormShareExtras';

function client(calls: string[], body: unknown) {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
}

const accepted = {
  id: 'q-1',
  number: 'Q-0001',
  title: 'Website',
  status: 'accepted',
  convertedProjectId: null,
  lines: [],
} as unknown as QuoteDocument;

function mountCard(quote: QuoteDocument, calls: string[] = []) {
  const api = client(calls, { quote, projectId: 'p-1', created: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <QuoteConvertCard api={api} organizationSlug="northstar" quote={quote} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('52-08 · Convert to project card', () => {
  it('converts an accepted quote and then offers the project', async () => {
    const calls = mountCard(accepted);
    fireEvent.click(screen.getByRole('button', { name: 'Convert to project' }));
    const open = await screen.findByRole('link', { name: 'Open project' });
    expect(open).toHaveAttribute('href', '/northstar/projects/p-1');
    expect(calls).toEqual([
      'POST https://api.example.test/v1/organizations/northstar/quotes/q-1/convert',
    ]);
  });

  it('opens the existing project of a converted quote', () => {
    mountCard({ ...accepted, convertedProjectId: 'p-9' });
    expect(screen.getByRole('link', { name: 'Open project' })).toHaveAttribute(
      'href',
      '/northstar/projects/p-9',
    );
    expect(screen.queryByRole('button', { name: 'Convert to project' })).toBeNull();
  });

  it('is absent while the quote is not accepted', () => {
    mountCard({ ...accepted, status: 'sent' });
    expect(screen.queryByRole('heading', { name: 'Project' })).toBeNull();
  });
});

describe('52-20 · form QR code and embed snippet', () => {
  it('builds a sandboxed iframe and escapes the form name', () => {
    const snippet = embedSnippet('https://app.test/f/abc', 'Brief "A" <b>');
    expect(snippet).toContain(`sandbox="${EMBED_SANDBOX}"`);
    expect(EMBED_SANDBOX).not.toContain('allow-top-navigation');
    expect(EMBED_SANDBOX).not.toContain('allow-popups');
    expect(snippet).toContain('title="Brief &quot;A&quot; &lt;b&gt;"');
  });

  it('draws the QR code as an inline SVG and shows the frame-src allow-list origin', () => {
    render(<WorkFormShareExtras url="https://app.test/f/abc" formName="Brief" />);
    const qr = screen.getByRole('img', { name: 'QR code of the form link' });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByText('https://app.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  it('lets only the public form page be framed', () => {
    expect(isEmbeddablePath('/f/abc')).toBe(true);
    expect(isEmbeddablePath('/connect/x')).toBe(false);
    expect(isEmbeddablePath('/f/abc/admin')).toBe(false);
    const base = { nonce: 'n', development: false } as const;
    expect(buildContentSecurityPolicy({ ...base, embeddable: true })).toContain(
      "frame-ancestors 'self' https:",
    );
    expect(buildContentSecurityPolicy(base)).toContain("frame-ancestors 'none'");
  });
});
