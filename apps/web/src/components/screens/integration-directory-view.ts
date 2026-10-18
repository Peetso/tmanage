import type { IntegrationAppView } from '../../lib/api/integration-directory';

/** Pure view helpers for the INT-01 directory: the headline, card copy and relative times. */

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** INT-01 writes small counts as words ("Four connected, one broken"). */
export function numberWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

/** An app is live when any of its connections is connected; pending when it has only pending ones. */
export function appState(app: IntegrationAppView): 'live' | 'pending' | 'none' {
  if (app.connections.some((c) => c.status === 'connected')) return 'live';
  return app.connections.length > 0 ? 'pending' : 'none';
}

/** The headline, counted per app: "One connected, one pending", or "Nothing connected yet". */
export function directoryTitle(apps: readonly IntegrationAppView[]): string {
  const live = apps.filter((app) => appState(app) === 'live').length;
  const pending = apps.filter((app) => appState(app) === 'pending').length;
  if (live === 0 && pending === 0) return 'Nothing connected yet';
  const parts: string[] = [];
  if (live > 0) parts.push(`${numberWord(live)} connected`);
  if (pending > 0) parts.push(`${numberWord(pending)} pending`);
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Plain words for the catalog's own capability handles. Unknown handles fall back to their name. */
const CAPABILITY_PHRASES: Record<string, string> = {
  notify: 'sends notifications',
  'channel-post': 'posts to a channel',
  'calendar-sync': 'keeps calendar events in step',
  'issue-sync': 'mirrors issues',
  webhook: 'receives webhook events',
  trigger: 'starts flows from TManage events',
  action: 'acts on records you choose',
};

/** One sentence for a card or row: "Sends notifications and posts to a channel." */
export function describeApp(app: IntegrationAppView): string {
  const phrases = app.capabilities.map(
    (capability) => CAPABILITY_PHRASES[capability] ?? capability.replace(/[-_.]/g, ' '),
  );
  if (phrases.length === 0)
    return `${app.category.charAt(0).toUpperCase()}${app.category.slice(1)}.`;
  const joined =
    phrases.length === 1
      ? phrases[0]!
      : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]!}`;
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/** INT-01's mono foot time: "JUST NOW", "4 MIN AGO", "3 H AGO", "2 DAYS AGO". */
export function relativeAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The available-row line: the same sentence, lower-case first letter, no full stop. */
export function describeAppLine(app: IntegrationAppView): string {
  const sentence = describeApp(app).replace(/\.$/, '');
  return `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}
