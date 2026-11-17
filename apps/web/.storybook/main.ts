import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook for the application screens.
 *
 * `packages/ui` already runs Storybook 10 on `@storybook/react-vite`, so this is the same
 * tool at the same version rather than a second way of doing it. Three things differ, and
 * each difference is forced by the fact that these are screens rather than primitives:
 *
 * 1. **`@storybook/react-vite`, not `@storybook/nextjs-vite`.** Nothing in `stories/`
 *    renders a route, a layout, or a server component — every screen in
 *    `src/components/screens/` is a `'use client'` component that takes its data through
 *    props and its transport through an injected `ApiClient`. The only Next.js module they
 *    import is `next/link`, which is an ordinary React component under any bundler. Pulling
 *    in the Next framework preset would add a dependency this repository does not otherwise
 *    have in order to emulate a router that no story asks for.
 * 2. **The `@` alias is restated here.** `tsconfig.json` and `vitest.config.ts` both define
 *    it and neither is read by the Storybook builder. The three must agree.
 * 3. **No docs addon and no autodocs**, for the reason `packages/ui/.storybook/main.ts`
 *    gives: generated documentation becomes a second source of truth beside
 *    `docs/design/source/` and `docs/planning/`.
 *
 * A fourth difference is forced by the bundler rather than by the screens: `node:crypto` is
 * aliased to a browser file. `@tmanage/domain`'s barrel reaches two modules that import it,
 * and Rollup rejects a named import from Vite's browser-external stub before tree-shaking can
 * remove them. `node-crypto-browser.ts` states exactly what it replaces and what it refuses.
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
  viteFinal: (viteConfig) => ({
    ...viteConfig,
    /*
     * `NEXT_PUBLIC_API_BASE_URL`, baked into the preview build.
     *
     * A story that mounts `AppShell` reaches the always-mounted `MaintenanceBanner` (and its
     * siblings), which build the process-wide browser client at render; `resolveApiBaseUrl` reads
     * `process.env.NEXT_PUBLIC_API_BASE_URL` and throws in a *production* Storybook (`storybook
     * build` sets `NODE_ENV=production`) when it is absent, so the whole screen fails to render.
     * The builder otherwise inlines `process.env` to `{}`, so the value is supplied here as a
     * `define`. Choosing the same-origin topology lets the client construct; no request leaves the
     * page because those screens' stories stub `fetch` (see `stories/support/vr-fixtures.tsx`). It
     * is inert for every pre-existing story — they inject a refusing client and never build the
     * browser one — and `next build` never reads `.storybook`.
     */
    define: {
      ...viteConfig.define,
      'process.env.NEXT_PUBLIC_API_BASE_URL': JSON.stringify('same-origin'),
    },
    resolve: {
      ...viteConfig.resolve,
      alias: {
        ...viteConfig.resolve?.alias,
        '@': fileURLToPath(new URL('../src', import.meta.url)),
        'node:crypto': fileURLToPath(new URL('./node-crypto-browser.ts', import.meta.url)),
        // Stories render every language synchronously, as vitest does (all catalogs preloaded).
        '#i18n-catalogs': fileURLToPath(
          new URL('../src/lib/i18n/catalogs-all.ts', import.meta.url),
        ),
      },
    },
    /*
     * The automatic JSX runtime, stated rather than inherited.
     *
     * `tsconfig.json` sets `jsx: "preserve"` because Next's SWC pipeline does the transform,
     * and esbuild reads that file. `preserve` is not one of esbuild's options, so it falls
     * back to the *classic* runtime and emits `React.createElement` into modules that never
     * import `React` — the build succeeds and every story then fails at render with
     * `ReferenceError: React is not defined`. `packages/ui` does not hit this: its tsconfig
     * says `react-jsx`, and it can, because nothing compiles it with SWC.
     *
     * This is the one line that stops a green build from producing a Storybook where nothing
     * renders, so it is stated here instead of being left to inference.
     */
    esbuild: {
      ...viteConfig.esbuild,
      jsx: 'automatic',
      jsxImportSource: 'react',
    },
  }),
};

export default config;
