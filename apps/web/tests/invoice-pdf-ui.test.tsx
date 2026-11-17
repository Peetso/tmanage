import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import {
  DocumentPdfButton,
  DocumentPdfFailure,
  useDocumentPdf,
} from '../src/components/screens/finance/DocumentPdf';
import { InvoiceSendCard } from '../src/components/screens/finance/InvoiceActions';
import {
  invoicePdfPath,
  type ClientInvoiceDocument,
} from '../src/components/screens/finance/InvoiceApi';

function Pdf({ fetchImpl }: { fetchImpl: typeof globalThis.fetch }) {
  const pdf = useDocumentPdf(fetchImpl);
  return (
    <>
      <DocumentPdfButton pdf={pdf} path={invoicePdfPath('northstar', 'i-1')} fileName="INV-1.pdf" />
      <DocumentPdfFailure pdf={pdf} />
    </>
  );
}

describe('INVPDFUI · Download PDF', () => {
  it('fetches the PDF with the session, shows Preparing PDF… while busy', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    let finish: (response: Response) => void = () => undefined;
    const fetchImpl = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Promise<Response>((resolve) => (finish = resolve));
    }) as typeof globalThis.fetch;
    render(<Pdf fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    const busy = screen.getByRole('button', { name: 'Preparing PDF…' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(calls[0]?.url).toMatch(/\/v1\/organizations\/northstar\/client-invoices\/i-1\/pdf$/u);
    expect(calls[0]?.init?.credentials).toBe('include');
    finish(new Response('%PDF', { status: 200 }));
    expect(await screen.findByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
    expect(screen.queryByText(/could not prepare/u)).toBeNull();
  });

  it('shows the warning when the PDF cannot be prepared', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('', { status: 500 }))) as typeof globalThis.fetch;
    render(<Pdf fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(
      await screen.findByText('We could not prepare the PDF. Nothing is lost — try again.'),
    ).toBeInTheDocument();
  });
});

describe('INVPDFUI · Attach the invoice as a PDF', () => {
  function mount(bodies: unknown[]) {
    const api = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          new Response(JSON.stringify(invoice), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });
    const invoice = {
      id: 'i-1',
      state: 'draft',
      lines: [{ id: 'l-1' }],
    } as unknown as ClientInvoiceDocument;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InvoiceSendCard
          api={api}
          organizationSlug="northstar"
          invoice={invoice}
          apiOrigin="https://api.example.test"
        />
      </QueryClientProvider>,
    );
  }

  it('is on by default and its value goes with the send', async () => {
    const bodies: unknown[] = [];
    mount(bodies);
    const toggle = screen.getByRole('switch', { name: 'Attach the invoice as a PDF' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(
      'The e-mail carries the PDF and a link to the invoice.',
    );
    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'ap@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invoice' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ to: ['ap@acme.test'], attachPdf: true });

    fireEvent.click(toggle);
    expect(toggle).toHaveAccessibleDescription('The e-mail carries a link to the invoice only.');
    fireEvent.click(screen.getByRole('button', { name: 'Send invoice' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ attachPdf: false });
  });
});
