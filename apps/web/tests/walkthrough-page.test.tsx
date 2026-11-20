import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { WalkthroughPage } from '../src/components/website/pages/walkthrough/WalkthroughPage';
import { walkthroughDraftProblem } from '../src/components/website/pages/walkthrough/WalkthroughForm';
import { ARABIC_PAGES } from '../src/app/ar/arabic-pages';
import { ROUTE_TITLES } from '../src/lib/route-titles';
import { FOOTER_COLUMNS } from '../src/components/website/site-nav';
import { expectNoAxeViolations } from './axe';

/**
 * LANE-Q — WEB-38 Book a walkthrough (`/walkthrough`). The API door's rules (parse, honeypot,
 * abuse, storage, the sales@ mail) are proved in `apps/api/src/modules/outreach/walkthrough.test.ts`;
 * this file proves what only the page can: the body it posts (three slots, the visitor's zone, the
 * topics, consent, an empty honeypot), the reference it shows, its own first refusals, that the
 * page is reachable (Arabic twin, page name, footer link) and that axe finds nothing in jsdom.
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
      if (call.url.includes('/public/form-proof')) return Promise.resolve(json({}, 200));
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

/** `YYYY-MM-DDTHH:MM`, `days` from now at `hour`:00 local time. */
function slot(days: number, hour: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:00`;
}

const SLOTS: [string, string, string] = [slot(3, 10), slot(4, 14), slot(5, 11)];

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Full name/), '  Sam Rivera ');
  await user.type(screen.getByLabelText(/Work email/), 'sam@atlas.example');
  await user.type(screen.getByLabelText(/^Company/), 'Atlas Studio');
  await user.selectOptions(screen.getByLabelText(/Team size/), '11-50');
  fireEvent.change(screen.getByLabelText(/First choice/), { target: { value: SLOTS[0] } });
  fireEvent.change(screen.getByLabelText(/Second choice/), { target: { value: SLOTS[1] } });
  fireEvent.change(screen.getByLabelText(/Third choice/), { target: { value: SLOTS[2] } });
  await user.click(screen.getByLabelText(/Why switch from your current tool/));
}

describe('LANE-Q Book a walkthrough page', () => {
  it('renders accessibly, with the visitor time zone shown', async () => {
    const { client } = clientOver(() => json({ reference: 'WT-ABCDEFGH' }, 201));
    const { container } = render(<WalkthroughPage client={client} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'A 20-minute walkthrough, at a time that suits you.',
    );
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(
      screen.getByText(new RegExp(`Times are in your time zone: ${zone}`)),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Request a walkthrough' })).toBeEnabled(),
    );
    await expectNoAxeViolations(container);
  });

  it('posts three slots, the zone, the topics and consent, then shows the reference', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json({ reference: 'WT-ABCDEFGH' }, 201));
    render(<WalkthroughPage client={client} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Request a walkthrough' })).toBeEnabled(),
    );
    await fill(user);
    await user.click(screen.getByLabelText(/TManage may e-mail me/));
    await user.click(screen.getByRole('button', { name: 'Request a walkthrough' }));

    await waitFor(() => expect(screen.getByText(/WT-ABCDEFGH/)).toBeInTheDocument());
    const posts = calls.filter((call) => call.url.includes('/v1/public/walkthrough-requests'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.method).toBe('POST');
    expect(posts[0]!.body).toMatchObject({
      name: 'Sam Rivera',
      email: 'sam@atlas.example',
      company: 'Atlas Studio',
      teamSize: '11-50',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      slots: SLOTS,
      topics: ['tour', 'switch'],
      consent: true,
      language: 'en',
      website: '',
    });
  });

  it('refuses without consent and never posts', async () => {
    const user = userEvent.setup();
    const { client, calls } = clientOver(() => json({ reference: 'WT-ABCDEFGH' }, 201));
    render(<WalkthroughPage client={client} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Request a walkthrough' })).toBeEnabled(),
    );
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Request a walkthrough' }));
    expect(
      await screen.findByText('Tick the box so we can e-mail you about this request.'),
    ).toBeInTheDocument();
    expect(calls.filter((call) => call.url.includes('walkthrough-requests'))).toHaveLength(0);
  });

  it('a 429 reads as a calm try-again-later', async () => {
    const user = userEvent.setup();
    const { client } = clientOver(() =>
      json({ error: { code: 'rate_limited', message: 'Too many requests.' } }, 429),
    );
    render(<WalkthroughPage client={client} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Request a walkthrough' })).toBeEnabled(),
    );
    await fill(user);
    await user.click(screen.getByLabelText(/TManage may e-mail me/));
    await user.click(screen.getByRole('button', { name: 'Request a walkthrough' }));
    expect(
      await screen.findByText('Too many requests from this network. Please try again later.'),
    ).toBeInTheDocument();
  });

  it('the draft check refuses past, repeated or missing times', () => {
    const now = new Date();
    const draft = {
      name: 'Sam',
      email: 'sam@atlas.example',
      company: 'Atlas',
      teamSize: '1-10',
      slots: SLOTS,
      topics: ['tour'] as const,
      consent: true,
    };
    expect(walkthroughDraftProblem(draft, now)).toBeNull();
    expect(
      walkthroughDraftProblem({ ...draft, slots: [slot(-1, 10), SLOTS[1], SLOTS[2]] }, now),
    ).toBe('WalkthroughForm.errorSlots');
    expect(walkthroughDraftProblem({ ...draft, slots: [SLOTS[0], SLOTS[0], SLOTS[2]] }, now)).toBe(
      'WalkthroughForm.errorSlotsDistinct',
    );
    expect(walkthroughDraftProblem({ ...draft, topics: [] }, now)).toBe(
      'WalkthroughForm.errorTopics',
    );
  });

  it('is reachable: Arabic twin, page name and a footer link', () => {
    expect(ARABIC_PAGES['/walkthrough']).toBeDefined();
    expect(ROUTE_TITLES['/walkthrough']).toEqual({
      en: 'Book a walkthrough',
      key: 'WebsiteTitle.walkthrough',
    });
    const links = FOOTER_COLUMNS.flatMap((column) => column.links.map((link) => link.href));
    expect(links).toContain('/walkthrough');
  });
});
