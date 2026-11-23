import type { Meta, StoryObj } from '@storybook/react-vite';

/**
 * The proof fixture of the layout check (ADR-0016, `vr/layout.spec.ts`), not a screen.
 *
 * It draws the app shell's real classes (rail, body, page header with its actions) and My Day's
 * text-only "do this next" capsule, so the check measures the real stylesheets
 * (`@tmanage/ui/styles.css` and `globals.css`, loaded by the preview). Two states:
 *
 * - `Fixed` — today's CSS.
 * - `BeforeFix` — today's CSS plus the exact declarations commit `7ce92a65` removed: the body's
 *   8px start padding beside the rail (`globals.css`, `.tm-app__body` `padding-inline: var(--s2)
 *   var(--s8)`) and the plain capsule's 12px start inset (`components.css`, `.tm-focus-capsule`
 *   `padding: var(--s3) 22px var(--s3) var(--s3)`, before the `--plain` rule existed). These are
 *   the two defects the owner reported on 2026-11-23; the spec fails if the check stops seeing
 *   them.
 *
 * Tagged `layout-fixture`, not `vr`: it is measured, never screenshotted.
 */
function ShellFixture({ beforeFix }: { readonly beforeFix: boolean }) {
  return (
    <>
      {beforeFix ? (
        <style>{`
          .tm-app__body { padding-inline: var(--s2) var(--s8); }
          .tm-focus-capsule.tm-focus-capsule--plain { padding: var(--s3) 22px var(--s3) var(--s3); }
        `}</style>
      ) : null}
      <div className="tm-app" data-layout-fixture={beforeFix ? 'before' : 'fixed'}>
        <div className="tm-app__frame">
          <nav className="tm-rail" aria-label="Main">
            <span className="tm-rail__brand" aria-hidden="true" />
          </nav>
          <div className="tm-app__body">
            <header className="tm-canvas-header">
              <div className="tm-canvas-header__titles">
                <p className="tm-canvas-header__context">
                  <span className="tm-canvas-header__org">Northstar Studio</span>
                </p>
                <div className="tm-canvas-header__title-row">
                  <h1 className="tm-canvas-header__title">My Day</h1>
                  <div className="tm-canvas-header__actions">
                    <button type="button" className="tm-button tm-button--lime tm-button--header">
                      New work
                    </button>
                    <button
                      type="button"
                      className="tm-button tm-button--outline tm-button--header"
                    >
                      Help
                    </button>
                  </div>
                </div>
              </div>
            </header>
            <div className="tm-app__columns">
              <main className="tm-canvas">
                <div
                  className="tm-focus-capsule tm-home-focus tm-focus-capsule--plain"
                  role="group"
                  aria-label="Do this next"
                >
                  <div className="tm-focus-capsule__text">
                    <p className="tm-focus-capsule__title">Nothing needs you now</p>
                    <p className="tm-focus-capsule__why">Your day is clear.</p>
                  </div>
                </div>
              </main>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const meta = {
  title: 'Checks/Layout invariants',
  component: ShellFixture,
  tags: ['layout-fixture', '!autodocs'],
  args: { beforeFix: false },
} satisfies Meta<typeof ShellFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fixed: Story = {};

export const BeforeFix: Story = { args: { beforeFix: true } };
