import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { LEGAL_DOCUMENTS } from '@tmanage/domain';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketingLegalScreen } from '../src/components/screens/MarketingLegalScreen';
import {
  LEGAL_DOCUMENTS_AR,
  LEGAL_ENGLISH_PREVAILS_AR,
} from '../src/components/screens/legal-content-ar';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * **M2 — the legal bodies in Arabic.** In Arabic the Terms and the Privacy Policy render from the
 * Arabic source with a note that the English prevails; the Limited Use sentence keeps the policy's
 * English name; in English (and on the server) the text is the domain document, unchanged.
 */
function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('Arabic legal copy', () => {
  it('translates every section of both documents', () => {
    for (const key of ['terms', 'privacy'] as const) {
      const ids = LEGAL_DOCUMENTS[key].sections.map((section) => section.id);
      expect(Object.keys(LEGAL_DOCUMENTS_AR[key].sections).sort()).toEqual([...ids].sort());
    }
  });

  it('keeps the Limited Use sentence and the policy address in both documents', () => {
    for (const key of ['terms', 'privacy'] as const) {
      const google = Object.values(LEGAL_DOCUMENTS_AR[key].sections)
        .map((section) => section.body)
        .join(' ');
      expect(google).toContain('Google API Services User Data Policy');
      expect(google).toContain('Limited Use');
      expect(google).toContain('https://developers.google.com/terms/api-services-user-data-policy');
    }
  });
});

describe('MarketingLegalScreen in Arabic', () => {
  it('renders the Arabic privacy policy with the prevailing-English note and live links', () => {
    act(() => activeLocale.set('ar-EG'));
    render(withQuery(<MarketingLegalScreen doc="privacy" document={LEGAL_DOCUMENTS.privacy} />));

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('سياسة الخصوصية');
    expect(screen.getByText(LEGAL_ENGLISH_PREVAILS_AR)).toBeDefined();
    expect(screen.getByRole('link', { name: 'بيانات مستخدمي Google' }).getAttribute('href')).toBe(
      '#google-user-data',
    );
    const policy = 'https://developers.google.com/terms/api-services-user-data-policy';
    expect(screen.getByRole('link', { name: policy }).getAttribute('href')).toBe(policy);
    expect(
      screen.getAllByRole('link', { name: 'tm-support@peetrix.com' })[0]?.getAttribute('href'),
    ).toBe('mailto:tm-support@peetrix.com');
  });

  it('renders the Arabic terms', () => {
    act(() => activeLocale.set('ar-EG'));
    render(withQuery(<MarketingLegalScreen doc="terms" document={LEGAL_DOCUMENTS.terms} />));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('شروط الخدمة');
    expect(screen.getByRole('heading', { level: 2, name: 'الاستخدام المقبول' })).toBeDefined();
  });

  it('shows the English document unchanged in English, without the note', () => {
    render(withQuery(<MarketingLegalScreen doc="privacy" document={LEGAL_DOCUMENTS.privacy} />));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Privacy Policy');
    expect(screen.queryByText(LEGAL_ENGLISH_PREVAILS_AR)).toBeNull();
    const google = LEGAL_DOCUMENTS.privacy.sections.find((s) => s.id === 'google-user-data');
    expect(document.getElementById('google-user-data')?.textContent).toBe(
      `Google user data${google?.body ?? ''}`,
    );
  });
});
