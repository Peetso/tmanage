import type { ReactNode } from 'react';
import type { Contrast, Density, Theme } from '../tokens/tokens.js';

export interface ThemeProviderProps {
  children: ReactNode;
  /** Light is the default composition; dark is a deliberate inversion, not a filter. */
  theme?: Theme;
  contrast?: Contrast;
  /**
   * `40-DESIGN-SYSTEM` §9. Editorial is screen-defined; the user may choose balanced or
   * operational on desktop, which is why this is a prop and not a constant.
   */
  density?: Density;
  /** `rtl` for Arabic. Set here so every logical property in the CSS resolves correctly. */
  dir?: 'ltr' | 'rtl';
  lang?: string;
  className?: string;
}

/**
 * Applies the theme, contrast, density and writing direction to a subtree.
 *
 * It writes data attributes onto an element it owns rather than onto `document`. Two
 * reasons: a client-portal preview has to render the client's theme inside the internal
 * app without changing it, and a component test needs to mount a theme without mutating
 * global state that the next test then inherits.
 */
export function ThemeProvider({
  children,
  theme = 'light',
  contrast = 'normal',
  density = 'balanced',
  dir = 'ltr',
  lang = 'en',
  className,
}: ThemeProviderProps) {
  return (
    <div
      className={className}
      data-theme={theme}
      data-contrast={contrast}
      data-density={density}
      dir={dir}
      lang={lang}
    >
      {children}
    </div>
  );
}
