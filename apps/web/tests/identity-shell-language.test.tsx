import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IdentityShell } from '../src/components/shell/IdentityShell';

/**
 * Live 2026-11-16: the sign-in language switch was pinned to the page corner, outside the card —
 * ink text on the dark ground, over the wordmark on a phone. It is the card's last row now.
 */
describe('IdentityShell language row', () => {
  it('draws the language switch inside the card, after the legal links', () => {
    render(
      <IdentityShell
        eyebrow="Sign in"
        footer={<a href="/legal/privacy">Privacy</a>}
        language={<div role="group" aria-label="Language" />}
      >
        <h1>Sign in</h1>
      </IdentityShell>,
    );
    const language = screen.getByRole('group', { name: 'Language' });
    const card = language.closest('.tm-identity__card');
    expect(card).not.toBeNull();
    const footer = card?.querySelector('.tm-identity__footer');
    expect(footer?.nextElementSibling).toBe(language.parentElement);
    expect(language.parentElement?.className).toBe('tm-identity__lang');
  });

  it('draws no language row when none is passed', () => {
    const { container } = render(
      <IdentityShell eyebrow="Sign in">
        <h1>Sign in</h1>
      </IdentityShell>,
    );
    expect(container.querySelector('.tm-identity__lang')).toBeNull();
  });
});
