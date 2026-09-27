'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  A11Y_FONT_SCALES,
  getAccessibilityPreferences,
  updateAccessibilityPreferences,
} from '../../lib/api/a11y-preferences';
import type { A11yFontScale, A11yPreferencesView } from '../../lib/api/a11y-preferences';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AccessibilityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The default an unsaved account reads by; the same values the API's `DEFAULT_A11Y_PREFERENCES` holds. */
const DEFAULTS: A11yPreferencesView = { fontScale: 'md', reduceMotion: false, highContrast: false };

const FONT_SCALE_LABELS: Record<A11yFontScale, string> = {
  sm: 'Small',
  md: 'Medium',
  lg: 'Large',
  xl: 'Extra large',
};

/** True when the operating system asks for reduced motion, so the shell honours it even when unset. */
function systemPrefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Apply the accessibility preferences to the app shell by writing data attributes onto the document
 * root. The CSS rules keyed off these attributes are additive and guarded (globals.css), so the
 * default state — no attribute — changes nothing and every existing a11y baseline is untouched.
 * Reduced motion is the OR of the saved setting and the OS `prefers-reduced-motion`, so the shell
 * respects the system even before a member opts in.
 */
function applyToShell(settings: A11yPreferencesView): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-tm-font-scale', settings.fontScale);
  root.setAttribute(
    'data-tm-reduce-motion',
    settings.reduceMotion || systemPrefersReducedMotion() ? 'on' : 'off',
  );
  root.setAttribute('data-tm-high-contrast', settings.highContrast ? 'on' : 'off');
}

/**
 * **Accessibility preferences (module 20 Preferences & accessibility, A11Y, x183).**
 *
 * `38-MODULE-MAP` §Preferences & accessibility ("font size / reduced motion / high contrast"). The
 * audit found the a11y baselines present but the user-facing controls absent; this is the screen that
 * adds them. A member reads their own settings (defaults when never saved), toggles font size,
 * reduced motion and high contrast, and saves — the settings apply to the app shell immediately and
 * persist behind `work.read`, scoped to the caller's own membership by the server.
 */
export function AccessibilityScreen({
  organizationSlug,
  organizationName,
  client,
}: AccessibilityScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const preferences = useQuery({
    queryKey: ['a11y-preferences', organizationSlug],
    queryFn: () => getAccessibilityPreferences(api, organizationSlug),
  });

  const [fontScale, setFontScale] = useState<A11yFontScale>(DEFAULTS.fontScale);
  const [reduceMotion, setReduceMotion] = useState(DEFAULTS.reduceMotion);
  const [highContrast, setHighContrast] = useState(DEFAULTS.highContrast);
  const [saved, setSaved] = useState(false);

  // When the server's settings load (or change), seed the form and apply them to the shell.
  useEffect(() => {
    if (!preferences.data) return;
    setFontScale(preferences.data.fontScale);
    setReduceMotion(preferences.data.reduceMotion);
    setHighContrast(preferences.data.highContrast);
    applyToShell(preferences.data);
  }, [preferences.data]);

  const save = useMutation({
    mutationFn: (): Promise<A11yPreferencesView> =>
      updateAccessibilityPreferences(api, organizationSlug, {
        fontScale,
        reduceMotion,
        highContrast,
      }),
    onSuccess: (result) => {
      queries.setQueryData(['a11y-preferences', organizationSlug], result);
      applyToShell(result);
      setSaved(true);
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Accessibility"
      description="Font size, reduced motion and high contrast — applied to the app and saved to your account."
    >
      {preferences.isPending ? (
        <LoadingRegion label="Loading your accessibility preferences">
          <Skeleton />
        </LoadingRegion>
      ) : preferences.isError ? (
        <InlineAlert tone="danger" title="We could not load your accessibility preferences">
          {errorMessage(preferences.error)}
        </InlineAlert>
      ) : (
        <form
          className="tm-panel tm-stack"
          aria-labelledby="tm-a11y-heading"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <h2 id="tm-a11y-heading" className="tm-eyebrow">
            Display preferences
          </h2>

          <fieldset className="tm-fieldset tm-stack">
            <legend className="tm-field__label">Font size</legend>
            {A11Y_FONT_SCALES.map((scale) => (
              <div className="tm-field tm-field--inline" key={scale}>
                <input
                  id={`tm-a11y-font-${scale}`}
                  className="tm-field__control"
                  type="radio"
                  name="tm-a11y-font-scale"
                  value={scale}
                  checked={fontScale === scale}
                  onChange={() => setFontScale(scale)}
                />
                <label className="tm-field__label" htmlFor={`tm-a11y-font-${scale}`}>
                  {FONT_SCALE_LABELS[scale]}
                </label>
              </div>
            ))}
          </fieldset>

          <div className="tm-field tm-field--inline">
            <input
              id="tm-a11y-reduce-motion"
              className="tm-field__control"
              type="checkbox"
              checked={reduceMotion}
              onChange={(event) => setReduceMotion(event.target.checked)}
            />
            <label className="tm-field__label" htmlFor="tm-a11y-reduce-motion">
              Reduce motion
            </label>
          </div>

          <div className="tm-field tm-field--inline">
            <input
              id="tm-a11y-high-contrast"
              className="tm-field__control"
              type="checkbox"
              checked={highContrast}
              onChange={(event) => setHighContrast(event.target.checked)}
            />
            <label className="tm-field__label" htmlFor="tm-a11y-high-contrast">
              High contrast
            </label>
          </div>

          {save.isError ? (
            <InlineAlert tone="danger" title="We could not save your preferences">
              {errorMessage(save.error)}
            </InlineAlert>
          ) : null}

          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title="Saved">
              Your accessibility preferences have been saved.
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save preferences'}
            </Button>
          </div>
        </form>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
