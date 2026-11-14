// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISPLAY_FORMAT_COOKIE_NAME } from '../src/lib/i18n/display-format-cookie';
import { LOCALE_COOKIE_NAME } from '../src/lib/i18n/locale-cookie';
import { translate } from '../src/lib/i18n/t';
import { useDisplayFormatters } from '../src/lib/i18n/use-formatters';
import { useT } from '../src/lib/i18n/use-t';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * FIX6 locale flash (Peter, 2026-11-14: "the translation is still appearing English in the first
 * second of page loading"). A signed-in page is rendered per request; its server HTML must already
 * be in the member's saved language and direction, with their saved digits, read from the
 * allowlisted cookies of *that* request. Next's request store is faked here exactly as the root
 * layout reads it; the layout itself is rendered to HTML with a probe page inside.
 */
const request = vi.hoisted(() => ({
  type: 'request' as 'request' | 'prerender',
  cookies: new Map<string, string>(),
}));

vi.mock('next/dist/server/app-render/work-unit-async-storage.external', () => ({
  workUnitAsyncStorage: {
    getStore: () => ({
      type: request.type,
      cookies: {
        get: (name: string) =>
          request.cookies.has(name) ? { name, value: request.cookies.get(name) } : undefined,
      },
    }),
  },
}));
vi.mock('next/dist/server/app-render/work-async-storage.external', () => ({
  workAsyncStorage: { getStore: () => ({ route: '/[orgSlug]' }) },
}));
vi.mock('next/font/local', () => ({ default: () => ({ variable: 'font-manrope' }) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/acme',
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  request.type = 'request';
  request.cookies.clear();
});

function Probe() {
  const t = useT();
  const format = useDisplayFormatters();
  return (
    <main>
      <p id="hook">{t('WorkDetail.noFiles')}</p>
      <p id="direct">{translate(activeLocale.get(), 'WorkDetail.noFiles')}</p>
      <p id="digits">{format.number(12)}</p>
    </main>
  );
}

async function firstHtml(): Promise<string> {
  const { default: RootLayout } = await import('../src/app/layout');
  return renderToString(RootLayout({ children: <Probe /> }));
}

describe('the first HTML of a signed-in page', () => {
  it('is Arabic and right-to-left for an Arabic preference, from hooks and direct reads alike', async () => {
    request.cookies.set(LOCALE_COOKIE_NAME, 'ar-EG');
    request.cookies.set(DISPLAY_FORMAT_COOKIE_NAME, 'arabic_indic.iso');
    const html = await firstHtml();
    expect(html).toMatch(/<html[^>]* lang="ar-EG"[^>]* dir="rtl"/);
    const arabic = translate('ar-EG', 'WorkDetail.noFiles');
    expect(arabic).not.toBe(translate('en-US', 'WorkDetail.noFiles'));
    expect(html).toContain(`<p id="hook">${arabic}</p>`);
    expect(html).toContain(`<p id="direct">${arabic}</p>`);
    expect(html).toContain('<p id="digits">١٢</p>');
    expect(html).not.toContain(translate('en-US', 'WorkDetail.noFiles'));
  });

  it('keeps the saved Latin digits for an Arabic member who chose them', async () => {
    request.cookies.set(LOCALE_COOKIE_NAME, 'ar-EG');
    request.cookies.set(DISPLAY_FORMAT_COOKIE_NAME, 'latin.');
    expect(await firstHtml()).toContain('<p id="digits">12</p>');
  });

  it('falls back to English left-to-right for an unsupported or crafted cookie', async () => {
    request.cookies.set(LOCALE_COOKIE_NAME, '"><script>');
    request.cookies.set(DISPLAY_FORMAT_COOKIE_NAME, 'roman.nope.x');
    const html = await firstHtml();
    expect(html).toMatch(/<html[^>]* lang="en"[^>]* dir="ltr"/);
    expect(html).toContain(`<p id="hook">${translate('en-US', 'WorkDetail.noFiles')}</p>`);
    expect(html).not.toContain('<script>"');
  });

  it('renders the English baseline in a build-time prerender, which reads no request', async () => {
    request.type = 'prerender';
    request.cookies.set(LOCALE_COOKIE_NAME, 'ar-EG');
    const html = await firstHtml();
    expect(html).toMatch(/<html[^>]* lang="en"[^>]* dir="ltr"/);
    expect(html).toContain(`<p id="hook">${translate('en-US', 'WorkDetail.noFiles')}</p>`);
  });
});
