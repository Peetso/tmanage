import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/components/Button.js';
import { OrbButton } from '../src/components/OrbButton.js';
import { SplitCapsuleButton } from '../src/components/SplitCapsuleButton.js';

const meta = {
  title: '02 Primitives/Buttons',
  component: Button,
  args: { children: 'Post update' },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ink: Story = { args: { tone: 'ink' } };

/**
 * Lime is reserved. The semantic law is "current, next, live" — not "primary", and never
 * "success". A lime button is the *next* thing to do, not merely the important one.
 */
export const Lime: Story = { args: { tone: 'lime', children: 'Start the next step' } };

export const Outline: Story = { args: { tone: 'outline' } };
export const Text: Story = { args: { tone: 'text' } };
export const Destructive: Story = { args: { tone: 'destructive', children: 'Delete project' } };

export const Sizes: Story = {
  render: (args) => (
    <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
      <Button {...args} size="compact">
        Compact 36
      </Button>
      <Button {...args} size="default">
        Default 40
      </Button>
      <Button {...args} size="accessible">
        Accessible 44
      </Button>
      <Button {...args} size="feature">
        Feature 48
      </Button>
    </div>
  ),
};

export const States: Story = {
  render: (args) => (
    <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
      <Button {...args}>Default</Button>
      <Button {...args} disabled>
        Disabled
      </Button>
      <Button {...args} loading loadingLabel="Publishing the version">
        Loading
      </Button>
      <Button {...args} tone="outline" aria-pressed="true">
        Pressed
      </Button>
      <Button {...args} tone="outline" aria-pressed="false">
        Not pressed
      </Button>
    </div>
  ),
};

export const Orbs: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
      <OrbButton label="Compact action" icon="+" size="compact" tone="outline" />
      <OrbButton label="Default action" icon="+" size="default" tone="outline" />
      <OrbButton label="Comfortable action" icon="+" size="comfortable" tone="ink" />
      <OrbButton label="Navigation" icon="◇" size="navigation" tone="outline" />
      <OrbButton label="Feature action" icon="→" size="feature" tone="lime" />
      <OrbButton label="Hero action" icon="→" size="hero" tone="ink" />
    </div>
  ),
};

export const SplitCapsule: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
      <SplitCapsuleButton
        label="New work"
        secondaryLabel="New work options"
        secondaryIcon="⌄"
        tone="ink"
      />
      <SplitCapsuleButton
        label="Post update"
        secondaryLabel="Post update options"
        secondaryIcon="⌄"
        tone="lime"
      />
    </div>
  ),
};
