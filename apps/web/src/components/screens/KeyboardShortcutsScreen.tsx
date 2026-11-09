'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getShortcutMap,
  isValidChord,
  rebindShortcut,
  resetShortcut,
} from '../../lib/api/keyboard-shortcuts';
import type { ResolvedShortcutView } from '../../lib/api/keyboard-shortcuts';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/preferences.css';

export interface KeyboardShortcutsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

/**
 * Turn a browser keydown into a chord string in the API's canonical shape (`Ctrl+Shift+K`), or null
 * when the key pressed is only a modifier. Held modifiers order canonically; a single character
 * upper-cases so `k` and `K` are one chord.
 */
function chordFromEvent(event: React.KeyboardEvent): string | null {
  const key = event.key;
  if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') {
    return null;
  }
  const mods: string[] = [];
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Meta');
  const ordered = MODIFIER_ORDER.filter((mod) => mods.includes(mod));
  const token = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
  return [...ordered, token].join('+');
}

/** `Ctrl+Shift+K` drawn the way the design writes a key: `Ctrl Shift K`. */
function showChord(chord: string): string {
  return chord.split('+').join(' ');
}

/**
 * **Keyboard (PREF-05; module 20 Preferences & accessibility, PRF keyboard, x286).**
 *
 * PREF-05's frame: two white cards of shortcuts ("Getting around" — the navigation actions — and
 * "Doing things"), and the black command-bar card beside them. A member reads their resolved map
 * (defaults overlaid with their overrides), clicks a key to capture a new chord, saves it, or resets
 * it — persisted behind `work.read`, scoped to the caller's own membership by the server. The capture
 * control validates the chord shape before enabling save. "Reset to defaults" resets every action
 * the member has rebound.
 */
export function KeyboardShortcutsScreen({
  organizationSlug,
  organizationName,
  client,
}: KeyboardShortcutsScreenProps) {
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();

  const shortcuts = useQuery({
    queryKey: ['keyboard-shortcuts', organizationSlug],
    queryFn: () => getShortcutMap(api, organizationSlug),
  });

  // The action currently being captured, and the chord captured for it (pending save).
  const [capturing, setCapturing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const rebind = useMutation({
    mutationFn: (input: { actionKey: string; chord: string }) =>
      rebindShortcut(api, organizationSlug, input.actionKey, input.chord),
    onSuccess: () => {
      setCapturing(null);
      setDraft('');
      void queries.invalidateQueries({ queryKey: ['keyboard-shortcuts', organizationSlug] });
    },
  });

  const reset = useMutation({
    mutationFn: async (actionKeys: readonly string[]) => {
      for (const actionKey of actionKeys) {
        await resetShortcut(api, organizationSlug, actionKey);
      }
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: ['keyboard-shortcuts', organizationSlug] });
    },
  });

  const startCapture = (actionKey: string) => {
    setCapturing(actionKey);
    setDraft('');
  };

  const draftValid = draft.length > 0 && isValidChord(draft);
  const all = shortcuts.data?.shortcuts ?? [];
  const overridden = all.filter((shortcut) => shortcut.overridden).map((s) => s.actionKey);
  const around = all.filter((shortcut) => shortcut.actionKey.startsWith('nav-'));
  const doing = all.filter((shortcut) => !shortcut.actionKey.startsWith('nav-'));
  const search = all.find((shortcut) => shortcut.actionKey === 'act-search');

  const renderRow = (shortcut: ResolvedShortcutView) => (
    <li className="tm-prefs-key" key={shortcut.actionKey}>
      <span className="tm-prefs-key__title">
        {shortcut.title}
        {shortcut.overridden ? (
          <span className="tm-prefs-key__custom"> · {t('KeyboardShortcutsScreen.custom')}</span>
        ) : null}
      </span>
      {capturing === shortcut.actionKey ? (
        <>
          <input
            // Focus on mount via a ref callback rather than the `autoFocus` prop, which jsx-a11y
            // forbids: capture needs the field focused so the next keypress lands.
            ref={(element) => {
              element?.focus();
            }}
            className="tm-prefs-kbd-input"
            type="text"
            readOnly
            aria-label={`${t('KeyboardShortcutsScreen.pressNewShortcut')} ${shortcut.title}`}
            value={draft}
            placeholder={t('KeyboardShortcutsScreen.pressKeyCombination')}
            onKeyDown={(event) => {
              event.preventDefault();
              const chord = chordFromEvent(event);
              if (chord) setDraft(chord);
            }}
          />
          <span className="tm-prefs-key__actions">
            <button
              type="button"
              className="tm-prefs-capsule tm-prefs-capsule--ink"
              disabled={!draftValid || rebind.isPending}
              onClick={() => rebind.mutate({ actionKey: shortcut.actionKey, chord: draft })}
            >
              {t('KeyboardShortcutsScreen.save')}
            </button>
            <button
              type="button"
              className="tm-prefs-capsule"
              onClick={() => {
                setCapturing(null);
                setDraft('');
              }}
            >
              {t('KeyboardShortcutsScreen.cancel')}
            </button>
          </span>
        </>
      ) : (
        <>
          {shortcut.overridden ? (
            <button
              type="button"
              className="tm-prefs-capsule"
              disabled={reset.isPending}
              aria-label={`${t('KeyboardShortcutsScreen.reset')} ${shortcut.title} ${t('KeyboardShortcutsScreen.toWord')} ${shortcut.defaultChord}`}
              onClick={() => reset.mutate([shortcut.actionKey])}
            >
              {t('KeyboardShortcutsScreen.reset')}
            </button>
          ) : null}
          <button
            type="button"
            className={shortcut.overridden ? 'tm-prefs-kbd tm-prefs-kbd--custom' : 'tm-prefs-kbd'}
            aria-label={`${t('KeyboardShortcutsScreen.rebindVerb')} ${shortcut.title}${t('KeyboardShortcutsScreen.nowComma')} ${shortcut.chord}`}
            onClick={() => startCapture(shortcut.actionKey)}
          >
            <kbd>{showChord(shortcut.chord)}</kbd>
          </button>
        </>
      )}
    </li>
  );

  return (
    <SettingsShell
      section="preferences"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('KeyboardShortcutsScreen.eyebrow')}
      title={t('KeyboardShortcutsScreen.title')}
      actions={
        <button
          type="button"
          className="tm-prefs-capsule"
          disabled={overridden.length === 0 || reset.isPending}
          onClick={() => reset.mutate(overridden)}
        >
          {t('KeyboardShortcutsScreen.resetToDefaults')}
        </button>
      }
    >
      {shortcuts.isPending ? (
        <LoadingRegion label={t('KeyboardShortcutsScreen.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : shortcuts.isError ? (
        <InlineAlert tone="danger" title={t('KeyboardShortcutsScreen.loadErrorTitle')}>
          {errorMessage(shortcuts.error)}
        </InlineAlert>
      ) : (
        <div className="tm-prefs tm-prefs--keyboard">
          <div className="tm-prefs__main">
            {rebind.isError ? (
              <InlineAlert tone="danger" title={t('KeyboardShortcutsScreen.saveErrorTitle')}>
                {errorMessage(rebind.error)}
              </InlineAlert>
            ) : null}
            {reset.isError ? (
              <InlineAlert tone="danger" title={t('KeyboardShortcutsScreen.resetErrorTitle')}>
                {errorMessage(reset.error)}
              </InlineAlert>
            ) : null}
            {capturing && draft.length > 0 && !draftValid ? (
              <InlineAlert tone="warning" title={t('KeyboardShortcutsScreen.invalidComboTitle')}>
                {t('KeyboardShortcutsScreen.invalidComboBody')}
              </InlineAlert>
            ) : null}

            <div className="tm-prefs__pair">
              <section
                className="tm-prefs-card tm-prefs-card--tight"
                aria-labelledby="tm-keys-around"
              >
                <h2 id="tm-keys-around" className="tm-prefs-eyebrow">
                  {t('KeyboardShortcutsScreen.gettingAround')}
                </h2>
                <ul className="tm-prefs-keys">{around.map(renderRow)}</ul>
              </section>
              <section
                className="tm-prefs-card tm-prefs-card--tight"
                aria-labelledby="tm-keys-doing"
              >
                <h2 id="tm-keys-doing" className="tm-prefs-eyebrow">
                  {t('KeyboardShortcutsScreen.doingThings')}
                </h2>
                <ul className="tm-prefs-keys">{doing.map(renderRow)}</ul>
              </section>
            </div>
          </div>

          <div className="tm-prefs__side">
            <section
              className="tm-prefs-card tm-prefs-card--ink tm-prefs-card--grow"
              aria-labelledby="tm-keys-command"
            >
              <h2 id="tm-keys-command" className="tm-prefs-eyebrow">
                {t('KeyboardShortcutsScreen.commandBar')}
                {search ? ` · ${showChord(search.chord)}` : ''}
              </h2>
              <div className="tm-prefs-command" aria-hidden="true">
                {t('KeyboardShortcutsScreen.typeACommand')}
                <span className="tm-prefs-command__caret">|</span>
              </div>
              <ul className="tm-prefs-command-list">
                {doing.slice(0, 3).map((shortcut) => (
                  <li className="tm-prefs-command-list__item" key={shortcut.actionKey}>
                    <span className="tm-prefs-command-list__name">{shortcut.title}</span>
                    <span className="tm-prefs-command-list__chord">
                      {showChord(shortcut.chord)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="tm-prefs-card__note tm-prefs-card__foot">
                {t('KeyboardShortcutsScreen.commandNote')}
              </p>
            </section>
            <div className="tm-prefs-card tm-prefs-card--paper">
              <p className="tm-prefs-card__body">{t('KeyboardShortcutsScreen.rebindNote')}</p>
            </div>
          </div>
        </div>
      )}
    </SettingsShell>
  );
}
