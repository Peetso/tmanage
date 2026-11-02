import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeSync } from '../src/components/shell/ThemeSync';
import { activeLocale } from '../src/lib/i18n/locale-store';

vi.mock('../src/lib/api/display-preferences', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDisplayPreferences: () =>
    Promise.resolve({ theme: 'light', density: 'comfortable', locale: 'en-US' }),
}));

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('ThemeSync locale (R25 A6)', () => {
  it('replaces a locale left by the cookie or an /ar visit with the saved preference', async () => {
    act(() => activeLocale.set('ar-EG'));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeSync organizationSlug="northstar" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(activeLocale.get()).toBe('en-US'));
    expect(document.cookie).toContain('tmanage_locale=en-US');
  });
});
