import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARABIC_NOT_FOUND_COPY, ArabicNotFound } from '../src/components/website/ArabicNotFound';
import { ClientPortalShell } from '../src/components/shell/ClientPortalShell';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { RouteLocaleProvider } from '../src/lib/i18n/route-locale';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/ar/no-such-page',
}));

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

const LATIN_WORD = /[A-Za-z]{2,}/;
const SITE = join(__dirname, '..', 'src', 'app', 'ar', '(site)');

/**
 * Arabic polish (2026-10-28): an unknown `/ar/...` URL answers with the Arabic 404 (Figma
 * `429:22543`) instead of the English one, and the client portal's header no longer carries
 * English words ("Delivered by", "Client portal", "Client preview") on an Arabic screen.
 */
describe('Arabic not-found page', () => {
  it('reads in Arabic and links back to the Arabic home and resources', () => {
    render(
      <RouteLocaleProvider locale="ar-EG">
        <ArabicNotFound />
      </RouteLocaleProvider>,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(ARABIC_NOT_FOUND_COPY.heading);
    expect(screen.getByRole('link', { name: ARABIC_NOT_FOUND_COPY.home })).toHaveAttribute(
      'href',
      '/ar',
    );
    expect(screen.getByRole('link', { name: ARABIC_NOT_FOUND_COPY.resources })).toHaveAttribute(
      'href',
      '/ar/resources',
    );
    for (const text of Object.values(ARABIC_NOT_FOUND_COPY)) {
      expect(text).not.toMatch(LATIN_WORD);
    }
  });

  it('is reached by notFound() rather than pre-empted by dynamicParams = false', () => {
    // `dynamicParams = false` answers an unknown param with the ROOT (English) not-found page
    // before the segment's own boundary runs; the Arabic routes must let `notFound()` reach it.
    for (const page of ['[[...path]]/page.tsx', 'resources/[slug]/page.tsx']) {
      const source = readFileSync(join(SITE, page), 'utf8');
      expect(source).not.toMatch(/export const dynamicParams\s*=\s*false/);
      expect(source).toMatch(/notFound\(\)/);
    }
    const boundary = readFileSync(join(SITE, 'not-found.tsx'), 'utf8');
    expect(boundary).toMatch(/ArabicNotFound/);
  });
});

describe('ClientPortalShell in Arabic', () => {
  function renderPortal(preview = false) {
    return render(
      <RouteLocaleProvider locale="ar-EG">
        <ClientPortalShell
          organizationSlug="northstar"
          clientName="Meridian Health"
          providerName="Harbor & Pine Studio"
          title="المراحل"
          preview={preview}
        >
          <p>محتوى</p>
        </ClientPortalShell>
      </RouteLocaleProvider>,
    );
  }

  it('names the delivery team in Arabic', () => {
    renderPortal();
    expect(screen.getByText('يقدّمها Harbor & Pine Studio')).toBeInTheDocument();
    expect(screen.queryByText(/Delivered by/)).toBeNull();
    expect(screen.getByText('بوابة العملاء')).toBeInTheDocument();
    expect(screen.queryByText('Client portal')).toBeNull();
  });

  it('localizes the preview bar', () => {
    renderPortal(true);
    expect(screen.getByText('معاينة العميل')).toBeInTheDocument();
    expect(screen.getByText('هذا ما يراه Meridian Health. لا شيء هنا داخلي.')).toBeInTheDocument();
  });

  it('drops the "delivered by" line while the organization name is unknown', () => {
    const { container } = render(
      <ClientPortalShell
        organizationSlug="northstar"
        clientName="Meridian Health"
        providerName="Northstar Studio"
        title="Milestones"
      >
        <p>Canvas</p>
      </ClientPortalShell>,
    );
    expect(container.querySelector('.tm-portal__provider')).toBeNull();
  });
});
