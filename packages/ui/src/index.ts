/**
 * `@tmanage/ui` — the Limeframe design system (UI-001).
 *
 * The stylesheet is a separate entry point and is not imported here, because a package
 * that imports CSS from its JavaScript can only be consumed by a bundler that has been
 * taught to handle it:
 *
 *   import '@tmanage/ui/styles.css';
 *   import { Button } from '@tmanage/ui';
 */
export * from './components/index.js';
export * from './tokens/index.js';
export * from './a11y/index.js';
