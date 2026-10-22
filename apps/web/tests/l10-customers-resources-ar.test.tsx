import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomersPage } from '../src/components/website/pages/customers/CustomersPage';
import { ResourcesPage } from '../src/components/website/pages/resources/ResourcesPage';
import { activeLocale } from '../src/lib/i18n/locale-store';
import en from '../src/lib/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const ARABIC = /[؀-ۿ]/;
/** The L10 fragment is merged into en.json by the integrator; before that `t()` returns the key. */
const L10_MERGED = 'CustomersPage.portalTitle' in en;

/**
 * The English copy live check 014a9d51 (REPORT lines 70-73) found on the Arabic /customers page,
 * all of which now comes from the catalog.
 */
const REPORTED_ENGLISH = [
  'Homepage Concept',
  'Approved',
  'approved by Youssef',
  'Download v2',
  'Arabic FAQ page',
  'In progress',
  'Asked in chat',
  'Design partner 01',
  'Design studio',
  'In-house team',
  'Clients check progress in the portal',
  'Feedback lands on the exact version',
  'Delivered by',
  'Your project',
  'Website relaunch',
  'Everything is moving toward',
  'Your actions',
  'Approve the homepage direction',
  'Your turn',
  'Agencies & studios',
  'A studio that stopped chasing approvals',
  'Shape the roadmap',
];

/** Text that legitimately stays Latin inside Arabic copy: names, brand and the version tag. */
/** Avatar initials (decorative) are bare capitals, e.g. "MH". */
const LATIN_ALLOWED =
  /^(Maya Hassan|Omar Adel|Atlas Hospitality|Northstar Studio|TManage|v2|[A-Z]{1,3})$/;
const LATIN = /[A-Za-z]/;

afterEach(() => {
  cleanup();
  act(() => activeLocale.set('en-US'));
});

/** The page's own text, without the shared CTA band (its product mock is another slice's). */
function pageTextNodes(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('.tm-web-cta-section')) continue;
    const text = node.textContent?.trim();
    if (text) out.push(text);
  }
  return out;
}

describe('L10 · /customers in Arabic', () => {
  it('shows none of the English copy the live check reported', () => {
    act(() => activeLocale.set('ar-EG'));
    const { container } = render(<CustomersPage />);
    // Before the fragment is merged `t()` returns the bare key; that is not English copy.
    const text = pageTextNodes(container)
      .join(' ')
      .replace(/CustomersPage\.\w+/g, '');
    for (const english of REPORTED_ENGLISH) expect(text).not.toContain(english);
  });

  it.skipIf(!L10_MERGED)('renders every customers-page string in Arabic', () => {
    act(() => activeLocale.set('ar-EG'));
    const { container } = render(<CustomersPage />);
    const english = pageTextNodes(container).filter(
      (text) => LATIN.test(text) && !ARABIC.test(text) && !LATIN_ALLOWED.test(text),
    );
    expect(english).toEqual([]);
  });
});

describe('L10 · /resources in English', () => {
  it('names the Arabic-first card link in English', () => {
    act(() => activeLocale.set('en-US'));
    render(<ResourcesPage />);
    const link = screen.getByRole('link', { name: 'Arabic-first product language, explained' });
    expect(link).toHaveClass('tm-web-res-stretch');
    expect(link.textContent).not.toMatch(ARABIC);
    for (const stretch of document.querySelectorAll('a.tm-web-res-stretch')) {
      expect(stretch.textContent).not.toMatch(ARABIC);
    }
  });
});
