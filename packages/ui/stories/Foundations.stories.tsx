import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../src/components/Button.js';
import { Field } from '../src/components/Field.js';
import { StateCapsule } from '../src/components/StateCapsule.js';
import { contrastRatio } from '../src/a11y/contrast.js';
import { colorLight, density, orb, radius, space, typeScale } from '../src/tokens/tokens.js';

/**
 * The foundations page: the palette, the type scale, the geometry, and the densities, all
 * rendered from the token module rather than typed out again. If a value here looks wrong,
 * the design export is what changed — nothing on this page is hand-written.
 */
const meta = {
  title: '01 Foundations/Tokens',
  component: Button,
  // Every story on this page renders its own composition; the args satisfy the component
  // type rather than driving anything.
  args: { children: 'Post update' },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * VR2 fix 6: a swatch prints the value its theme really paints — the live custom properties read
 * from the rendered element once it is mounted — so the dark story shows the dark token, never
 * the light export. The story remounts the palette when the theme or contrast changes.
 */
function useLiveTokens(token: string, on: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<{ value: string; ink: string } | null>(null);
  useLayoutEffect(() => {
    if (ref.current === null) return;
    const style = getComputedStyle(ref.current);
    setValues({
      value: style.getPropertyValue(token).trim(),
      ink: style.getPropertyValue(on).trim(),
    });
  }, [token, on]);
  return { ref, values };
}

function Swatch({ token, on = '--ink-950' }: { token: string; on?: string }) {
  const { ref, values } = useLiveTokens(token, on);

  return (
    <div ref={ref} style={{ display: 'grid', gap: 'var(--s1)' }}>
      <div
        style={{
          background: `var(${token})`,
          color: `var(${on})`,
          border: '1px solid var(--line-300)',
          borderRadius: 'var(--r-micro)',
          padding: 'var(--s4)',
          font: '500 13px/18px var(--font-latin)',
        }}
      >
        Aa
      </div>
      <div style={{ font: '500 12px/17px var(--font-latin)', color: 'var(--ink-800)' }}>
        {token.replace(/^--/, '').replace('-', '.')}
      </div>
      <div style={{ font: '400 12px/17px var(--font-mono)', color: 'var(--ink-650)' }}>
        {values !== null && values.value !== '' && values.ink !== ''
          ? `${values.value.toUpperCase()} · ${contrastRatio(values.ink, values.value).toFixed(2)}:1`
          : null}
      </div>
    </div>
  );
}

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
  gap: 'var(--s4)',
} as const;

export const Palette: Story = {
  render: (_args, { globals }) => (
    <div
      key={`${String(globals['theme'])} ${String(globals['contrast'])}`}
      style={{ display: 'grid', gap: 'var(--s8)' }}
    >
      <section>
        <h2>Ink and paper</h2>
        <div style={grid}>
          {Object.keys(colorLight.ink).map((step) => (
            <Swatch key={step} token={`--ink-${step}`} on="--paper-0" />
          ))}
          {Object.keys(colorLight.paper).map((step) => (
            <Swatch key={step} token={`--paper-${step}`} />
          ))}
        </div>
      </section>

      <section>
        <h2>Lime — current, next, live. Never success.</h2>
        <div style={grid}>
          {Object.keys(colorLight.lime).map((step) => (
            <Swatch key={step} token={`--lime-${step}`} />
          ))}
        </div>
      </section>

      <section>
        <h2>Semantic</h2>
        <p style={{ maxWidth: 'var(--reading)', font: '400 15px/22px var(--font-latin)' }}>
          Each swatch shows the value the current theme paints and its ratio against the text colour
          drawn on it. Success, warning and danger are used as borders and glyphs rather than as
          text on light paper, because there they read 4.31:1, 3.64:1 and 4.23:1 — all below AA.
        </p>
        <div style={grid}>
          <Swatch token="--client-500" on="--paper-0" />
          <Swatch token="--success-600" on="--paper-0" />
          <Swatch token="--warning-600" on="--paper-0" />
          <Swatch token="--danger-600" />
        </div>
      </section>
    </div>
  ),
};

export const TypeScale: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s5)' }}>
      {Object.entries(typeScale).map(([name, role]) => (
        <div key={name}>
          <div style={{ font: '400 12px/17px var(--font-mono)', color: 'var(--ink-650)' }}>
            {name} · {role.size}/{role.line} · {role.weight}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-latin)',
              fontSize: `${role.size}px`,
              lineHeight: `${role.line}px`,
              fontWeight: role.weight,
              color: 'var(--ink-800)',
            }}
          >
            Homepage direction
          </div>
        </div>
      ))}
    </div>
  ),
};

export const Geometry: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s8)' }}>
      <section>
        <h2>Space</h2>
        <div style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'flex-end' }}>
          {Object.entries(space).map(([step, value]) => (
            <div key={step} style={{ display: 'grid', gap: 'var(--s1)', justifyItems: 'center' }}>
              <div style={{ width: value, height: value, background: 'var(--ink-950)' }} />
              <span style={{ font: '400 12px/17px var(--font-mono)' }}>{value}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Radius</h2>
        <div style={{ display: 'flex', gap: 'var(--s4)', flexWrap: 'wrap' }}>
          {Object.entries(radius).map(([name, value]) => (
            <div key={name} style={{ display: 'grid', gap: 'var(--s1)', justifyItems: 'center' }}>
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: value,
                  border: '1.5px solid var(--line-700)',
                }}
              />
              <span style={{ font: '400 12px/17px var(--font-mono)' }}>
                {name} {value}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Orbs</h2>
        <div style={{ display: 'flex', gap: 'var(--s4)', alignItems: 'center' }}>
          {Object.entries(orb).map(([name, value]) => (
            <div key={name} style={{ display: 'grid', gap: 'var(--s1)', justifyItems: 'center' }}>
              <div
                style={{
                  width: value,
                  height: value,
                  borderRadius: 'var(--r-capsule)',
                  background: 'var(--ink-950)',
                }}
              />
              <span style={{ font: '400 12px/17px var(--font-mono)' }}>{value}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  ),
};

/**
 * The same three controls at each composition density. Editorial is screen-defined;
 * balanced and operational are the user's choice on desktop.
 */
export const Densities: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s8)' }}>
      {(Object.keys(density) as Array<keyof typeof density>).map((name) => (
        <section key={name} data-density={name}>
          <h2>
            {name} · row {density[name].row} · control {density[name].control}
          </h2>
          <div
            style={{ display: 'flex', gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}
          >
            <Button tone="ink">Post update</Button>
            <Button tone="outline">Cancel</Button>
            <StateCapsule state="current">In progress</StateCapsule>
            <div style={{ minWidth: 240 }}>
              <Field label="Work item title" />
            </div>
          </div>
        </section>
      ))}
    </div>
  ),
};

/**
 * Focus is 2px ink plus a 3px lime halo, and it is the same appearance on every control in
 * the system. Tab through this story — nothing should ever be focused invisibly.
 */
export const Focus: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--s4)', alignItems: 'center', flexWrap: 'wrap' }}>
      <Button tone="ink">Ink</Button>
      <Button tone="lime">Lime</Button>
      <Button tone="outline">Outline</Button>
      <Button tone="destructive">Delete</Button>
      <div style={{ minWidth: 240 }}>
        <Field label="Work item title" />
      </div>
    </div>
  ),
};
