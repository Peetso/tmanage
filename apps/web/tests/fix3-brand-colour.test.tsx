import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  TMANAGE_LIME,
  accentStylesheet,
  contrastRatio,
  normalizeHex,
  textOnAccent,
} from '../src/lib/brand-accent';
import { BrandAccentStyle } from '../src/components/brand/BrandAccentStyle';
import type { ApiClient } from '../src/lib/api/client';

/** FIX3 item B (Peter 2026-11-09): the owner's brand colour replaces the lime accent. */
function wrap(children: ReactNode) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
}

function clientAnswering(view: unknown): ApiClient {
  return { request: vi.fn(async () => ({ data: view })) } as unknown as ApiClient;
}

describe('brand accent', () => {
  it('normalizes hex colours', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('1d4ed8')).toBe('#1d4ed8');
    expect(normalizeHex('blue')).toBeNull();
  });

  it('picks readable text: ink on light colours, white on dark ones, at least AA', () => {
    expect(textOnAccent(TMANAGE_LIME)).toBe('#090a09');
    expect(textOnAccent('#0b3d91')).toBe('#ffffff');
    for (const colour of ['#0b3d91', '#ffcc00', '#e11d48', '#10b981', '#7c3aed']) {
      expect(contrastRatio(textOnAccent(colour), colour)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('overrides the lime tokens and their text colour, and nothing for the lime itself', () => {
    const css = accentStylesheet('#0b3d91') ?? '';
    expect(css).toContain('--lime-500:#0b3d91');
    expect(css).toContain('--tm-on-lime:#ffffff');
    expect(accentStylesheet(TMANAGE_LIME)).toBeNull();
  });

  it('draws the override once the company has saved a colour', async () => {
    const api = clientAnswering({
      productName: null,
      logoText: null,
      accentColor: '#0b3d91',
      updatedBy: 'u',
      updatedAt: '2026-11-09T10:00:00Z',
    });
    const { container } = render(wrap(<BrandAccentStyle organizationSlug="acme" client={api} />));
    await waitFor(() =>
      expect(container.querySelector('style[data-tm-brand-accent]')?.textContent).toContain(
        '#0b3d91',
      ),
    );
  });

  it('keeps the lime for a company that never saved a colour', async () => {
    const api = clientAnswering({
      productName: null,
      logoText: null,
      accentColor: '#2563eb',
      updatedBy: null,
      updatedAt: null,
    });
    const { container } = render(wrap(<BrandAccentStyle organizationSlug="acme" client={api} />));
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    expect(container.querySelector('style')).toBeNull();
    expect(screen.queryByText('#2563eb')).toBeNull();
  });
});
