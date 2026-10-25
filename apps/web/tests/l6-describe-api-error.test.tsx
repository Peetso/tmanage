import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangelogScreen } from '../src/components/screens/ChangelogScreen';
import { ApiClient } from '../src/lib/api/client';
import {
  API_ERROR_GENERIC_EN,
  API_ERROR_NETWORK_DOWN_EN,
  describeApiError,
} from '../src/lib/api/describe-error';
import { ApiRequestError, NetworkError } from '../src/lib/api/errors';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * **L6 — no English developer text on Arabic error states.** Ninety-seven screens carried a local
 * `describe()` that returned two hard-coded English lines. They now share `describeApiError`, whose
 * lines come from the catalog (`ApiError.networkDown`, `ApiError.generic`).
 *
 * The keys reach `ar.json` through the `wave7/i18n-L6` fragment. The Arabic catalog is extended here
 * with the fragment's two lines so the Arabic render is proven before the merge; after it the mock
 * adds nothing new.
 */
const AR_NETWORK_DOWN = 'لم تستجب الواجهة البرمجية. هل هي قيد التشغيل؟';
const AR_GENERIC = 'حدث خطأ ما. حاول مرة أخرى.';

vi.mock('../src/lib/i18n/messages/ar.json', async (importOriginal) => {
  const original = (await importOriginal()) as { default: Record<string, string> };
  return {
    default: {
      ...original.default,
      'ApiError.networkDown': 'لم تستجب الواجهة البرمجية. هل هي قيد التشغيل؟',
      'ApiError.generic': 'حدث خطأ ما. حاول مرة أخرى.',
    },
  };
});

const englishOnly = (_key: string, english: string) => english;

describe('describeApiError', () => {
  it("keeps the server's message for a refusal the API answered with", () => {
    const refusal = new ApiRequestError(409, 'conflict', 'That name is taken.', 'c-1');
    expect(describeApiError(refusal, englishOnly)).toBe('That name is taken.');
  });

  it('uses the network-down key when the request got no answer', () => {
    const t = vi.fn((_key: string, english: string) => english);
    expect(describeApiError(new NetworkError('offline'), t)).toBe(API_ERROR_NETWORK_DOWN_EN);
    expect(t).toHaveBeenCalledWith('ApiError.networkDown', API_ERROR_NETWORK_DOWN_EN);
  });

  it('uses the generic key for anything else', () => {
    const t = vi.fn((_key: string, english: string) => english);
    expect(describeApiError(new Error('boom'), t)).toBe(API_ERROR_GENERIC_EN);
    expect(describeApiError('not an error', t)).toBe(API_ERROR_GENERIC_EN);
    expect(t).toHaveBeenCalledWith('ApiError.generic', API_ERROR_GENERIC_EN);
  });

  it('returns the translated line when the catalog has one', () => {
    const arabic = (key: string, english: string) =>
      key === 'ApiError.networkDown'
        ? AR_NETWORK_DOWN
        : key === 'ApiError.generic'
          ? AR_GENERIC
          : english;
    expect(describeApiError(new NetworkError('offline'), arabic)).toBe(AR_NETWORK_DOWN);
    expect(describeApiError(new Error('boom'), arabic)).toBe(AR_GENERIC);
  });
});

/** A client whose every request fails before an answer arrives, as when the API is down. */
function unreachableClient() {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('a converted screen (ChangelogScreen)', () => {
  afterEach(() => act(() => activeLocale.set('en-US')));

  it('shows the network-down line in English', async () => {
    render(withQuery(<ChangelogScreen client={unreachableClient()} />));
    expect(await screen.findByText(API_ERROR_NETWORK_DOWN_EN)).toBeInTheDocument();
  });

  it('shows the network-down line in Arabic, with no English left', async () => {
    act(() => activeLocale.set('ar-EG'));
    const { container } = render(withQuery(<ChangelogScreen client={unreachableClient()} />));
    expect(await screen.findByText(AR_NETWORK_DOWN)).toBeInTheDocument();
    expect(container.textContent).not.toContain('Is it running?');
    expect(container.textContent).not.toContain(API_ERROR_GENERIC_EN);
  });
});
