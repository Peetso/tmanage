import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field } from '@tmanage/ui';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InviteClientDialog } from '../src/components/clients/InviteClientDialog';
import { MeetingForm } from '../src/components/meetings/MeetingForm';
import { PeriodLockScreen } from '../src/components/screens/finance/PeriodLockScreen';
import { ApiClient } from '../src/lib/api/client';
import { FormCheckMessage, useFormCheck } from '../src/lib/forms/form-check';

/**
 * QA-FIX-S, the M2 defect class: a form whose markup carries `required`, `type="email"` or
 * `min`/`max` and no `noValidate` lets the browser's own check stop the submit. Its bubble is in
 * the browser's language, not linked to the field, and the app's own message never shows. jsdom
 * runs the same interactive constraint validation on a click of a submit button, so every case
 * below clicks the real button (a direct `submit` event would skip the check and prove nothing).
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/acme/meetings/new',
  useSearchParams: () => new URLSearchParams(),
}));

interface Sent {
  readonly method: string;
  readonly path: string;
}

function apiOver(routes: Readonly<Record<string, unknown>>, sent: Sent[]): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      if (method !== 'GET') sent.push({ method, path });
      const match = Object.entries(routes)
        .filter(([suffix]) => path.endsWith(suffix))
        .sort(([a], [b]) => b.length - a.length)[0]?.[1];
      return Promise.resolve(
        new Response(JSON.stringify(match ?? {}), {
          status: match === undefined ? 404 : 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
}

function mount(ui: ReactElement) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  query.setQueryData(
    ['shell', 'organizations'],
    [{ slug: 'acme', role: 'owner', capabilities: [] }],
  );
  render(<QueryClientProvider client={query}>{ui}</QueryClientProvider>);
}

afterEach(() => cleanup());

function Harness({ onValid }: { onValid: () => void }) {
  const check = useFormCheck({ messages: { link: 'Use an https link from your meeting app.' } });
  return (
    <form noValidate aria-label="Harness" {...check.handlers(onValid)}>
      <Field label="Name" name="name" required error={check.error('name')} />
      <label htmlFor="h-email">Email</label>
      <input id="h-email" name="email" type="email" {...check.control('email')} />
      <FormCheckMessage check={check} name="email" />
      <Field
        label="Seats"
        name="seats"
        type="number"
        min={1}
        max={1000}
        defaultValue="0"
        error={check.error('seats')}
      />
      <Field label="Link" name="link" type="url" required error={check.error('link')} />
      <button type="submit">Save</button>
    </form>
  );
}

describe('M2 shared layer: useFormCheck', () => {
  it('reports every failed constraint in the app’s words, linked to its field, and sends nothing', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);

    await user.type(screen.getByLabelText('Email'), 'omar');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onValid).not.toHaveBeenCalled();
    const name = screen.getByLabelText(/^Name/);
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Fill in this field.');
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(
      'Enter an email address, like name@example.com.',
    );
    expect(screen.getByLabelText('Seats')).toHaveAccessibleDescription(
      'Enter a whole number from 1 to 1000.',
    );
    // A form keeps its own sentence for a field when it has one.
    expect(screen.getByLabelText(/^Link/)).toHaveAccessibleDescription(
      'Use an https link from your meeting app.',
    );
  });

  it('clears a message as soon as its field is fixed, and submits once everything passes', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const name = screen.getByLabelText(/^Name/);
    await user.type(name, 'Omar');
    expect(name).not.toHaveAttribute('aria-invalid');

    const seats = screen.getByLabelText('Seats');
    await user.clear(seats);
    await user.type(seats, '3');
    await user.type(screen.getByLabelText(/^Link/), 'https://meet.example.test/x');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onValid).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Fill in this field/)).toBeNull();
  });
});

describe('M2 forms whose own message the browser check used to block', () => {
  it('Period locks: "Close month" with no month says so beside the field', async () => {
    const user = userEvent.setup();
    const sent: Sent[] = [];
    mount(
      <PeriodLockScreen
        organizationSlug="acme"
        organizationName="Acme"
        client={apiOver({ '/period-locks': { locks: [] } }, sent)}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Close month' }));

    expect(await screen.findByText('Choose a month to close.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('New meeting: an empty save shows "A few things are missing"', async () => {
    const user = userEvent.setup();
    const sent: Sent[] = [];
    // The screen's Save button sits outside the form and names it, as `MeetingFormScreen` does.
    mount(
      <>
        <MeetingForm organizationSlug="acme" client={apiOver({}, sent)} />
        <button type="submit" form="tm-mtg-form">
          Save
        </button>
      </>,
    );

    await user.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByText('A few things are missing')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });
});

describe('M2 forms that had only the browser check', () => {
  it('Invite a client: a malformed address is refused in the app’s words, before any company is created', async () => {
    const user = userEvent.setup();
    const sent: Sent[] = [];
    mount(
      <InviteClientDialog
        api={apiOver({ '/projects': { projects: [] } }, sent)}
        organizationSlug="acme"
        organizations={[]}
        initialCompanyName="Atlas"
        onClose={() => undefined}
        onIssued={() => undefined}
      />,
    );

    const email = screen.getByRole('textbox', { name: /^Email/ });
    await user.type(email, 'omar');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));

    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(email).toHaveFocus();
    expect(email).toHaveAccessibleDescription('Enter an email address, like name@example.com.');
    expect(sent).toHaveLength(0);
  });
});
