import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { ContactsImportScreen } from '../src/components/screens/ContactsImportScreen';
import { contactFileFormat } from '../src/lib/api/contact-import';

/** r46 · 54-11 — Import contacts (Figma 587:33749). */

const PREVIEW = {
  format: 'csv',
  header: ['Name', 'E-mail 1 - Value', 'Organization 1 - Name'],
  mapping: { email: 1, name: 0, company: 2 },
  counts: { total: 3, new: 1, existing: 0, duplicate: 1, invalid: 1, overLimit: 0 },
  rows: [
    { line: 2, displayName: 'Sara', email: 'sara@acme.co', company: 'Acme', status: 'new' },
    {
      line: 3,
      displayName: 'Sara H.',
      email: 'sara@acme.co',
      company: 'Acme',
      status: 'duplicate',
    },
    { line: 4, displayName: 'Lina', email: 'lina@', company: null, status: 'invalid_email' },
  ],
  errors: [
    {
      line: 3,
      displayName: 'Sara H.',
      email: 'sara@acme.co',
      company: 'Acme',
      outcome: 'duplicate',
    },
    { line: 4, displayName: 'Lina', email: 'lina@', company: null, outcome: 'invalid_email' },
  ],
  companies: [{ name: 'Acme', isNew: true }],
};

describe('contactFileFormat', () => {
  it('reads .vcf and a BEGIN:VCARD text as vCard, anything else as CSV', () => {
    expect(contactFileFormat('people.VCF', '')).toBe('vcard');
    expect(contactFileFormat('export.txt', 'BEGIN:VCARD\nEND:VCARD')).toBe('vcard');
    expect(contactFileFormat('contacts.csv', 'Name,Email')).toBe('csv');
  });
});

describe('ContactsImportScreen', () => {
  it('uploads, previews with duplicates and errors, then imports with new client companies', async () => {
    const bodies: { path: string; body: Record<string, unknown> }[] = [];
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        bodies.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
        if (path.endsWith('/contacts/import-preview')) return Promise.resolve(reply(PREVIEW));
        return Promise.resolve(
          reply({ imported: 1, updated: 0, skipped: 2, reasons: {}, clientsCreated: 1 }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={query}>
        <ContactsImportScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={client}
        />
      </QueryClientProvider>,
    );

    const csv = 'Name,E-mail 1 - Value,Organization 1 - Name\nSara,sara@acme.co,Acme\n';
    const input = screen.getByLabelText(/Choose a CSV or vCard file/);
    fireEvent.change(input, {
      target: { files: [new File([csv], 'contacts.csv', { type: 'text/csv' })] },
    });

    expect(await screen.findByText('Repeated in file')).toBeTruthy();
    expect(screen.getByText('Invalid e-mail')).toBeTruthy();
    expect(screen.getByTestId('tm-r46-summary').textContent).toContain('1 new');
    expect(bodies[0]).toMatchObject({ body: { format: 'csv', text: csv, mapping: null } });

    fireEvent.click(screen.getByRole('checkbox', { name: /client companies/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Import contacts (1)' }));
    expect(await screen.findByText(/client companies added/)).toBeTruthy();
    await waitFor(() =>
      expect(bodies.at(-1)).toMatchObject({
        path: '/v1/organizations/northstar/contacts/import-file',
        body: { createClients: true, mapping: { email: 1, name: 0, company: 2 } },
      }),
    );
  });
});
