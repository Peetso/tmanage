import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { CommandsController } from './commands.controller.js';
import { COMMAND_REGISTRY } from './command-registry.js';
import { matchCommands } from './command-match.js';
import type { CommandDefinition } from './command-match.js';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';

const ORG = '01890000-0000-7000-8000-00000000000a';
const context = { organizationId: ORG } as unknown as TenantContext;
function principal(role: Principal['role']): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '01890000-0000-7000-8000-000000000011',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: role === 'owner' || role === 'org_admin',
  };
}
const member = principal('member');

/**
 * SRCH command palette (x181). Database-free proofs of the command surface: the pure matcher's
 * ranking and its no-injection property, and the controller's default set, ordering, bound and gate.
 * No DB test / no e2e per pass-21 (the chain owns both).
 */

const REGISTRY: readonly CommandDefinition[] = [
  {
    id: 'a',
    title: 'Go to Work',
    section: 'Navigate',
    kind: 'navigate',
    href: '/work',
    action: null,
    keywords: ['tasks'],
  },
  {
    id: 'b',
    title: 'Go to Workspace settings',
    section: 'Navigate',
    kind: 'navigate',
    href: '/settings',
    action: null,
    keywords: [],
  },
  {
    id: 'c',
    title: 'Go to Docs',
    section: 'Navigate',
    kind: 'navigate',
    href: '/docs',
    action: null,
    keywords: ['work notes'],
  },
];

describe('matchCommands', () => {
  it('ranks an exact/prefix title above a keyword-only match, deterministically', () => {
    const matched = matchCommands(REGISTRY, 'work', 10);
    // 'Go to Work' (title prefix) and 'Go to Workspace settings' (title prefix) outrank 'Go to Docs'
    // (matched only via its 'work notes' keyword), and the two title-prefix hits keep registry order.
    expect(matched.map((command) => command.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns the registry in order for an empty query (the default set) and bounds it', () => {
    expect(matchCommands(REGISTRY, '   ', 2).map((command) => command.id)).toEqual(['a', 'b']);
  });

  it('never introduces a command the registry did not declare (no injection)', () => {
    const matched = matchCommands(REGISTRY, "'; drop table commands; --", 10);
    expect(matched).toEqual([]);
    for (const command of matchCommands(REGISTRY, 'go', 10)) {
      expect(REGISTRY).toContainEqual(command);
    }
  });
});

describe('CommandsController', () => {
  const controller = new CommandsController();

  it('returns the default set for an empty query, drawn only from the static registry', () => {
    const { commands } = controller.run(context, member, '');
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(COMMAND_REGISTRY.some((entry) => entry.id === command.id)).toBe(true);
      // A navigate carries an href and no action; an action carries an action id and no href.
      if (command.kind === 'navigate') expect(command.action).toBeNull();
      else expect(command.href).toBeNull();
    }
  });

  it('orders matches by score and rejects a non-integer limit with a 400', () => {
    const { commands } = controller.run(context, member, 'inbox');
    expect(commands[0]?.id).toBe('nav-inbox');
    expect(() => controller.run(context, member, '', 'lots')).toThrow(ApiError);
  });

  it('gates the route on the search.use capability', () => {
    const capability = new Reflector().get(REQUIRED_CAPABILITY, CommandsController.prototype.run);
    expect(capability).toBe('search.use');
  });

  it('offers the capture-new command as a navigate to the capture route (modules 22/23)', () => {
    const capture = COMMAND_REGISTRY.find((command) => command.id === 'capture-new');
    expect(capture).toBeDefined();
    expect(capture?.kind).toBe('navigate');
    expect(capture?.href).toBe('/capture');
    expect(capture?.action).toBeNull();
    // And it is reachable from a natural query through the same matcher the palette uses.
    expect(
      controller
        .run(context, member, 'capture')
        .commands.some((command) => command.id === 'capture-new'),
    ).toBe(true);
  });

  it('offers Automations only to callers who can open it (AUT-04)', () => {
    const ids = (role: Principal['role']) =>
      controller.run(context, principal(role), 'automations').commands.map((c) => c.id);
    expect(ids('org_admin')).toContain('nav-automations');
    expect(ids('member')).not.toContain('nav-automations');
    expect(ids('manager')).not.toContain('nav-automations');
  });
});
