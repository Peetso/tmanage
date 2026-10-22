import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AboutPage } from '../src/components/website/pages/about/AboutPage';
import { ContactPage } from '../src/components/website/pages/contact/ContactPage';

/**
 * **WEB-16 About and WEB-17 Book a demo, round-2 Figma (2026-10-22).**
 *
 * Structure only — the copy lives in the catalog. About draws four numbered principles, eight
 * placeholder team avatars and the careers / press link cards; Book a demo draws three "Other
 * ways" cards that are whole-card links, an open FAQ, and a form that needs no heading of its own.
 */

describe('About page', () => {
  it('numbers the four principle cards 01–04', () => {
    const { container } = render(<AboutPage />);
    const numbers = [...container.querySelectorAll('.tm-web-about__principle-n')].map(
      (node) => node.textContent,
    );
    expect(numbers).toEqual(['01', '02', '03', '04']);
  });

  it('shows eight decorative team placeholders and no invented names', () => {
    const { container } = render(<AboutPage />);
    const row = container.querySelector('.tm-web-about__team-row')!;
    expect(row.querySelectorAll('li')).toHaveLength(8);
    expect(row.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(8);
  });

  it('links Work with us and Press & brand to the contact topics', () => {
    const { container } = render(<AboutPage />);
    const hrefs = [...container.querySelectorAll('.tm-web-about__cards a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toEqual(['/contact?topic=careers', '/contact?topic=press']);
  });
});

describe('Book a demo page', () => {
  it('makes each Other ways card one link to sales, the Help center and Security', () => {
    const { container } = render(<ContactPage />);
    const hrefs = [...container.querySelectorAll('a.tm-web-contact-way')].map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toEqual(['mailto:sales@tmanage.app', '/faq', '/security']);
  });

  it('shows every FAQ answer open, as drawn', () => {
    const { container } = render(<ContactPage />);
    const rows = [...container.querySelectorAll('.tm-web-contact-faq details')];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toHaveAttribute('open');
  });

  it('puts Company and Team size on one row of the form', () => {
    const { container } = render(<ContactPage />);
    const pair = container.querySelector('.tm-web-contact-form__pair') as HTMLElement;
    expect(within(pair).getByLabelText(/Company/)).toBeInTheDocument();
    expect(within(pair).getByLabelText(/Team size/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book my demo' })).toBeInTheDocument();
  });
});
