import { describe, expect, it } from 'vitest';
import {
  CLIENT_NAVIGATION,
  CONTROL_CENTER_NAVIGATION,
  INTERNAL_NAVIGATION,
} from '../src/components/shell/navigation';
import { translate } from '../src/lib/i18n/t';
import en from '../src/lib/i18n/messages/en.json';

/**
 * CQ-20 (ACT-02) — the shell chrome renders its navigation through the message catalog, so an
 * Arabic member sees Arabic rail, dock and portal labels instead of English ones.
 *
 * The invariant that keeps the existing shell and audience tests valid is that each item's English
 * catalog value is exactly its `label`: those tests read `label` (and render in the default English
 * locale), so they must keep seeing the same words. Arabic must be a real, different translation.
 */
const ALL_ITEMS = [...INTERNAL_NAVIGATION, CONTROL_CENTER_NAVIGATION, ...CLIENT_NAVIGATION];

describe('navigation labels resolve through the catalog', () => {
  it('English resolves to each item’s own label', () => {
    for (const item of ALL_ITEMS) {
      expect(translate('en-US', item.messageKey), `${item.id} English label`).toBe(item.label);
    }
  });

  it('Arabic resolves to a real, non-English translation', () => {
    for (const item of INTERNAL_NAVIGATION) {
      const arabic = translate('ar-EG', item.messageKey);
      expect(arabic.trim().length, `${item.id} Arabic label is non-empty`).toBeGreaterThan(0);
      expect(arabic, `${item.id} Arabic label differs from English`).not.toBe(item.label);
    }
  });

  it('every navigation messageKey exists in the English source catalog', () => {
    for (const item of ALL_ITEMS) {
      expect(item.messageKey in en, `${item.messageKey} is in en.json`).toBe(true);
    }
  });
});
