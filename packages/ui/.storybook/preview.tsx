import type { Decorator, Preview } from '@storybook/react-vite';
import { ThemeProvider } from '../src/components/ThemeProvider.js';
import '../src/styles/limeframe.css';

/**
 * Theme, contrast, density and direction are toolbar controls rather than separate
 * stories. The state matrix requires light, dark, high contrast, RTL and reduced motion
 * for *every* component, and duplicating each story five times would guarantee that four
 * of the copies drift.
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
      <div style={{ background: 'var(--paper-150)', padding: 'var(--s8)', minHeight: '100vh' }}>
        <Story />
      </div>
    </ThemeProvider>
  );
};

const preview: Preview = {
  decorators: [withTheme],
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
    layout: 'fullscreen',
    controls: { expanded: true },
  },
};

export default preview;
