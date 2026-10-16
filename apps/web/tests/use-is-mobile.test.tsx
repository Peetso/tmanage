import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useIsMobile } from '../src/lib/hooks/useIsMobile';

function Probe({ query }: { query?: string }) {
  return <output>{useIsMobile(query) ? 'mobile' : 'desktop'}</output>;
}

/** jsdom ships no `matchMedia`, so the property is genuinely optional at runtime here. */
const windowWithOptionalMatchMedia = window as unknown as {
  matchMedia?: typeof window.matchMedia;
};
const originalMatchMedia = windowWithOptionalMatchMedia.matchMedia;

afterEach(() => {
  if (originalMatchMedia === undefined) {
    delete windowWithOptionalMatchMedia.matchMedia;
  } else {
    windowWithOptionalMatchMedia.matchMedia = originalMatchMedia;
  }
});

/** A `matchMedia` whose list reports a fixed `matches` and never notifies — enough for the snapshot. */
function stubMatchMedia(matches: boolean) {
  windowWithOptionalMatchMedia.matchMedia = vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

describe('useIsMobile', () => {
  // The SSR guard: the server snapshot is always the desktop default, and a client with no
  // `matchMedia` (a bare jsdom, an old browser) falls back to that same value rather than throwing.
  it('returns false when matchMedia is unavailable (the SSR guard)', () => {
    delete windowWithOptionalMatchMedia.matchMedia;

    expect(renderToString(<Probe />)).toContain('desktop');
    expect(render(<Probe />).container.textContent).toBe('desktop');
  });

  it('returns true at mobile width when the media query matches', () => {
    stubMatchMedia(true);

    expect(render(<Probe />).container.textContent).toBe('mobile');
  });

  it('returns false at desktop width when the media query does not match', () => {
    stubMatchMedia(false);

    expect(render(<Probe />).container.textContent).toBe('desktop');
  });
});
