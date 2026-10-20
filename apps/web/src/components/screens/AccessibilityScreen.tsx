'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
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
import { useT } from '../../lib/i18n/use-t';
import { PreferenceToggle } from './PreferencesScreen';
import '../../styles/screens/preferences.css';

export interface AccessibilityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The default an unsaved account reads by; the same values the API's `DEFAULT_A11Y_PREFERENCES` holds. */
const DEFAULTS: A11yPreferencesView = { fontScale: 'md', reduceMotion: false, highContrast: false };

/** The root font size each step sets (globals.css `data-tm-font-scale`), as the read-out shows it. */
const FONT_SCALE_PERCENT: Record<A11yFontScale, string> = {
  sm: '94%',
  md: '100%',
  lg: '113%',
  xl: '125%',
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
  const t = useT();

  const fontScaleLabels: Record<A11yFontScale, string> = {
    sm: t('AccessibilityScreen.fontScaleSmall'),
    md: t('AccessibilityScreen.fontScaleMedium'),
    lg: t('AccessibilityScreen.fontScaleLarge'),
    xl: t('AccessibilityScreen.fontScaleExtraLarge'),
  };

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
      eyebrow={t('AccessibilityScreen.eyebrow')}
      title={t('AccessibilityScreen.title')}
    >
      {preferences.isPending ? (
        <LoadingRegion label={t('AccessibilityScreen.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : preferences.isError ? (
        <InlineAlert tone="danger" title={t('AccessibilityScreen.loadError')}>
          {errorMessage(preferences.error)}
        </InlineAlert>
      ) : (
        <div className="tm-prefs tm-prefs--a11y">
          <div className="tm-prefs__main">
            <form
              className="tm-prefs-card"
              aria-labelledby="tm-a11y-heading"
              onSubmit={(event) => {
                event.preventDefault();
                setSaved(false);
                save.mutate();
              }}
            >
              <h2 id="tm-a11y-heading" className="tm-visually-hidden">
                {t('AccessibilityScreen.displayHeading')}
              </h2>

              <fieldset className="tm-prefs-section">
                <legend className="tm-prefs-eyebrow">{t('AccessibilityScreen.textSize')}</legend>
                <div className="tm-prefs-scale">
                  <span className="tm-prefs-scale__a" aria-hidden="true">
                    A
                  </span>
                  <div className="tm-prefs-scale__track">
                    {A11Y_FONT_SCALES.map((scale) => (
                      <label className="tm-prefs-scale__step" key={scale}>
                        <input
                          id={`tm-a11y-font-${scale}`}
                          type="radio"
                          name="tm-a11y-font-scale"
                          value={scale}
                          checked={fontScale === scale}
                          onChange={() => setFontScale(scale)}
                        />
                        {fontScaleLabels[scale]}
                      </label>
                    ))}
                  </div>
                  <span className="tm-prefs-scale__a tm-prefs-scale__a--big" aria-hidden="true">
                    A
                  </span>
                  <span className="tm-prefs-scale__value">{FONT_SCALE_PERCENT[fontScale]}</span>
                </div>
              </fieldset>

              <hr className="tm-prefs-rule" />

              <PreferenceToggle
                label={t('AccessibilityScreen.highContrastLabel')}
                hint={t('AccessibilityScreen.highContrastHint')}
                checked={highContrast}
                onChange={(event) => setHighContrast(event.target.checked)}
              />
              <PreferenceToggle
                label={t('AccessibilityScreen.reduceMotionLabel')}
                hint={t('AccessibilityScreen.reduceMotionHint')}
                checked={reduceMotion}
                onChange={(event) => setReduceMotion(event.target.checked)}
              />

              {save.isError ? (
                <InlineAlert tone="danger" title={t('AccessibilityScreen.saveError')}>
                  {errorMessage(save.error)}
                </InlineAlert>
              ) : null}

              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title={t('AccessibilityScreen.savedTitle')}>
                  {t('AccessibilityScreen.savedBody')}
                </InlineAlert>
              ) : null}

              <div>
                <button
                  type="submit"
                  className="tm-prefs-capsule tm-prefs-capsule--ink"
                  disabled={save.isPending}
                >
                  {save.isPending ? t('AccessibilityScreen.saving') : t('AccessibilityScreen.save')}
                </button>
              </div>
            </form>
          </div>

          <aside className="tm-prefs__side" aria-labelledby="tm-a11y-sample-heading">
            <h2 id="tm-a11y-sample-heading" className="tm-prefs-eyebrow">
              {t('AccessibilityScreen.sampleHeading')}
            </h2>
            <div className="tm-prefs-card tm-prefs-card--grow" aria-hidden="true">
              <div className="tm-prefs-pills">
                <span className="tm-prefs-pill">{t('AccessibilityScreen.sampleCurrent')}</span>
                <span className="tm-prefs-pill tm-prefs-pill--warn">
                  {t('AccessibilityScreen.sampleAtRisk')}
                </span>
              </div>
              <p className="tm-prefs-line">
                <span className="tm-prefs-line__mark" />
                {t('AccessibilityScreen.sampleClientVisible')}
              </p>
              <p className="tm-prefs-line">
                <span className="tm-prefs-line__bang">!</span>
                {t('AccessibilityScreen.sampleClientAction')}
              </p>
              <hr className="tm-prefs-rule" />
              <span className="tm-prefs-focused">{t('AccessibilityScreen.sampleFocused')}</span>
              <p className="tm-prefs-card__body">
                {t('AccessibilityScreen.sampleBodyPrefix')} {FONT_SCALE_PERCENT[fontScale]}.{' '}
                {t('AccessibilityScreen.sampleBodyRest')}
              </p>
            </div>
          </aside>
        </div>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
