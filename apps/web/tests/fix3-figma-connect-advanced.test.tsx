import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FigmaConnectCard } from '../src/components/screens/FigmaConnectCard';
import { BrandLogo } from '../src/components/brand/BrandLogo';
import { ApiClient } from '../src/lib/api/client';

/**
 * FIX3 item 9 (live check a6f66e47, I1/I2). Peter's rule: one-click Connect, no technical fields.
 * Figma has no sign-in on this server yet, so its card shows a Connect button and keeps the
 * personal-access-token field inside a closed "Advanced" section until Connect opens it. The
 * Microsoft and Slack apps draw their official art, not lettered tiles.
 */
function mountFigma() {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'not_connected', handle: null, tokenHint: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <FigmaConnectCard api={client} organizationSlug="northstar-studio" />
    </QueryClientProvider>,
  );
}

describe('FIX3 item 9: Figma connects from one Connect button', () => {
  it('keeps the token field closed under Advanced until Connect is pressed', async () => {
    mountFigma();
    const connect = await screen.findByRole('button', { name: 'Connect' });
    const advanced = document.querySelector('details.tm-figma-connect__advanced');
    expect(advanced).not.toBeNull();
    expect((advanced as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(connect);
    expect((advanced as HTMLDetailsElement).open).toBe(true);
  });
});

describe('FIX3 item 9: official marks for Microsoft apps and Slack', () => {
  it('draws the vendored art file, never a lettered tile', () => {
    for (const brand of ['onedrive', 'outlook', 'teams', 'slack'] as const) {
      const { container, unmount } = render(<BrandLogo brand={brand} />);
      const image = container.querySelector('img');
      expect(image?.getAttribute('src')).toBe(`/brand/apps/${brand}.svg`);
      expect(container.querySelector('[data-letters]')).toBeNull();
      unmount();
    }
  });
});
