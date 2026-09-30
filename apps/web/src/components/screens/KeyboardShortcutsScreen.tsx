'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getShortcutMap,
  isValidChord,
  rebindShortcut,
  resetShortcut,
} from '../../lib/api/keyboard-shortcuts';
import type { ResolvedShortcutView, ShortcutMapView } from '../../lib/api/keyboard-shortcuts';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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

/**
 * **Keyboard shortcuts (module 20 Preferences & accessibility, PRF keyboard, x286).**
 *
 * `42-INTERACTION` §keyboard, `22-SCREEN` PRF. The app ships a fixed keyboard-shortcut map for the
 * command-palette actions; this screen lets a member rebind an action to a chord or reset it to the
 * default. A member reads their resolved map (defaults overlaid with their overrides), captures a new
 * chord for an action, saves it, or resets it — persisted behind `work.read`, scoped to the caller's
 * own membership by the server. The capture control validates the chord shape before enabling save.
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
    mutationFn: (actionKey: string) => resetShortcut(api, organizationSlug, actionKey),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['keyboard-shortcuts', organizationSlug] });
    },
  });

  const startCapture = (actionKey: string) => {
    setCapturing(actionKey);
    setDraft('');
  };

  const draftValid = draft.length > 0 && isValidChord(draft);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Keyboard shortcuts"
      description="Rebind a command-palette action to a chord, or reset it to the default."
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
        <section className="tm-panel tm-stack" aria-labelledby="tm-shortcuts-heading">
          <h2 id="tm-shortcuts-heading" className="tm-eyebrow">
            Command-palette shortcuts
          </h2>

          {rebind.isError ? (
            <InlineAlert tone="danger" title="We could not save that shortcut">
              {errorMessage(rebind.error)}
            </InlineAlert>
          ) : null}

          <table className="tm-table">
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Shortcut</th>
                <th scope="col">Default</th>
                <th scope="col">
                  <span className="tm-visually-hidden">Controls</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows(shortcuts.data).map((shortcut) => (
                <tr key={shortcut.actionKey}>
                  <th scope="row">{shortcut.title}</th>
                  <td>
                    {capturing === shortcut.actionKey ? (
                      <input
                        // Focus on mount via a ref callback rather than the `autoFocus` prop, which
                        // jsx-a11y forbids: capture needs the field focused so the next keypress lands.
                        ref={(element) => {
                          element?.focus();
                        }}
                        className="tm-field__control"
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
                    ) : (
                      <>
                        <kbd className="tm-mono">{shortcut.chord}</kbd>
                        {shortcut.overridden ? <span className="tm-mono"> · custom</span> : null}
                      </>
                    )}
                  </td>
                  <td>
                    <kbd className="tm-mono">{shortcut.defaultChord}</kbd>
                  </td>
                  <td>
                    <div className="tm-row tm-row--wrap">
                      {capturing === shortcut.actionKey ? (
                        <>
                          <Button
                            type="button"
                            disabled={!draftValid || rebind.isPending}
                            onClick={() =>
                              rebind.mutate({ actionKey: shortcut.actionKey, chord: draft })
                            }
                          >
                            Save
                          </Button>
                          <Button
                            type="button"
                            tone="outline"
                            onClick={() => {
                              setCapturing(null);
                              setDraft('');
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            type="button"
                            tone="outline"
                            onClick={() => startCapture(shortcut.actionKey)}
                          >
                            Rebind
                          </Button>
                          <Button
                            type="button"
                            tone="outline"
                            disabled={!shortcut.overridden || reset.isPending}
                            onClick={() => reset.mutate(shortcut.actionKey)}
                          >
                            Reset
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {capturing && draft.length > 0 && !draftValid ? (
            <InlineAlert tone="warning" title="That combination cannot be used">
              Use zero or more modifiers (Ctrl, Alt, Shift, Meta) plus one key.
            </InlineAlert>
          ) : null}
        </section>
      )}
    </AppShell>
  );
}

function rows(data: ShortcutMapView): readonly ResolvedShortcutView[] {
  return data.shortcuts;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
