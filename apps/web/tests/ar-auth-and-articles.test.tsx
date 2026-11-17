import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../src/lib/i18n/messages/en.json';
import ar from '../src/lib/i18n/messages/ar.json';
import { SignInScreen } from '../src/components/screens/SignInScreen';
import { SignUpScreen } from '../src/components/screens/SignUpScreen';
import { ResourceArticlePage } from '../src/components/website/pages/resources/ResourceArticlePage';
import {
  ALL_RESOURCES,
  findResource,
} from '../src/components/website/pages/resources/resources-data';
import {
  ARABIC_POINTS,
  pointsIn,
} from '../src/components/website/pages/resources/resources-data-ar';
import { ApiClient } from '../src/lib/api/client';
import { ApiRequestError, NetworkError } from '../src/lib/api/errors';
import { readsApiLanguage, refusalLine } from '../src/lib/api/auth-refusal';
import { activeLocale, LocaleStore } from '../src/lib/i18n/locale-store';
import {
  arabicRouteMetadata,
  ARTICLE_PATHS,
  hasArabicTwin,
  languageSwitchTarget,
  localizeHref,
  publicAlternates,
} from '../src/lib/i18n/public-locale-routes';
import { RouteLocaleProvider } from '../src/lib/i18n/route-locale';
import { translate } from '../src/lib/i18n/t';
import sitemap from '../src/app/sitemap';

let mockPathname = '/ar/sign-in';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

/**
 * **Arabic sign-in, sign-up and articles at their own URLs** (Figma `428:10174`, `428:10214`,
 * `425:12257`, `426:13485`).
 *
 * `/ar/sign-in`, `/ar/sign-up` and `/ar/resources/<slug>` render the English pages' own screens
 * under the Arabic route locale. These tests pin the route table, the links and alternates, the
 * sitemap, the Arabic refusals (an Arabic screen never shows the API's English) and the articles'
 * Arabic content.
 */

const APP = join(__dirname, '..', 'src', 'app');
const ARABIC = /[؀-ۿ]/;

afterEach(() => {
  act(() => activeLocale.set('en-US'));
  window.localStorage.clear();
  mockPathname = '/ar/sign-in';
});

describe('the Arabic twins of sign-in, sign-up and the articles', () => {
  it('exist as routes, outside the website chrome for sign-in and sign-up', () => {
    expect(existsSync(join(APP, 'ar', 'sign-in', 'page.tsx'))).toBe(true);
    expect(existsSync(join(APP, 'ar', 'sign-up', 'page.tsx'))).toBe(true);
    expect(existsSync(join(APP, 'ar', '(site)', 'resources', '[slug]', 'page.tsx'))).toBe(true);
    expect(existsSync(join(APP, 'ar', '(site)', '[[...path]]', 'page.tsx'))).toBe(true);
    expect(readFileSync(join(APP, 'ar', 'layout.tsx'), 'utf8')).not.toContain('WebsiteChrome');
    expect(readFileSync(join(APP, 'ar', '(site)', 'layout.tsx'), 'utf8')).toContain(
      '<WebsiteChrome>',
    );
    // The same page and screen as English: one auth flow, one API.
    expect(readFileSync(join(APP, 'ar', 'sign-in', 'page.tsx'), 'utf8')).toContain(
      "import SignInPage from '../../sign-in/page';",
    );
    // Both wrap the screen in SignUpWithImport (d7c520fd), which keeps ?import= after sign-up.
    for (const page of [join(APP, 'ar', 'sign-up', 'page.tsx'), join(APP, 'sign-up', 'page.tsx')]) {
      expect(readFileSync(page, 'utf8')).toContain('<SignUpWithImport />');
    }
  });

  it('knows which paths have a twin', () => {
    for (const path of ['/sign-in', '/sign-up', '/pricing', '/resources', ...ARTICLE_PATHS]) {
      expect(hasArabicTwin(path), path).toBe(true);
    }
    expect(ARTICLE_PATHS).toHaveLength(ALL_RESOURCES.length);
    for (const path of ['/recover', '/sign-in/verify', '/resources/unknown', '/acme/home']) {
      expect(hasArabicTwin(path), path).toBe(false);
    }
  });

  it('points links, the language switch and hreflang at the twins', () => {
    expect(localizeHref('/resources/client-approval-playbook')).toBe(
      '/ar/resources/client-approval-playbook',
    );
    expect(localizeHref('/resources/unknown')).toBe('/resources/unknown');
    expect(localizeHref('/sign-in?next=%2Finvitations%2Fx')).toBe(
      '/ar/sign-in?next=%2Finvitations%2Fx',
    );
    expect(languageSwitchTarget('/ar/sign-up', false)).toBe('/sign-up');
    expect(languageSwitchTarget('/resources/retainers-without-the-chaos', true)).toBe(
      '/ar/resources/retainers-without-the-chaos',
    );
    expect(publicAlternates('/ar/sign-up')).toEqual({ en: '/sign-up', ar: '/ar/sign-up' });
    expect(publicAlternates('/ar/resources/what-a-governed-version-is')).toEqual({
      en: '/resources/what-a-governed-version-is',
      ar: '/ar/resources/what-a-governed-version-is',
    });
  });

  it('lists every indexed pair in the sitemap, each naming the other', () => {
    const urls = sitemap().map((entry) => new URL(entry.url).pathname);
    for (const path of ['/sign-up', '/ar/sign-up']) {
      expect(urls, path).toContain(path);
    }
    // SEOFIX: the sign-in form is noindex in both languages, so it is not in the sitemap.
    for (const path of ['/sign-in', '/ar/sign-in']) {
      expect(urls, path).not.toContain(path);
    }
    for (const path of ARTICLE_PATHS) {
      expect(urls).toContain(path);
      expect(urls).toContain(`/ar${path}`);
    }
    const entry = sitemap().find((row) => row.url.endsWith('/ar/sign-up'));
    expect(entry?.alternates?.languages).toEqual({
      en: expect.stringMatching(/\/sign-up$/),
      ar: expect.stringMatching(/\/ar\/sign-up$/),
    });
  });

  it('gives sign-in and sign-up Arabic titles', () => {
    expect(arabicRouteMetadata('/sign-in').title).toEqual({ absolute: 'تسجيل الدخول · TManage' });
    expect(arabicRouteMetadata('/sign-up').title).toEqual({
      absolute: `${translate('ar-EG', 'RouteTitle.signUp')} · TManage`,
    });
  });
});

describe('refusals in the reader’s language', () => {
  const refusal = (status: number) =>
    new ApiRequestError(status, 'unauthenticated', 'The request carries no valid session', 'c1');

  it('keeps the API’s words for English and uses the catalog for Arabic', () => {
    expect(readsApiLanguage('en-US')).toBe(true);
    expect(readsApiLanguage('ar-EG')).toBe(false);
    expect(refusalLine(refusal(401), 'en-US')).toBeUndefined();
    expect(refusalLine(refusal(401), 'ar-EG')).toBe('AuthRefusal.invalidCredentials');
    expect(refusalLine(refusal(429), 'ar-EG')).toBe('signUp.rateLimited');
    expect(refusalLine(refusal(422), 'ar-EG')).toBe('signUp.fieldsNeedAttention');
    expect(refusalLine(refusal(500), 'ar-EG')).toBe('signUp.generic');
    expect(refusalLine(new NetworkError('offline'), 'ar-EG')).toBeUndefined();
  });

  it('has every new line in both catalogs, Arabic in Arabic', () => {
    const EN: Record<string, string> = en;
    const AR: Record<string, string> = ar;
    for (const key of ['AuthRefusal.invalidCredentials', 'AuthRefusal.checkField']) {
      expect(EN[key], key).toBeTruthy();
      expect(AR[key], key).toMatch(ARABIC);
    }
  });
});

interface Call {
  readonly url: string;
  readonly method: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method };
      if (call.url.endsWith('/v1/auth/google')) {
        return Promise.resolve(json({ error: { code: 'not_found', message: 'Not found' } }, 404));
      }
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
}

function inArabic(children: React.ReactNode) {
  return (
    <RouteLocaleProvider locale="ar-EG" store={new LocaleStore('ar-EG')}>
      {children}
    </RouteLocaleProvider>
  );
}

describe('/ar/sign-in', () => {
  it('prerenders in Arabic with Arabic links to sign-up and the public pages', () => {
    const html = renderToString(
      inArabic(
        <SignInScreen
          client={clientOver(() => json({}))}
          developmentSignInEnabled={false}
          signUpOffered
        />,
      ),
    );
    expect(html).toContain(translate('ar-EG', 'SignInScreen.heading'));
    expect(html).toMatch(/href="\/ar\/sign-up"/);
    expect(html).toMatch(/href="\/ar\/legal\/privacy"/);
    expect(html).toMatch(/href="\/recover"/);
    expect(html).not.toMatch(/href="\/sign-up"/);
  });

  it('shows a wrong password in Arabic, the same line for every 401', async () => {
    const user = userEvent.setup();
    const client = clientOver(() =>
      json(
        {
          error: {
            code: 'unauthenticated',
            message: 'The request carries no valid session',
            correlationId: 'c1',
          },
        },
        401,
      ),
    );
    render(inArabic(<SignInScreen client={client} developmentSignInEnabled={false} />));
    await waitFor(() => expect(screen.getByLabelText(/بريد العمل/)).toBeEnabled());
    await user.type(screen.getByLabelText(/بريد العمل/), 'omar@northstar.studio');
    await user.type(screen.getByLabelText(/^كلمة المرور/), 'a quiet line on paper');
    await user.click(screen.getByRole('button', { name: 'تسجيل الدخول' }));
    expect(
      await screen.findByText(translate('ar-EG', 'AuthRefusal.invalidCredentials')),
    ).toBeInTheDocument();
    expect(screen.queryByText('The request carries no valid session')).toBeNull();
  });
});

describe('/ar/sign-up', () => {
  it('shows the API’s field refusal in Arabic', async () => {
    const user = userEvent.setup();
    const client = clientOver((call) =>
      call.method === 'POST'
        ? json(
            {
              error: {
                code: 'validation_failed',
                message: 'Request validation failed',
                correlationId: 'c1',
                details: [{ field: 'displayName', message: 'displayName is too long' }],
              },
            },
            422,
          )
        : json({ available: true }),
    );
    render(inArabic(<SignUpScreen client={client} />));
    await waitFor(() => expect(screen.getByRole('button', { name: 'متابعة' })).toBeEnabled());
    await user.type(screen.getByLabelText(/^البريد الإلكتروني/), 'mona@example.com');
    await user.click(screen.getByRole('button', { name: 'متابعة' }));
    await user.type(await screen.findByLabelText(/^الاسم الكامل/), 'منى عادل');
    await user.type(screen.getByLabelText(/^اسم مساحة العمل/), 'استوديو النيل');
    await user.type(screen.getByLabelText(/^كلمة المرور/), 'violet-harbour-lantern-41');
    await user.click(screen.getByRole('button', { name: 'إنشاء مساحة عملي' }));
    expect(
      await screen.findByText(translate('ar-EG', 'signUp.fieldsNeedAttention')),
    ).toBeInTheDocument();
    expect(screen.getByText(translate('ar-EG', 'AuthRefusal.checkField'))).toBeInTheDocument();
    expect(screen.queryByText(/displayName is too long|Request validation failed/)).toBeNull();
  });
});

describe('/ar/resources/<slug>', () => {
  it('has Arabic takeaways for every article', () => {
    expect(Object.keys(ARABIC_POINTS).sort()).toEqual(ALL_RESOURCES.map((r) => r.slug).sort());
    for (const item of ALL_RESOURCES) {
      const points = ARABIC_POINTS[item.slug] ?? [];
      expect(points, item.slug).toHaveLength(3);
      for (const point of points) expect(point, item.slug).toMatch(ARABIC);
      expect(pointsIn(item, 'en')).toBe(item.points);
    }
  });

  it('prerenders the article in Arabic, with Arabic links', () => {
    mockPathname = '/ar/resources/client-approval-playbook';
    const item = findResource('client-approval-playbook');
    if (item === undefined) throw new Error('missing article');
    const html = renderToString(inArabic(<ResourceArticlePage item={item} />));
    expect(html).toContain(translate('ar-EG', item.titleKey));
    expect(html).toContain(translate('ar-EG', item.lineKey));
    for (const point of ARABIC_POINTS[item.slug] ?? []) expect(html).toContain(point);
    expect(html).not.toContain(item.title);
    expect(html).not.toContain(item.points[0]);
    expect(html).toMatch(/href="\/ar\/resources"/);
    expect(html).toMatch(/href="\/ar\/resources\/client-review-in-ten-minutes"/);
  });

  it('keeps the English article in English', () => {
    mockPathname = '/resources/client-approval-playbook';
    const item = findResource('client-approval-playbook');
    if (item === undefined) throw new Error('missing article');
    const html = renderToString(<ResourceArticlePage item={item} />);
    expect(html).toContain(item.title);
    expect(html).toContain(item.points[0]);
    expect(html).toMatch(/href="\/resources\/client-review-in-ten-minutes"/);
  });
});
