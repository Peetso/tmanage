'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getShortcutMap,
  isValidChord,
  rebindShortcut,
  resetShortcut,
} from '../../lib/api/keyboard-shortcuts';
import type { ResolvedShortcutView } from '../../lib/api/keyboard-shortcuts';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
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
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

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
        {shortcut.overridden ? <span className="tm-prefs-key__custom"> · custom</span> : null}
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
            aria-label={`Press the new shortcut for ${shortcut.title}`}
            value={draft}
            placeholder="Press a key combination…"
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
              Save
            </button>
            <button
              type="button"
              className="tm-prefs-capsule"
              onClick={() => {
                setCapturing(null);
                setDraft('');
              }}
            >
              Cancel
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
              aria-label={`Reset ${shortcut.title} to ${shortcut.defaultChord}`}
              onClick={() => reset.mutate([shortcut.actionKey])}
            >
              Reset
            </button>
          ) : null}
          <button
            type="button"
            className={shortcut.overridden ? 'tm-prefs-kbd tm-prefs-kbd--custom' : 'tm-prefs-kbd'}
            aria-label={`Rebind ${shortcut.title}, now ${shortcut.chord}`}
            onClick={() => startCapture(shortcut.actionKey)}
          >
            <kbd>{showChord(shortcut.chord)}</kbd>
          </button>
        </>
      )}
    </li>
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow="Preferences · Keyboard"
      title="Keyboard"
      actions={
        <button
          type="button"
          className="tm-prefs-capsule"
          disabled={overridden.length === 0 || reset.isPending}
          onClick={() => reset.mutate(overridden)}
        >
          Reset to defaults
        </button>
      }
    >
      {shortcuts.isPending ? (
        <LoadingRegion label="Loading your keyboard shortcuts">
          <Skeleton />
        </LoadingRegion>
      ) : shortcuts.isError ? (
        <InlineAlert tone="danger" title="We could not load your keyboard shortcuts">
          {errorMessage(shortcuts.error)}
        </InlineAlert>
      ) : (
        <div className="tm-prefs tm-prefs--keyboard">
          <div className="tm-prefs__main">
            {rebind.isError ? (
              <InlineAlert tone="danger" title="We could not save that shortcut">
                {errorMessage(rebind.error)}
              </InlineAlert>
            ) : null}
            {reset.isError ? (
              <InlineAlert tone="danger" title="We could not reset that shortcut">
                {errorMessage(reset.error)}
              </InlineAlert>
            ) : null}
            {capturing && draft.length > 0 && !draftValid ? (
              <InlineAlert tone="warning" title="That combination cannot be used">
                Use zero or more modifiers (Ctrl, Alt, Shift, Meta) plus one key.
              </InlineAlert>
            ) : null}

            <div className="tm-prefs__pair">
              <section
                className="tm-prefs-card tm-prefs-card--tight"
                aria-labelledby="tm-keys-around"
              >
                <h2 id="tm-keys-around" className="tm-prefs-eyebrow">
                  Getting around
                </h2>
                <ul className="tm-prefs-keys">{around.map(renderRow)}</ul>
              </section>
              <section
                className="tm-prefs-card tm-prefs-card--tight"
                aria-labelledby="tm-keys-doing"
              >
                <h2 id="tm-keys-doing" className="tm-prefs-eyebrow">
                  Doing things
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
                Command bar{search ? ` · ${showChord(search.chord)}` : ''}
              </h2>
              <div className="tm-prefs-command" aria-hidden="true">
                Type a command<span className="tm-prefs-command__caret">|</span>
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
                Anything a client would see is never one keystroke away — those commands always ask
                first.
              </p>
            </section>
            <div className="tm-prefs-card tm-prefs-card--paper">
              <p className="tm-prefs-card__body">
                Rebind any shortcut by clicking its key. Arabic layout keeps the same letters.
              </p>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
