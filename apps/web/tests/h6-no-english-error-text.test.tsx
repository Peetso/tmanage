import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyDayScreen } from '../src/components/screens/MyDayScreen';
import { RequestInboxScreen } from '../src/components/screens/RequestInboxScreen';
import { RequestTagsView } from '../src/components/screens/RequestTagsView';
import { describePeopleError } from '../src/components/screens/peopleShared';
import { ApiClient } from '../src/lib/api/client';
import {
  API_ERROR_GENERIC_EN,
  API_ERROR_NETWORK_DOWN_EN,
  API_ERROR_OFFLINE_EN,
  API_ERROR_PORTAL_DOWN_EN,
  describeApiError,
  describeApiErrorNow,
  OFFLINE_LINES,
  PORTAL_LINES,
  STATUS_LINES,
} from '../src/lib/api/describe-error';
import { ApiRequestError, NetworkError } from '../src/lib/api/errors';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * **H6 — no English developer text left in Arabic error states** (audit 2026-10-25b, gap 6).
 * Seventy-odd screens still kept a local `describe()` returning hard-coded English ("The API did
 * not answer. Is it running?", "…Check that it is running.", the portal's and status page's own
 * lines). They now use the shared catalog helper. The new keys reach `ar.json` through the
 * `wave8/i18n-H6` fragment; the Arabic catalog is extended here with the same lines so the Arabic
 * render is proven before the merge.
 */
const AR_NETWORK_DOWN = 'لم تستجب الواجهة البرمجية. هل هي قيد التشغيل؟';
const AR_OFFLINE = 'تعذّر الوصول إلى TManage. تحقّق من اتصالك وحاول مرة أخرى.';

vi.mock('../src/lib/i18n/messages/ar.json', async (importOriginal) => {
  const original = (await importOriginal()) as { default: Record<string, string> };
  return {
    default: {
      ...original.default,
      'ApiError.networkDown': 'لم تستجب الواجهة البرمجية. هل هي قيد التشغيل؟',
      'ApiError.generic': 'حدث خطأ ما. حاول مرة أخرى.',
      'ApiError.offline': 'تعذّر الوصول إلى TManage. تحقّق من اتصالك وحاول مرة أخرى.',
      'ApiError.portalDown': 'البوابة لا تستجيب. حاول مرة أخرى بعد قليل.',
      'ApiError.statusDown': 'لم تستجب خدمة الحالة. حاول مرة أخرى بعد قليل.',
    },
  };
});

afterEach(() => act(() => activeLocale.set('en-US')));

const englishOnly = (_key: string, english: string) => english;

describe('describeApiError lines', () => {
  it('uses a screen’s own catalog key for a request that got no answer', () => {
    const t = vi.fn(englishOnly);
    expect(describeApiError(new NetworkError('x'), t, PORTAL_LINES)).toBe(API_ERROR_PORTAL_DOWN_EN);
    expect(t).toHaveBeenCalledWith('ApiError.portalDown', API_ERROR_PORTAL_DOWN_EN);
    describeApiError(new NetworkError('x'), t, STATUS_LINES);
    expect(t).toHaveBeenCalledWith('ApiError.statusDown', expect.any(String));
  });

  it('keeps the shared generic line and the server’s refusal message', () => {
    expect(describeApiError(new Error('boom'), englishOnly, OFFLINE_LINES)).toBe(
      API_ERROR_GENERIC_EN,
    );
    const refusal = new ApiRequestError(403, 'forbidden', 'You cannot see this.', 'c-1');
    expect(describeApiError(refusal, englishOnly, OFFLINE_LINES)).toBe('You cannot see this.');
  });

  it('never renders the NetworkError’s own English message', () => {
    const line = describeApiError(
      new NetworkError('The request did not reach TManage.'),
      englishOnly,
      OFFLINE_LINES,
    );
    expect(line).toBe(API_ERROR_OFFLINE_EN);
  });
});

describe('describeApiErrorNow (helpers that are not hooks)', () => {
  it('follows the active locale', () => {
    expect(describeApiErrorNow(new NetworkError('x'), OFFLINE_LINES)).toBe(API_ERROR_OFFLINE_EN);
    act(() => activeLocale.set('ar-EG'));
    expect(describeApiErrorNow(new NetworkError('x'), OFFLINE_LINES)).toBe(AR_OFFLINE);
    expect(describePeopleError(new NetworkError('x'))).toBe(AR_NETWORK_DOWN);
  });
});

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

describe('the screens named in the audit, in Arabic', () => {
  it('RequestInboxScreen shows the catalog line in English', async () => {
    render(
      withQuery(
        <RequestInboxScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={unreachableClient()}
        />,
      ),
    );
    expect(await screen.findByText(API_ERROR_NETWORK_DOWN_EN)).toBeInTheDocument();
  });

  it('RequestInboxScreen shows Arabic, with no English left', async () => {
    act(() => activeLocale.set('ar-EG'));
    const { container } = render(
      withQuery(
        <RequestInboxScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={unreachableClient()}
        />,
      ),
    );
    expect(await screen.findByText(AR_NETWORK_DOWN)).toBeInTheDocument();
    expect(container.textContent).not.toContain('Is it running?');
  });

  it('RequestTagsView shows Arabic, with no English left', async () => {
    act(() => activeLocale.set('ar-EG'));
    const { container } = render(
      withQuery(
        <RequestTagsView
          organizationSlug="acme"
          clientRequestId="req-1"
          client={unreachableClient()}
        />,
      ),
    );
    expect(await screen.findByText(AR_NETWORK_DOWN)).toBeInTheDocument();
    expect(container.textContent).not.toContain('Is it running?');
  });
});

/**
 * **My Day** (audit 2026-10-26, gap 2): its sections each word their own failure, through
 * `useDescribeApiError` and `MyDayScreen.*Error` catalog keys — summary, waiting and saved. The work
 * list (PHONE review point 19) shows one load-error sentence, `MyDayScreen.workError`, with no second
 * line. The Arabic lines come from the real `ar.json`.
 */
const AR_MY_DAY_NETWORK = [
  'انقطع الاتصال قبل تحميل ملخّصك.',
  'تعذّر تحميل مهامك. تحقّق من الاتصال وحاول مرة أخرى.',
  'انقطع الاتصال قبل تحميل المراجعات.',
  'انقطع الاتصال قبل تحميل العناصر المحفوظة.',
];

describe('MyDayScreen, in Arabic', () => {
  it('shows the English section lines in English', async () => {
    render(
      withQuery(
        <MyDayScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={unreachableClient()}
        />,
      ),
    );
    expect(
      await screen.findByText('The network dropped before your summary loaded.'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('The network dropped before your saved items loaded.'),
    ).toBeInTheDocument();
  });

  it('shows every section’s failure in Arabic, with no English left', async () => {
    act(() => activeLocale.set('ar-EG'));
    const { container } = render(
      withQuery(
        <MyDayScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={unreachableClient()}
        />,
      ),
    );
    for (const line of AR_MY_DAY_NETWORK) {
      expect(await screen.findByText(line)).toBeInTheDocument();
    }
    expect(container.textContent).not.toMatch(/The network dropped|Something went wrong/);
  });

  it('no longer words API failures itself', () => {
    const source = readFileSync(
      join(__dirname, '../src/components/screens/MyDayScreen.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/instanceof (NetworkError|ApiRequestError)/);
    expect(source).toContain('useDescribeApiError');
  });

  it('carries every MyDayScreen error key in both catalogs', () => {
    const catalog = (lang: string) =>
      JSON.parse(
        readFileSync(join(__dirname, `../src/lib/i18n/messages/${lang}.json`), 'utf8'),
      ) as Record<string, string>;
    const en = catalog('en');
    const ar = catalog('ar');
    for (const area of ['summary', 'waiting', 'saved']) {
      for (const kind of ['Network', 'Generic']) {
        const key = `MyDayScreen.${area}${kind}Error`;
        expect(en[key], key).toBeTruthy();
        expect(ar[key], key).toBeTruthy();
        expect(ar[key], key).not.toBe(en[key]);
        expect(ar[key], key).not.toMatch(/[A-Za-z]/);
      }
    }
  });
});

/** Every source file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('no screen hard-codes the developer error lines', () => {
  it('only describe-error.ts carries "Is it running?" or "Check that it is running."', () => {
    const offenders = sources(join(__dirname, '../src'))
      .filter((path) => !path.replace(/\\/g, '/').endsWith('lib/api/describe-error.ts'))
      .filter((path) =>
        /Is it running\?|Check that it is running\./.test(readFileSync(path, 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
