import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LocationHonestyNote } from '../src/components/security/LocationHonestyNote';
import { SignalPill } from '../src/components/security/SignalPill';
import { TrailPrintView, formatUtc } from '../src/components/security/TrailPrintView';
import { parseTrailCsv } from '../src/lib/api/session-intel';

/** R12 slice 3 — the verdict pill, the four honest limits and the UTC print view. */
describe('session intel (R12)', () => {
  it('labels a verdict with its score and reasons, and dashes a missing signal', () => {
    const { rerender } = render(
      <SignalPill
        automation={{ verdict: 'likely_automated', score: 85, reasons: ['ua_headless', 'x'] }}
        withScore
        withReasons
      />,
    );
    expect(screen.getByText('Likely automated · 85')).toBeTruthy();
    expect(screen.getByText('Headless browser in the user agent')).toBeTruthy();
    expect(screen.getByText('Another signal')).toBeTruthy();
    rerender(<SignalPill automation={null} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('shows all four location limits', () => {
    render(<LocationHonestyNote />);
    for (const text of [/approximate/, /VPN or proxy/, /MAC address/, /through the police/])
      expect(screen.getByText(text)).toBeTruthy();
  });

  it('parses the trail CSV and prints UTC times', async () => {
    const csv =
      String.fromCharCode(0xfeff) +
      'occurredAtUtc,action,outcome,ip,city,country,reasons\r\n' +
      '2026-11-01T03:02:09.000Z,sign_in,failed,95.216.14.201,"Frankfurt, am Main",Germany,ua_tool;tor_ip\r\n';
    expect(parseTrailCsv(csv)[0]?.['city']).toBe('Frankfurt, am Main');
    expect(formatUtc('2026-11-01T03:02:09.000Z')).toBe('2026-11-01 03:02 UTC');
    const fetchImpl = (async () => new Response(csv)) as typeof globalThis.fetch;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TrailPrintView
          subject="Nadia"
          meta="m"
          csvUrl="/t.csv"
          autoPrint={false}
          fetchImpl={fetchImpl}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('2026-11-01 03:02 UTC')).toBeTruthy();
    expect(screen.getByText(/Script or tool in the user agent; Tor exit node/)).toBeTruthy();
  });
});
