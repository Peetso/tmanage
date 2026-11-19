import { MINIMAL_VIEWPORTS } from 'storybook/viewport';

/**
 * T5 D9: the screen viewports, and the size a story's own viewport names for the VR harness.
 *
 * Storybook 10's convention is a story-level global, `globals: { viewport: { value: 'phone' } }`,
 * resolved against `parameters.viewport.options`. The Storybook UI resizes its iframe from it, but
 * the VR harness loads `iframe.html` directly at a fixed 1024 × 768, so a "Phone" story was shot
 * at desktop width. `withVrViewport` (preview.tsx) resolves the story's global with
 * {@link storyViewportSize} and marks the document; `vr/stories.spec.ts` reads the mark and sets
 * the page to that size before the shot. A story with no viewport global keeps the harness size.
 */

/** The phone frame of the designs (FIGMA-D phone frames are 390 wide). */
export const PHONE_VIEWPORT = 'phone';

export const SCREEN_VIEWPORTS = {
  ...MINIMAL_VIEWPORTS,
  [PHONE_VIEWPORT]: {
    name: 'Phone (390 × 844)',
    styles: { width: '390px', height: '844px' },
    type: 'mobile',
  },
} as const;

/** `document.documentElement.dataset` key the harness reads: `"<width>x<height>"`. */
export const VR_VIEWPORT_DATASET_KEY = 'vrViewport';

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ViewportOption {
  readonly styles: { readonly width: string; readonly height: string };
}

export type ViewportOptions = Readonly<Record<string, ViewportOption>>;

/** The `viewport` parameter as far as {@link storyViewportSize} reads it. */
export interface ViewportParameter {
  readonly options?: ViewportOptions;
}

const PIXELS = /^(\d+)px$/u;

/**
 * The pixel size the `viewport` global names among `options`, or `undefined` when the story names
 * none, names an unknown option, or one not sized in whole pixels (`100%`): the harness then keeps
 * its own size. A rotated viewport swaps the two sides, as the Storybook toolbar does.
 */
export function storyViewportSize(
  viewport: unknown,
  options: ViewportOptions | undefined,
): ViewportSize | undefined {
  const state =
    typeof viewport === 'string'
      ? { value: viewport, isRotated: false }
      : typeof viewport === 'object' && viewport !== null
        ? (viewport as { value?: unknown; isRotated?: unknown })
        : undefined;
  if (typeof state?.value !== 'string' || options === undefined) return undefined;
  const option = Object.hasOwn(options, state.value) ? options[state.value] : undefined;
  const width = PIXELS.exec(option?.styles.width ?? '')?.[1];
  const height = PIXELS.exec(option?.styles.height ?? '')?.[1];
  if (width === undefined || height === undefined) return undefined;
  const size = { width: Number(width), height: Number(height) };
  return state.isRotated === true ? { width: size.height, height: size.width } : size;
}
