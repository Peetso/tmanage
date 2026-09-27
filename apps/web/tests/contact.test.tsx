import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ContactScreen } from '../src/components/screens/ContactScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Contact (x161).**
 *
 * The untrusted-input boundary — every reject path and the "no write on bad input" guarantee — is
 * proved over the controller in `apps/api/src/modules/public-site/contact.controller.test.ts`;
 * nothing here re-proves it. What only this file can prove is what the *screen* does with the two
 * answers the `@Public()` endpoint can give: a valid submission posts the trimmed fields to
 * `POST /public/site/contact` and shows a bare acknowledgement that echoes nothing stored, a 400 is
 * rendered verbatim, and the public page carries accessible landmarks with no axe violation jsdom
 * can detect.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Your name/), '  Ada Lovelace  ');
  await user.type(screen.getByLabelText(/Work email/), '  ada@example.com  ');
  await user.type(screen.getByLabelText(/^Message/), '  We would like a demo.  ');
}

describe('ContactScreen', () => {
  it('renders the public contact page accessibly', async () => {
    const { client } = clientOver(() => json({ status: 'received' }, 201));
    const { container } = render(<ContactScreen client={client} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Contact us');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    await expectNoAxeViolations(container);
  });

  it('posts the trimmed fields and shows an acknowledgement that reflects nothing stored', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json({ status: 'received' }, 201));
    render(<ContactScreen client={client} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(screen.getByText('Thanks — we have your message')).toBeInTheDocument(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/public/site/contact');
    // Trimmed on the way out.
    expect(calls[0]!.body).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'We would like a demo.',
    });
    // The acknowledgement carries no id and no echoed lead value.
    expect(screen.queryByText(/ada@example\.com/)).not.toBeInTheDocument();
  });

  it('does not call the API when a field is empty', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json({ status: 'received' }, 201));
    render(<ContactScreen client={client} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    await user.type(screen.getByLabelText(/Your name/), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Enter your name, email and a message.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('renders the server 400 message verbatim', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(() =>
      json(
        { error: { code: 'validation_failed', message: 'name, email and message are required' } },
        400,
      ),
    );
    render(<ContactScreen client={client} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('name, email and message are required')).toBeInTheDocument();
  });
});
