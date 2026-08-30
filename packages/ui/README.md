# `@tmanage/ui` — the Limeframe design system

UI-001 in `docs/planning/28-SPRINT-TICKETS-AND-ESTIMATES.md`: the token package, the
accessible primitives, and the component test harness.

```ts
import '@tmanage/ui/styles.css';
import { Button, Field, StateCapsule, ThemeProvider } from '@tmanage/ui';
```

## What is in here

| Path              | What it is                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/tokens/`     | The token values as typed constants, for anything that has to compute with them                                                |
| `src/styles/`     | `tokens.css` (custom properties), `base.css` (document + focus + skip link), `components.css`, and `limeframe.css` (all three) |
| `src/components/` | The primitives                                                                                                                 |
| `src/a11y/`       | WCAG contrast arithmetic, used by the tests and exported for screens                                                           |
| `tests/`          | The harness — component behaviour, axe, token drift, and palette contrast                                                      |

## The source of truth is not this package

Every value comes from the design export at
`docs/design/source/project/design/tokens/`, which is byte-identical to the planning
pack's design handoff and is **never edited**. `tests/tokens.drift.test.ts` reads that
export at test time and fails on any value that has stopped agreeing with it, in both
directions — nothing missing, nothing added that the export does not contain.

Three laws from the export are enforced rather than documented:

1. Text on `--lime-500` is always absolute ink. White on lime is 1.20:1 and prohibited.
2. Lime means current / next / live. Never success, never selection-of-many.
3. Every state that uses colour also carries a word and a shape — which is why
   `StateCapsule` and `StatusDot` require their label as a prop.

## Three things this package does deliberately

- **Plain class names, no CSS modules and no CSS-in-JS.** A consumer imports one
  stylesheet. Class names stay stable strings, so a test can assert them and a screen can
  override one without a build plugin.
- **Logical properties everywhere.** `padding-inline`, not `padding-left`. Arabic RTL is a
  first-class requirement, not a later pass.
- **Accessible names are required props, not optional ones.** `OrbButton` cannot be
  rendered without a `label`; `Field` cannot be rendered without a `label`; `StateCapsule`
  cannot be rendered without its word. A missing name is a type error rather than a defect
  found in an audit.

## The visual-regression harness

`pnpm test:vr` builds Storybook and screenshots every story in three variants — light,
dark, and RTL over light — comparing each against a committed PNG baseline in
`vr/stories.spec.ts-snapshots/`. The story list comes from the built `index.json`, so a
new story is in the harness on its next run without registration. High contrast is
deliberately absent: the 33 contrast cases compute what a screenshot could only eyeball.

The baselines are rendered on the machine the suite runs on — font rasterisation differs
across platforms, and the filenames keep Playwright's platform suffix to say so. After a
deliberate visual change, regenerate with `pnpm test:vr:update` and review the changed
PNGs in the diff like any other file; an unexpected diff leaves its actual/expected/diff
triple under `test-results/` for a human to look at. Like `test:e2e`, this suite needs a
real browser and stays **outside** the verification chain.

## What is not built yet

`Select`, `Combobox`, `Checkbox`, `Radio`, `Switch`, date and time fields, `Tooltip` and
`Toast` are in the design inventory as **specified** rather than **built**, and are not in
this package. Neither are the shell, Work Object DNA, planning, collaboration, delivery or
administration families — they are compositions, and they belong to the `WEB-*` tickets.

Self-hosted fonts are not packaged: the binaries exist in the design export, but there is
no application serving them yet, and the licence files have to travel with them. The
`--font-*` tokens name the families and fall back to `system-ui`.

The open items this package cannot close by itself — real NVDA and VoiceOver passes, a
native Arabic RTL screen-reader review, and 200% zoom — are recorded in
`docs/implementation-status.md`. jsdom has no layout and no paint, so no test here can
stand in for them.
