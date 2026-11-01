import { activeIsEnglish, translateOr } from './i18n/compact-time';

/**
 * An audit row's sentence in the active locale (2026-10-31 Arabic live test).
 *
 * The API already sends each row's plain sentence (`summary`, from the domain's action labels),
 * but only in English, so the Control Center's "Recent activity" read "Updated their own profile"
 * in the middle of an Arabic screen. The action code is a stable key, so the sentence is looked up
 * as `AuditActionLabel.<action>` and the server's English summary is kept for English, for an
 * action the catalog does not know yet, and for any key not merged into the catalogs.
 */
export function auditSentence(event: {
  readonly action: string;
  readonly result: 'allowed' | 'denied' | 'error';
  readonly summary: string;
}): string {
  if (activeIsEnglish()) return event.summary;
  const label = translateOr(`AuditActionLabel.${event.action}`, '');
  if (label === '') return event.summary;
  if (event.result === 'allowed' || event.action === 'security.capability_denied') return label;
  return event.result === 'denied'
    ? `${label} ${translateOr('AuditActionLabel.suffixRefused', '(refused)')}`
    : `${label} ${translateOr('AuditActionLabel.suffixFailed', '(failed)')}`;
}
