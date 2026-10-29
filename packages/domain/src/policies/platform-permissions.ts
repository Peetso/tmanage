/**
 * Platform permissions — who may do what in the Platform admin (`/platform`), SPEC §3.1.
 *
 * These are the operator's permissions, not an organization's: no organization role reaches the
 * platform surface. A platform admin holds a preset (`super_admin`, `support`, `auditor`) or a
 * `custom` list. `PLATFORM_ADMIN_EMAILS` members are always `super_admin`.
 *
 * The catalogue order is the order every screen lists them in (D5 dialog, D6 matrix).
 */

export const PLATFORM_PERMISSIONS = [
  'platform.orgs.view',
  'platform.orgs.edit',
  'platform.orgs.lifecycle',
  'platform.orgs.enter',
  'platform.people.view',
  'platform.people.edit',
  'platform.people.security',
  'platform.people.roles',
  'platform.content.view',
  'platform.content.moderate',
  'platform.activity.view',
  'platform.activity.detail',
  'platform.activity.export',
  'platform.settings.edit',
  'platform.flags.edit',
  'platform.announcements.edit',
  'platform.permissions.edit',
  'platform.team.manage',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/** The presets an admin row can carry. `custom` stores its own list. */
export const PLATFORM_PRESET_NAMES = ['super_admin', 'support', 'auditor', 'custom'] as const;
export type PlatformPreset = (typeof PLATFORM_PRESET_NAMES)[number];

/** The presets whose list comes from the preset mapping rather than the admin row. */
export type PlatformNamedPreset = Exclude<PlatformPreset, 'custom'>;

/** Presets a super admin may re-map from D6. `super_admin` is fixed: always every key. */
export const EDITABLE_PLATFORM_PRESETS = ['support', 'auditor'] as const;
export type EditablePlatformPreset = (typeof EDITABLE_PLATFORM_PRESETS)[number];

/**
 * Only a `super_admin` preset carries this one. "Manage this team" is never given through
 * `support`, `auditor` or `custom`, so the team cannot be widened by someone outside it.
 */
export const SUPER_ADMIN_ONLY_PERMISSIONS: readonly PlatformPermission[] = ['platform.team.manage'];

/** The code defaults (SPEC §3.1). The stored mapping may change `support` and `auditor`. */
export const PLATFORM_PRESETS: Readonly<
  Record<PlatformNamedPreset, readonly PlatformPermission[]>
> = Object.freeze({
  super_admin: PLATFORM_PERMISSIONS,
  support: [
    'platform.orgs.view',
    'platform.orgs.edit',
    'platform.orgs.enter',
    'platform.people.view',
    'platform.people.edit',
    'platform.people.security',
    'platform.people.roles',
    'platform.content.view',
    'platform.content.moderate',
    'platform.activity.view',
    'platform.activity.detail',
    'platform.permissions.edit',
  ],
  auditor: [
    'platform.orgs.view',
    'platform.people.view',
    'platform.content.view',
    'platform.activity.view',
    'platform.activity.detail',
    'platform.activity.export',
  ],
});

/** The six groups of the D5 checkbox dialog, in the order drawn (frame 436:19172). */
export const PLATFORM_PERMISSION_AREAS: readonly {
  readonly id: 'organizations' | 'people' | 'content' | 'activity' | 'settings' | 'team';
  readonly permissions: readonly PlatformPermission[];
}[] = [
  {
    id: 'organizations',
    permissions: [
      'platform.orgs.view',
      'platform.orgs.edit',
      'platform.orgs.lifecycle',
      'platform.orgs.enter',
    ],
  },
  {
    id: 'people',
    permissions: [
      'platform.people.view',
      'platform.people.edit',
      'platform.people.security',
      'platform.people.roles',
    ],
  },
  { id: 'content', permissions: ['platform.content.view', 'platform.content.moderate'] },
  {
    id: 'activity',
    permissions: ['platform.activity.view', 'platform.activity.detail', 'platform.activity.export'],
  },
  {
    id: 'settings',
    permissions: ['platform.settings.edit', 'platform.flags.edit', 'platform.announcements.edit'],
  },
  { id: 'team', permissions: ['platform.permissions.edit', 'platform.team.manage'] },
];

export function isPlatformPermission(value: unknown): value is PlatformPermission {
  return typeof value === 'string' && (PLATFORM_PERMISSIONS as readonly string[]).includes(value);
}

export function isPlatformPreset(value: unknown): value is PlatformPreset {
  return typeof value === 'string' && (PLATFORM_PRESET_NAMES as readonly string[]).includes(value);
}

/**
 * A clean permission list from anything: known keys only, no duplicates, catalogue order.
 * Unknown keys drop out silently (a stored list written by a newer build stays readable).
 */
export function normalizePlatformPermissions(raw: unknown): PlatformPermission[] {
  const values = Array.isArray(raw) ? raw : [];
  const wanted = new Set(values.filter(isPlatformPermission));
  return PLATFORM_PERMISSIONS.filter((key) => wanted.has(key));
}

/**
 * The list a preset or a custom row grants. `super_admin` is always every key; a named preset
 * reads the stored mapping when one is given (minus super-admin-only keys), else the code
 * default; `custom` is its own list (minus super-admin-only keys).
 */
export function platformPermissionsFor(
  preset: PlatformPreset,
  custom: readonly PlatformPermission[] | null,
  storedPresets: Partial<Record<PlatformNamedPreset, readonly PlatformPermission[]>> = {},
): PlatformPermission[] {
  if (preset === 'super_admin') return [...PLATFORM_PERMISSIONS];
  const source =
    preset === 'custom' ? (custom ?? []) : (storedPresets[preset] ?? PLATFORM_PRESETS[preset]);
  return normalizePlatformPermissions(source).filter(
    (key) => !SUPER_ADMIN_ONLY_PERMISSIONS.includes(key),
  );
}
