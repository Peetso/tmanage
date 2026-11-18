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

/** An absolute https link stays (a release note may point at the public site); a path is in-app. */
export function personMailLink(link: string, webOrigin: string, slug: string): string {
  if (/^https:\/\//u.test(link)) return link;
  const base = webOrigin.replace(/\/+$/u, '');
  return `${base}/${encodeURIComponent(slug)}${link.startsWith('/') ? link : `/${link}`}`;
}

export function composePersonMail(kind: PersonMailKind, context: PersonMailContext): MailMessage {
  const { language } = context;
  const copy = kind.copy[language];
  const values = { workspaceName: oneLine(context.workspaceName), count: context.count };
  const url = personMailLink(kind.link, context.webOrigin, context.slug);
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
