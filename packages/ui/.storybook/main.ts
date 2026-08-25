import type { StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook is the design system's shop window, and UI-001 names it directly.
 *
 * It is deliberately thin: no addon that rewrites the component, no docs generation that
 * would become a second source of truth beside `docs/design/source/`. The stories exist so
 * a person can look at every primitive in every theme, which is the one thing the test
 * harness cannot do — jsdom has no paint.
 */
const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.tsx'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
};

export default config;
