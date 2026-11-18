import { anchored, greeting, plainMailText, signOff } from '@tmanage/mail';
import type { MailLanguage, MailMessage } from '@tmanage/mail';
import type { PersonMailKind } from './person-mail-catalog.js';
import { renderPersonMailHtml } from './person-mail-html.js';

/**
 * EMAILBUILD2 — the one frame every person mail uses: greeting, the kind's lines, the one button
 * (as "{label}: {link}"), the reply line, then the person's signature ([PERSON] tokens the sender
 * resolver fills, with the settings and unsubscribe links the notification transport fills).
 * HTML in the mail card (Figma 708:38748 / 708:38787), with the plain text kept as the fallback.
 *
 * Template key `tip` is the only key the resolver signs with a registry person; `personRef` names
 * the member and the topic, so the same person always writes to the same member about it.
 */

export interface PersonMailContext {
  readonly to: string;
  readonly language: MailLanguage;
  readonly displayName: string;
  readonly workspaceName: string;
  readonly slug: string;
  readonly webOrigin: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly count: number;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function fill(
  template: string,
  values: { readonly workspaceName: string; readonly count: number },
) {
  return template
    .replaceAll('{workspaceName}', values.workspaceName)
    .replaceAll('{count}', String(values.count));
}

/**
 * The public pages with an Arabic twin under `/ar` (apps/web `app/ar/arabic-pages.ts` and the
 * `app/ar/(site)` routes). A path outside this list has no Arabic page, so its link stays English
 * rather than pointing at the Arabic 404.
 */
const ARABIC_TWIN_PAGES: ReadonlySet<string> = new Set([
  '/',
  '/about',
  '/accessibility',
  '/changelog',
  '/client-portal',
  '/contact',
  '/customers',
  '/developers',
  '/download',
  '/facts',
  '/faq',
  '/features/communication',
  '/features/insights',
  '/features/knowledge',
  '/features/work',
  '/integrations',
  '/legal/privacy',
  '/legal/terms',
  '/pricing',
  '/product',
  '/resources',
  '/security',
  '/security/data-location',
  '/security/disclosure',
  '/sign-in',
  '/sign-up',
  '/solutions/agencies',
  '/solutions/consultancies',
  '/solutions/in-house',
  '/status',
  '/alternatives',
  '/compare',
  '/help',
]);
/** Sections whose every article has an Arabic twin (`/ar/help/<slug>` …). */
const ARABIC_TWIN_SECTIONS = ['/alternatives/', '/compare/', '/help/', '/resources/', '/switch/'];
const PUBLIC_HOSTS: ReadonlySet<string> = new Set(['tmanageapp.com', 'www.tmanageapp.com']);

function hasArabicTwin(path: string): boolean {
  const bare = path.length > 1 ? path.replace(/\/+$/u, '') : path;
  return (
    ARABIC_TWIN_PAGES.has(bare) ||
    ARABIC_TWIN_SECTIONS.some((section) => bare.startsWith(section) && bare.length > section.length)
  );
}

/**
 * MAILREST — an Arabic reader's link to a TManage public page opens its Arabic twin
 * (`https://tmanageapp.com/changelog` -> `https://tmanageapp.com/ar/changelog`). Only TManage's
 * own site (the web origin or tmanageapp.com) and only pages that have a twin; any other link,
 * and a link already under `/ar`, is returned unchanged.
 */
export function arabicPublicLink(link: string, webOrigin: string): string {
  let url: URL;
  let origin: URL | null = null;
  try {
    url = new URL(link);
  } catch {
    return link;
  }
  try {
    origin = new URL(webOrigin);
  } catch {
    origin = null;
  }
  const ours = PUBLIC_HOSTS.has(url.hostname) || (origin !== null && url.host === origin.host);
  if (url.protocol !== 'https:' || !ours) return link;
  if (url.pathname === '/ar' || url.pathname.startsWith('/ar/')) return link;
  if (!hasArabicTwin(url.pathname)) return link;
  url.pathname = url.pathname === '/' ? '/ar' : `/ar${url.pathname}`;
  return url.toString();
}

/**
 * An absolute https link stays (a release note may point at the public site; an Arabic reader gets
 * the page's Arabic twin); a path is in-app, where the reader's own language already applies.
 */
export function personMailLink(
  link: string,
  webOrigin: string,
  slug: string,
  language: MailLanguage = 'en',
): string {
  if (/^https:\/\//u.test(link)) {
    return language === 'ar' ? arabicPublicLink(link, webOrigin) : link;
  }
  const base = webOrigin.replace(/\/+$/u, '');
  return `${base}/${encodeURIComponent(slug)}${link.startsWith('/') ? link : `/${link}`}`;
}

export function composePersonMail(kind: PersonMailKind, context: PersonMailContext): MailMessage {
  const { language } = context;
  const copy = kind.copy[language];
  const values = { workspaceName: oneLine(context.workspaceName), count: context.count };
  const url = personMailLink(kind.link, context.webOrigin, context.slug, language);
  const subject = anchored(language, oneLine(fill(copy.subject, values)));
  const lines = copy.lines.map((line) => fill(line, values));
  const button = fill(copy.button, values);
  const signature = signOff('person', language);
  return {
    to: context.to,
    language,
    subject,
    text: plainMailText(language, {
      name: context.displayName,
      lines: [...lines, `${button}: ${url}`, copy.close],
      signature,
    }),
    html: renderPersonMailHtml({
      subject,
      heading: greeting(language, context.displayName),
      lines,
      button: { label: button, url },
      close: copy.close,
      signature,
      arabic: language === 'ar',
    }),
    templateKey: 'tip',
    organizationId: context.organizationId,
    personRef: { kind: 'assigned', userId: context.userId, topic: kind.topic },
  };
}
