import type { Meta, StoryObj } from '@storybook/react-vite';
import { RecoveryScreen } from '../src/components/screens/RecoveryScreen';

/**
 * **ID-05 Recovery** — and the reason this Storybook exists at all.
 *
 * The 2026-09-05 review's remedy for D15 was "move presentation-only states into
 * stories/development fixtures". It could not be carried out: `apps/web` had no stories, so the
 * D15 slice took the other reading — `tests/screens.test.tsx` as the fixture home — and recorded
 * that standing Storybook up remained open. These four stories are that remaining half.
 *
 * All four states are here on purpose. `41` line 36 approves all four for ID-05, and
 * `/recover` can reach exactly one of them: `recover/page.tsx` passes no `state`, because a
 * query parameter is not a result. `sent` and `completed` assert outcomes — an email went out,
 * other sessions ended, an audit row was written — and are therefore reachable only from a
 * caller holding a real result, of which there is none until ID-002 lands. A story is such a
 * caller in the only harmless sense: it renders the design for review and claims nothing about
 * the running system, which is exactly what the review asked for.
 *
 * Note what each state carries. `sent` and `completed` show the `BackendPending` notice that
 * denies their own claim; `expired` does not, and the component's own comment says why it was
 * left alone. Seeing those three side by side is the point of putting them here.
 */
const meta = {
  title: 'Identity/ID-05 Recovery',
  component: RecoveryScreen,
} satisfies Meta<typeof RecoveryScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The only state `/recover` can render. The form is `disabled` and submits nowhere — ID-002
 * owns the operation that would make it work.
 */
export const Request: Story = { args: { state: 'request' } };

/**
 * The enumeration-safe wording required by `26-THREAT-MODELS`: the response is identical
 * whether or not the address is known, and the copy says so rather than implying a lookup.
 */
export const Sent: Story = { args: { state: 'sent' } };

/** Refuses to extend the link, and gives the one-sentence reason in the screen itself. */
export const Expired: Story = { args: { state: 'expired' } };

/** The state that claims the most, and carries the notice denying all three claims. */
export const Completed: Story = { args: { state: 'completed' } };
