import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PortalWorkItemView } from '../clients/portal.service.js';
import type { PublicLinkView } from '../public-links/public-links.service.js';

/**
 * AUTH-53-42 — iterations and points never reach a client.
 *
 * The client projections build their views field by field, so the guard is twofold: the view
 * types carry no iteration or points key (a compile-time check below), and no client-facing source
 * (the portal service, the portal module, public links) names the planning fields at all — a
 * spread that would carry them is caught by the source scan.
 */

type HasPlanningKey<T> = Extract<keyof T, 'iterationId' | 'points' | 'iteration' | 'pointsEnabled'>;
const portalHasNone: [HasPlanningKey<PortalWorkItemView>] extends [never] ? true : false = true;
const linkHasNone: [HasPlanningKey<PublicLinkView>] extends [never] ? true : false = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = resolve(HERE, '..');

function sources(dir: string): string[] {
  return readdirSync(resolve(MODULES, dir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => resolve(MODULES, dir, f));
}

describe('client projections carry no iteration keys (AUTH-53-42)', () => {
  it('the portal and public-link view types have no iteration or points key', () => {
    expect(portalHasNone).toBe(true);
    expect(linkHasNone).toBe(true);
  });

  it('no client-facing source names an iteration or points field', () => {
    const files = [
      resolve(MODULES, 'clients/portal.service.ts'),
      ...sources('portal'),
      ...sources('public-links'),
    ];
    const pattern =
      /\biteration(Id|_id|AssignedAt|_assigned_at|s)?\b|\bpoints(Enabled|_enabled)?\b|workItemPlanning/;
    const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
