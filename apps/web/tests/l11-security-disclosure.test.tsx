import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DisclosureText,
  SECURITY_DISCLOSURE_EMAIL,
  SecurityPage,
} from '../src/components/website/pages/security/SecurityPage';

/**
 * **Live check 014a9d51, REPORT line 119 — the disclosure card named no mailbox.**
 *
 * `/security` read "Write to security@ — …": no domain and no link. The sentence now carries an
 * `{email}` placeholder that the page fills with a real `mailto:` link to the one live mailbox, so
 * a dedicated security@ address can be swapped in later by changing a single constant.
 */

const EN = 'Found a vulnerability? Write to {email} — we respond within two business days.';
const AR = 'اكتشفت ثغرة؟ راسِلنا على ‏{email} — نردّ خلال يومَي عمل.';

function disclosureLink(): HTMLElement {
  return screen.getByRole('link', { name: SECURITY_DISCLOSURE_EMAIL });
}

describe('Security page responsible-disclosure address', () => {
  it('points at the live support mailbox', () => {
    expect(SECURITY_DISCLOSURE_EMAIL).toBe('support@tmanageapp.com');
  });

  it('renders the address on the page as a mailto link', () => {
    render(<SecurityPage />);
    expect(disclosureLink()).toHaveAttribute('href', 'mailto:support@tmanageapp.com');
  });

  it('puts the link where the English sentence has the placeholder', () => {
    const { container } = render(<DisclosureText text={EN} />);
    expect(disclosureLink()).toHaveAttribute('href', 'mailto:support@tmanageapp.com');
    expect(container.textContent).toBe(
      'Found a vulnerability? Write to support@tmanageapp.com — we respond within two business days.',
    );
  });

  it('keeps the Latin address left-to-right after U+200F in the Arabic sentence', () => {
    const { container } = render(<DisclosureText text={AR} />);
    expect(disclosureLink()).toHaveAttribute('dir', 'ltr');
    expect(container.textContent).toBe(
      'اكتشفت ثغرة؟ راسِلنا على ‏support@tmanageapp.com — نردّ خلال يومَي عمل.',
    );
  });

  it('still offers the link when a catalog sentence has no placeholder', () => {
    render(<DisclosureText text="Found a vulnerability? Write to us." />);
    expect(disclosureLink()).toHaveAttribute('href', 'mailto:support@tmanageapp.com');
  });
});
