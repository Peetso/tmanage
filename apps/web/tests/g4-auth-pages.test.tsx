import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineAlert } from '@tmanage/ui';
import { RecoveryScreen } from '../src/components/screens/RecoveryScreen';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import { ApiClient } from '../src/lib/api/client';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * G4, from the wave 6 live Arabic recheck of the auth pages: no signed-out organizations call,
 * no bare "◉"/"i" glyphs in the sign-in text, a distinct Arabic recovery eyebrow, and no
 * language switch on the auth cards (the ID-01/ID-05 design has none).
 */

function recordingClient() {
  const urls: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
    recovery: { onSessionEnded: vi.fn() },
  });
  return { client, urls };
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('G4 auth pages', () => {
  it('makes no GET /v1/organizations for a signed-out visitor (no session cookie)', async () => {
    const { client, urls } = recordingClient();
    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls.some((url) => url.endsWith('/v1/organizations'))).toBe(false);
  });

  it('puts no bare "◉" or "i" glyph in the sign-in page text', () => {
    const { client } = recordingClient();
    const { container } = render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('◉');
    // 57-05: the passkey button (and its orb) is no longer rendered until passkeys ship.
    expect(container.querySelector('.tm-id-orb')).toBeNull();
    render(<InlineAlert tone="neutral">Note</InlineAlert>);
    const glyph = document.querySelector('.tm-inline-alert__glyph[data-glyph="i"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.textContent).toBe('');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
  });

  it('gives the Arabic recovery page an eyebrow that differs from its heading', () => {
    act(() => activeLocale.set('ar-EG'));
    const { client } = recordingClient();
    const { container } = render(<RecoveryScreen client={client} />);
    const eyebrow = container.querySelector('.tm-identity__eyebrow')?.textContent;
    const heading = screen.getByRole('heading', { level: 1 }).textContent;
    expect(eyebrow).toBe('الاستعادة');
    expect(heading).toBe('استعادة الوصول');
  });

  it('shows no language switch on the sign-in and recovery cards, as designed', () => {
    const { client } = recordingClient();
    render(<SignInScreen client={client} developmentSignInEnabled={false} />);
    render(<RecoveryScreen client={client} />);
    expect(document.querySelector('.tm-web-lang')).toBeNull();
  });
});
