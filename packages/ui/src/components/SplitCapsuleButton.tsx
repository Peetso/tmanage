import type { ReactNode } from 'react';
import { Button, type ButtonTone, type ControlSize } from './Button.js';
import { OrbButton } from './OrbButton.js';

export interface SplitCapsuleButtonProps {
  /** Visible text of the primary action. */
  label: ReactNode;
  onClick?: () => void;
  /** Accessible name of the secondary action — it is icon-only, so this is required. */
  secondaryLabel: string;
  secondaryIcon: ReactNode;
  onSecondary?: () => void;
  tone?: ButtonTone;
  size?: ControlSize;
  disabled?: boolean;
  className?: string;
}

/**
 * One capsule, two independent controls ("New work" plus its options orb).
 *
 * They are two real buttons rather than one button with a menu affordance drawn inside it.
 * A single control would force a keyboard user to invoke the primary action in order to
 * reach the secondary one, and `27-TEST-CATALOG` A11Y-02 asks for the whole golden journey
 * from the keyboard.
 */
export function SplitCapsuleButton({
  label,
  onClick,
  secondaryLabel,
  secondaryIcon,
  onSecondary,
  tone = 'ink',
  size = 'default',
  disabled = false,
  className,
}: SplitCapsuleButtonProps) {
  const classes = ['tm-split-capsule', className].filter(Boolean).join(' ');

  return (
    <span className={classes}>
      <Button tone={tone} size={size} disabled={disabled} onClick={onClick}>
        {label}
      </Button>
      <OrbButton
        label={secondaryLabel}
        icon={secondaryIcon}
        tone={tone === 'ink' ? 'ink' : 'plain'}
        size="compact"
        disabled={disabled}
        onClick={onSecondary}
      />
    </span>
  );
}
