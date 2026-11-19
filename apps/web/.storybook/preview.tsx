import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Decorator, Preview } from '@storybook/react-vite';
import { ThemeProvider } from '@tmanage/ui';
import '@tmanage/ui/styles.css';
import '../src/app/globals.css';
import {
  SCREEN_VIEWPORTS,
  VR_VIEWPORT_DATASET_KEY,
  storyViewportSize,
  type ViewportParameter,
} from './vr-viewport';

/**
 * The preview for the application's screens.
 *
 * Its globals and their values are **deliberately identical** to `packages/ui/.storybook/preview.tsx`.
 * That harness drives its variants by URL (`?globals=theme:dark;direction:rtl`), and if a
 * visual-regression run is ever pointed at this Storybook the same variant strings have to mean
 * the same thing here. Diverging the names would silently produce a light shot labelled `dark`.
 *
 * Two decorators, and each replaces something `apps/web/src/app/layout.tsx` supplies in the
 * running application:
 *
 * 1. **`ThemeProvider`** stands in for the `data-theme` / `data-density` attributes the layout
 *    writes onto `<html>`. It writes them onto an element it owns instead, which is the whole
 *    reason that component exists, so the screens see exactly the attributes they see in the app.
 * 2. **`QueryClientProvider`** stands in for `QueryProvider`. Retries are off: a story is not
 *    waiting for a flaky network, and a screen whose stubbed request refuses should show its
 *    refusal immediately rather than after two backoffs.
 *
 * `AuthBoundaryProvider` is **not** here, and must not be. It calls `useRouter()` from
 * `next/navigation`, which needs a Next.js router that no story has; the screens reach the
 * boundary through the `authBoundary` module singleton, which announces to nobody when the
 * provider is absent. That is the correct behaviour for a screen rendered in isolation.
 *
 * The Manrope face is not loaded. `next/font/local` runs in the Next build, not in Vite, so
 * `--font-manrope` is undefined here and `globals.css` falls back to `--font-latin`. Text metrics
 * therefore differ slightly from the running application — recorded here rather than papered over,
 * because it is the one thing a person comparing a story against a browser tab will notice.
 */
const withTheme: Decorator = (Story, context) => {
  const { theme, contrast, density, direction } = context.globals;

  return (
    <ThemeProvider
      theme={theme === 'dark' ? 'dark' : 'light'}
      contrast={contrast === 'high' ? 'high' : 'normal'}
      density={density === 'editorial' || density === 'operational' ? density : 'balanced'}
      dir={direction === 'rtl' ? 'rtl' : 'ltr'}
      lang={direction === 'rtl' ? 'ar' : 'en'}
    >
      {/* The stand-in for `<body>`: the themed ground a screen with no surface of its own sits on,
          so a dark story is never light text on the light page behind the subtree. */}
      <div style={{ background: 'var(--paper-150)' }}>
        <Story />
      </div>
    </ThemeProvider>
  );
};

const withQuery: Decorator = (Story) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return (
    <QueryClientProvider client={client}>
      <Story />
    </QueryClientProvider>
  );
};

/**
 * T5 D9: marks the document with the size the story's own `viewport` global names (see
 * `vr-viewport.ts`), before the story renders, so the VR harness can set the page to it before the
 * shot. A story without one clears the mark, so a previous story's size never carries over.
 */
const withVrViewport: Decorator = (Story, context) => {
  const size = storyViewportSize(
    context.globals['viewport'],
    (context.parameters['viewport'] as ViewportParameter | undefined)?.options,
  );
  const dataset = document.documentElement.dataset;
  if (size === undefined) delete dataset[VR_VIEWPORT_DATASET_KEY];
  else dataset[VR_VIEWPORT_DATASET_KEY] = `${String(size.width)}x${String(size.height)}`;
  return <Story />;
};

const preview: Preview = {
  // Order is not load-bearing: no decorator reads another's context, so whichever Storybook
  // nests outermost, the screen underneath sees them all.
  decorators: [withTheme, withQuery, withVrViewport],
  initialGlobals: {
    theme: 'light',
    contrast: 'normal',
    density: 'balanced',
    direction: 'ltr',
  },
  globalTypes: {
    theme: {
      description: 'Light or the deliberate dark inversion',
      toolbar: {
        title: 'Theme',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
      },
    },
    contrast: {
      description: 'High contrast promotes quiet lines and muted text',
      toolbar: {
        title: 'Contrast',
        items: [
          { value: 'normal', title: 'Normal' },
          { value: 'high', title: 'High' },
        ],
      },
    },
    density: {
      description: 'Editorial, balanced, operational',
      toolbar: {
        title: 'Density',
        items: [
          { value: 'editorial', title: 'Editorial' },
          { value: 'balanced', title: 'Balanced' },
          { value: 'operational', title: 'Operational' },
        ],
      },
    },
    direction: {
      description: 'English LTR or Arabic RTL',
      toolbar: {
        title: 'Direction',
        items: [
          { value: 'ltr', title: 'LTR' },
          { value: 'rtl', title: 'RTL' },
        ],
      },
    },
  },
  parameters: {
    // A screen is a whole page, not a component on a card.
    layout: 'fullscreen',
    controls: { expanded: true },
    // The toolbar's sizes plus the design's phone frame; a story picks one with
    // `globals: { viewport: { value: 'phone' } }`, and the VR harness honours it (T5 D9).
    viewport: { options: SCREEN_VIEWPORTS },
  },
};

export default preview;
