import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from '../src/components/index.js';
import { AA_NORMAL_TEXT, contrastRatio } from '../src/a11y/contrast.js';

/**
 * ADM-19 — two people whose names both reduce to the same two letters were drawn as the same ink
 * disc, so a stack of people read as one repeated avatar. The orb now carries a tint keyed on the
 * whole name, so same-initial people differ by colour; the tint is decorative (initials and the
 * accessible name still carry identity) and never paints a client or image avatar.
 */
describe('Avatar initials and tint (ADM-19)', () => {
  function tintClassOf(container: HTMLElement): string | undefined {
    const orb = container.querySelector('.tm-avatar');
    return [...(orb?.classList ?? [])].find((c) => c.startsWith('tm-avatar--tint-'));
  }

  it('gives same-initial people a different tint, so two "MM" orbs are distinct', () => {
    const a = render(<Avatar name="Mona Mostafa" />);
    const b = render(<Avatar name="Mariam Mahmoud" />);
    const tintA = tintClassOf(a.container);
    const tintB = tintClassOf(b.container);

    expect(tintA).toBeDefined();
    expect(tintB).toBeDefined();
    expect(tintA).not.toBe(tintB);
  });

  it('keeps one person on one colour across renders (the tint is stable)', () => {
    const first = render(<Avatar name="Omar Adel" />);
    const second = render(<Avatar name="Omar Adel" />);
    expect(tintClassOf(first.container)).toBe(tintClassOf(second.container));
  });

  it('does not tint a client avatar (its violet ring is the semantic colour) or an image avatar', () => {
    const client = render(<Avatar name="Dana Client" audience="client" />);
    const image = render(<Avatar name="Dana Client" src="/avatar.png" />);
    expect(tintClassOf(client.container)).toBeUndefined();
    expect(tintClassOf(image.container)).toBeUndefined();
  });

  it('reads a single-word name as its first two letters, not a lone initial', () => {
    const { container } = render(<Avatar name="Mostafa" />);
    expect(container.querySelector('.tm-avatar')?.textContent).toBe('MO');
  });

  /**
   * Each tint is a single dark fill carrying the orb's light text (`--paper-50` in light,
   * `--ink-950` in dark, both near white), so every one must clear AA for the lighter of the two.
   */
  it('every tint clears AA against the orb light text', () => {
    const LIGHT_TEXT = '#F7F7F3';
    const tints = ['#2f4b6b', '#1f5a52', '#3b5a2a', '#6b4a1e', '#6b3030', '#6b2f52'];
    for (const bg of tints) {
      expect(contrastRatio(LIGHT_TEXT, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});
