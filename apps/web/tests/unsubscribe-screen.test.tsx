import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UnsubscribeScreen } from '../src/components/screens/UnsubscribeScreen';
import type { ApiClient } from '../src/lib/api/client';

/**
 * PERSONMAIL (ADR-0013) — the page behind every mail's "Unsubscribe" link: one click, the same
 * one-click route, and plain words that sign-in, security and account messages still come.
 */

function client() {
  const calls: { method?: string; path: string }[] = [];
  const api = {
    request: (options: { method?: string; path: string }) => {
      calls.push(options);
      return Promise.resolve({ data: { status: 'unsubscribed' } });
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe('PERSONMAIL — unsubscribe page', () => {
  it('asks first, says what still comes, then posts the token to the one-click route', async () => {
    const { api, calls } = client();
    render(<UnsubscribeScreen token="v1.hash.sig" client={api} />);
    expect(
      screen.getByText(/security alerts and messages about your account are still sent/u),
    ).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
    expect(await screen.findByText('You are unsubscribed')).toBeTruthy();
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/public/email/unsubscribe?t=v1.hash.sig',
    });
    expect(screen.getByText(/still sent/u)).toBeTruthy();
  });
});
