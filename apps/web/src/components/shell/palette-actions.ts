import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import {
  getDisplayPreferences,
  toDisplayPreferencesUpdate,
  updateDisplayPreferences,
} from '../../lib/api/display-preferences';
import { createDocument } from '../../lib/api/documents';
import { listProjects } from '../../lib/api/projects';
import { startTimer } from '../../lib/api/time-timer';
import type { DisplayLocale } from '../../lib/api/display-preferences';
import { localeDirection } from '../../lib/i18n/direction';
import { activeLocale } from '../../lib/i18n/locale-store';
import { applyTheme } from '../../lib/theme';
import { timerKey } from '../time/use-running-timer';
import type { PaletteAction } from './command-palette-model';

/**
 * The palette's and the "+ New" menu's actions (rows 55-06 / 55-05). Dispatched through a closed
 * `switch` over {@link PaletteAction}: nothing typed into the palette ever reaches here.
 */
export interface PaletteActionContext {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly queryClient: QueryClient | undefined;
  readonly navigate: (path: string) => void;
  /** The current UI language, for the language toggle. */
  readonly locale: string;
  /** Labels for the things an action creates. */
  readonly untitledDoc: string;
}

/** What happened: `done`, or a failure the caller reports (the palette stays open on one). */
export type PaletteActionOutcome = 'done' | 'no-project' | 'failed';

/** Arabic and Urdu read right to left; the toggle flips between the reader's RTL language and English. */
export function nextLocale(current: string): DisplayLocale {
  return localeDirection(current) === 'rtl' ? 'en-US' : 'ar-EG';
}

/** The theme now on `<html data-theme>`, and the one the toggle switches to. */
export function nextTheme(current: string | undefined): 'light' | 'dark' {
  return current === 'dark' ? 'light' : 'dark';
}

/** Saves a display-preference change; best-effort, the in-tab change already happened. */
async function savePreference(
  context: PaletteActionContext,
  change: { theme?: 'light' | 'dark'; locale?: DisplayLocale },
): Promise<void> {
  const { api, organizationSlug, queryClient } = context;
  try {
    const current = await getDisplayPreferences(api, organizationSlug);
    const saved = await updateDisplayPreferences(
      api,
      organizationSlug,
      toDisplayPreferencesUpdate({ ...current, ...change }),
    );
    queryClient?.setQueryData(['display-preferences', organizationSlug], saved);
  } catch {
    // A failed save only means the next load keeps the old preference.
  }
}

export async function runPaletteAction(
  action: PaletteAction,
  context: PaletteActionContext,
): Promise<PaletteActionOutcome> {
  const { api, organizationSlug, navigate } = context;
  const base = `/${encodeURIComponent(organizationSlug)}`;
  switch (action) {
    case 'create-doc': {
      try {
        const projects = await listProjects(api, organizationSlug);
        const projectId = projects[0]?.id;
        if (!projectId) return 'no-project';
        const document = await createDocument(api, organizationSlug, {
          projectId,
          title: context.untitledDoc,
        });
        navigate(`${base}/docs/${encodeURIComponent(document.id)}/edit`);
        return 'done';
      } catch {
        return 'failed';
      }
    }
    case 'start-timer': {
      try {
        await startTimer(api, organizationSlug, {});
      } catch {
        // One timer per person: a running one answers 409 and stays — the pill already shows it.
      }
      await context.queryClient?.invalidateQueries({ queryKey: timerKey(organizationSlug) });
      return 'done';
    }
    case 'toggle-theme': {
      const theme = nextTheme(
        typeof document === 'undefined' ? undefined : document.documentElement.dataset['theme'],
      );
      applyTheme(theme);
      void savePreference(context, { theme });
      return 'done';
    }
    case 'toggle-language': {
      const locale = nextLocale(context.locale);
      activeLocale.set(locale);
      void savePreference(context, { locale });
      return 'done';
    }
    case 'search-workspace':
      // Needs the typed query; the palette handles it before calling here.
      return 'done';
    default:
      return 'failed';
  }
}
