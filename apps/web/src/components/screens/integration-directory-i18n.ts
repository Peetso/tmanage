import type { IntegrationAppView } from '../../lib/api/integration-directory';
import { activeIsEnglish, relativeAgo as relativeAgoIntl } from '../../lib/i18n/compact-time';
import {
  appState,
  describeApp,
  describeAppLine,
  directoryTitle,
  relativeAgo,
} from './integration-directory-view';

/**
 * The INT-01 directory's generated copy in the active locale (C6, 2026-11-02 Arabic live test).
 *
 * `integration-directory-view` builds English sentences ("One connected", "sends notifications and
 * posts to a channel", "3 h ago"). English keeps exactly those strings; every other locale reads
 * catalog keys through `tr` (the English text is the fallback until the key is merged) and the
 * platform's own relative-time phrase.
 */
export type Translate = (key: string, english: string) => string;

const KEY = 'IntegrationDirectoryScreen';

/** The headline: "Nothing connected yet", or "{count} connected, {count} pending". */
export function localizedDirectoryTitle(
  apps: readonly IntegrationAppView[],
  tr: Translate,
  locale: string,
): string {
  if (activeIsEnglish(locale)) return directoryTitle(apps);
  const live = apps.filter((app) => appState(app) === 'live').length;
  const pending = apps.filter((app) => appState(app) === 'pending').length;
  if (live === 0 && pending === 0) return tr(`${KEY}.titleNothing`, 'Nothing connected yet');
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  const parts: string[] = [];
  if (live > 0)
    parts.push(tr(`${KEY}.titleConnected`, '{count} connected').replace('{count}', count(live)));
  if (pending > 0)
    parts.push(tr(`${KEY}.titlePending`, '{count} pending').replace('{count}', count(pending)));
  return parts.join(tr(`${KEY}.listSeparator`, ', '));
}

function phrases(app: IntegrationAppView, tr: Translate): string {
  const words = app.capabilities.map((capability) =>
    tr(`${KEY}.capability.${capability}`, capability.replace(/[-_.]/g, ' ')),
  );
  if (words.length === 0) return tr(`${KEY}.category.${app.category}`, app.category);
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(tr(`${KEY}.listSeparator`, ', '))}${tr(`${KEY}.listAnd`, ' and ')}${words[words.length - 1]!}`;
}

/** A card's sentence: what the app does, in the active locale. */
export function localizedDescribeApp(
  app: IntegrationAppView,
  tr: Translate,
  locale: string,
): string {
  return activeIsEnglish(locale) ? describeApp(app) : phrases(app, tr);
}

/** An available row's line: the same phrase, no full stop. */
export function localizedDescribeAppLine(
  app: IntegrationAppView,
  tr: Translate,
  locale: string,
): string {
  return activeIsEnglish(locale) ? describeAppLine(app) : phrases(app, tr);
}

/** A connection's age: "3 h ago" in English, "قبل ٣ ساعات" in Arabic. */
export function localizedRelativeAgo(
  iso: string,
  tr: Translate,
  locale: string,
  now: number = Date.now(),
): string {
  if (activeIsEnglish(locale)) return relativeAgo(iso, now);
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (Number.isNaN(minutes)) return iso;
  if (minutes < 1) return tr(`${KEY}.justNow`, 'just now');
  if (minutes < 60) return relativeAgoIntl(minutes, 'minute', locale);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relativeAgoIntl(hours, 'hour', locale);
  return relativeAgoIntl(Math.floor(hours / 24), 'day', locale);
}
