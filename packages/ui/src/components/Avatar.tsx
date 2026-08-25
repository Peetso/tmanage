import type { OrbSize } from './OrbButton.js';

export type Audience = 'internal' | 'client';

export interface AvatarProps {
  /** The person's name. Used for the initials and for the accessible name. */
  name: string;
  src?: string;
  /**
   * `client` draws the violet external-boundary ring — and adds the word "client" to the
   * accessible name, because the ring is a colour and colour is never the only carrier.
   */
  audience?: Audience;
  size?: OrbSize;
  /**
   * Set when the name is already visible next to the avatar. The image then contributes
   * nothing to the accessibility tree instead of repeating the name.
   */
  decorative?: boolean;
  className?: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function Avatar({
  name,
  src,
  audience = 'internal',
  size = 'default',
  decorative = false,
  className,
}: AvatarProps) {
  const classes = [
    'tm-avatar',
    `tm-orb-button--${size}`,
    audience === 'client' ? 'tm-avatar--client' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const accessibleName = audience === 'client' ? `${name}, client` : name;

  return (
    <span
      className={classes}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : accessibleName}
      aria-hidden={decorative ? true : undefined}
    >
      {src ? (
        <img className="tm-avatar__image" src={src} alt="" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
}

export interface AvatarOverflowProps {
  /** How many people are not shown. */
  count: number;
  /** The full accessible sentence, e.g. "7 more people". */
  label: string;
  size?: OrbSize;
  className?: string;
}

/** The "+7" disc at the end of a stack. A count, not a person. */
export function AvatarOverflow({ count, label, size = 'default', className }: AvatarOverflowProps) {
  const classes = ['tm-avatar', 'tm-avatar--overflow', `tm-orb-button--${size}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} role="img" aria-label={label}>
      <span aria-hidden="true">{`+${count}`}</span>
    </span>
  );
}
