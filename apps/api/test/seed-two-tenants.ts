import type { Pool } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { hashPassword } from '../src/modules/identity/password.js';

/**
 * The seed world, and the adversarial pair the isolation corpus is built on.
 *
 * ## Two requirements, reconciled
 *
 * `19-SEED-DATA-AND-COPY.md` §1 fixes the demo tenants by name: **Northstar Studio** with
 * **Atlas Hospitality** as its client on *Atlas Website Relaunch*, plus **BrightOps
 * Consulting** and its unrelated *Finance Process Review*, which "exists solely to prove no
 * search, ID, notification, cache, file, or audit leakage."
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §11 requires something different of the
 * corpus: "two organizations with intentionally similar IDs/names". Northstar Studio and
 * BrightOps Consulting are not similar in either respect, and renaming file 19's tenants to
 * make them similar would edit a fixed planning artefact.
 *
 * So both are seeded, and each does the job it is specified for:
 *
 * | Organization              | Purpose                                                        |
 * | ------------------------- | -------------------------------------------------------------- |
 * | Northstar Studio          | file 19's demo tenant                                          |
 * | **Northstar Studios**     | §11's adversarial twin — near-identical name, **adjacent id**  |
 * | BrightOps Consulting      | file 19's unrelated-tenant leakage probe                       |
 *
 * The twin is the one that catches real bugs. Its id differs from Northstar Studio's in the
 * **final hex digit only**, so an off-by-one, a truncated `CHAR(36)`, a case-folding
 * mismatch, or a copy-paste in a fixture lands on the other tenant instead of failing
 * loudly. Its project carries the *identical title* to Northstar's, so any lookup that
 * matches on name rather than on `(organization_id, id)` resolves to the wrong tenant. Its
 * owner's email differs from Northstar's by one character.
 *
 * That is the point of §11: a corpus seeded with obviously different tenants passes even
 * when the tenant predicate is missing, because the rows do not collide. These do.
 *
 * ## Why the admin pool
 *
 * Fixtures are written through the migration/admin connection, deliberately outside the
 * tenant-scoped repositories. Runtime code never receives this connection. Everything the
 * corpus then asserts — composite foreign keys, immutability triggers, the query guard — is
 * exercised against rows this file placed, not against rows the system under test created
 * for itself.
 *
 * No lorem ipsum, no "Acme": `15-AI-EXECUTION-HANDBOOK.md` §8 forbids placeholder data, and
 * using the real seed world means the fixtures double as demo data.
 */

export interface SeededUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly membershipId: string;
  readonly role: string;
}

export interface SeededTenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly projectName: string;
  /** One work item on `projectId`, so child-of-tenant-parent cases have a real row. */
  readonly workItemId: string;
  readonly workItemTitle: string;
}

export interface SeedWorld {
  readonly northstar: SeededTenant & {
    readonly owner: SeededUser;
    readonly manager: SeededUser;
    readonly designer: SeededUser;
    /**
     * A disposable member the member-admin and offboarding journeys act on so that neither
     * disturbs a principal the other journeys rely on. She is a member of `projectId`: the
     * member-admin journey re-roles and removes that project membership (keeping her org
     * membership), and the offboarding journey then revokes her org membership. Nothing else
     * signs in as her. The designer is deliberately not reused for either, because the
     * work-delivery journeys sign in as the designer and need her access intact.
     */
    readonly offboardee: SeededUser;
    /** A second Northstar project the designer is *not* a member of. */
    readonly otherProjectId: string;
  };
  /**
   * §11's adversarial twin of `northstar`: near-identical name, adjacent id, identical
   * project and work-item titles. A statement that loses its tenant predicate returns this
   * tenant's rows alongside Northstar's, which is exactly what the corpus checks for.
   */
  readonly twin: SeededTenant & { readonly owner: SeededUser };
  readonly atlas: {
    readonly clientOrganizationId: string;
    readonly admin: SeededUser;
    readonly reviewer: SeededUser;
    readonly viewer: SeededUser;
  };
  /** A second client organization of Northstar, used to prove client-to-client isolation. */
  readonly meridian: {
    readonly clientOrganizationId: string;
    readonly reviewer: SeededUser;
    readonly projectId: string;
  };
  readonly brightops: SeededTenant & { readonly owner: SeededUser };
  // ---- platform-admin v2 · PA-02 ----
  /**
   * The TManage operator: a verified account that belongs to no organization. The e2e stack names
   * this address in `PLATFORM_ADMIN_EMAILS`, so it is the bootstrap super admin.
   */
  readonly platformAdmin: SeededPlatformUser;
  /** A second verified account in no organization, added to the platform team by a journey. */
  readonly supportCandidate: SeededPlatformUser;
}

/** A verified account with no membership anywhere (platform-admin v2). */
export interface SeededPlatformUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  /** Test-only password for the step-up. */
  readonly password: string;
}

/** `e2e/setup/stack.ts` puts this address in `PLATFORM_ADMIN_EMAILS`. */
export const SEEDED_PLATFORM_ADMIN_EMAIL = 'nour.platform@tmanage.example';
export const SEEDED_SUPPORT_CANDIDATE_EMAIL = 'karim.support@tmanage.example';
/**
 * Both platform accounts get this password so a journey can pass the Platform admin step-up
 * (password re-confirmation; neither account has a two-step factor). A test-only value.
 */
export const SEEDED_PLATFORM_PASSWORD = 'platform-e2e-passphrase-2026';

/**
 * Derive an id one hex digit away from `id`.
 *
 * UUIDv7's version and variant bits live in bytes 6 and 8; the final nibble is pure
 * randomness, so decrementing it yields another well-formed, still-v7 identifier. The
 * result is not "another random id" — it is the id a truncation or off-by-one bug would
 * most plausibly produce.
 */
export function adjacentUuid(id: string): string {
  const last = id.slice(-1);
  const value = Number.parseInt(last, 16);
  const shifted = (value === 0 ? 1 : value - 1).toString(16);
  return id.slice(0, -1) + shifted;
}

/** Deterministic shape; ids are fresh per run so parallel runs cannot collide. */
export async function seedTwoTenants(admin: Pool): Promise<SeedWorld> {
  const user = async (email: string, displayName: string): Promise<string> => {
    const id = uuidv7();
    await admin.execute(
      `insert into users (id, email, display_name, email_verified_at)
       values (?, ?, ?, now(3))`,
      [id, email, displayName],
    );
    return id;
  };

  const organization = async (slug: string, name: string, id = uuidv7()): Promise<string> => {
    await admin.execute('insert into organizations (id, slug, name) values (?, ?, ?)', [
      id,
      slug,
      name,
    ]);
    return id;
  };

  const workspace = async (organizationId: string, name: string): Promise<string> => {
    const id = uuidv7();
    await admin.execute('insert into workspaces (id, organization_id, name) values (?, ?, ?)', [
      id,
      organizationId,
      name,
    ]);
    return id;
  };

  const project = async (
    organizationId: string,
    workspaceId: string,
    name: string,
  ): Promise<string> => {
    const id = uuidv7();
    await admin.execute(
      'insert into projects (id, organization_id, workspace_id, name) values (?, ?, ?, ?)',
      [id, organizationId, workspaceId, name],
    );
    return id;
  };

  const workItem = async (
    organizationId: string,
    projectId: string,
    title: string,
    ownerUserId: string | null,
  ): Promise<string> => {
    const id = uuidv7();
    await admin.execute(
      `insert into work_items (id, organization_id, project_id, title, state, owner_user_id)
       values (?, ?, ?, ?, 'in_progress', ?)`,
      [id, organizationId, projectId, title, ownerUserId],
    );
    return id;
  };

  const membership = async (
    organizationId: string,
    userId: string,
    role: string,
    orgWide: boolean,
  ): Promise<string> => {
    const id = uuidv7();
    await admin.execute(
      `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
       values (?, ?, ?, ?, ?)`,
      [id, organizationId, userId, role, orgWide],
    );
    return id;
  };

  const projectMembership = async (
    organizationId: string,
    projectId: string,
    userId: string,
  ): Promise<void> => {
    await admin.execute(
      `insert into project_memberships (id, organization_id, project_id, user_id)
       values (?, ?, ?, ?)`,
      [uuidv7(), organizationId, projectId, userId],
    );
  };

  const clientOrganization = async (organizationId: string, name: string): Promise<string> => {
    const id = uuidv7();
    await admin.execute(
      'insert into client_organizations (id, organization_id, name) values (?, ?, ?)',
      [id, organizationId, name],
    );
    return id;
  };

  const clientMembership = async (
    organizationId: string,
    clientOrganizationId: string,
    userId: string,
    role: string,
  ): Promise<string> => {
    const id = uuidv7();
    await admin.execute(
      `insert into client_memberships
         (id, organization_id, client_organization_id, user_id, role)
       values (?, ?, ?, ?, ?)`,
      [id, organizationId, clientOrganizationId, userId, role],
    );
    return id;
  };

  const shareProject = async (
    organizationId: string,
    projectId: string,
    clientOrganizationId: string,
  ): Promise<void> => {
    await admin.execute(
      `insert into project_clients (id, organization_id, project_id, client_organization_id)
       values (?, ?, ?, ?)`,
      [uuidv7(), organizationId, projectId, clientOrganizationId],
    );
  };

  // ── Northstar Studio ────────────────────────────────────────────────────────
  const northstarOrg = await organization('northstar-studio', 'Northstar Studio');
  const northstarWorkspace = await workspace(northstarOrg, 'Client Delivery');
  const atlasProject = await project(northstarOrg, northstarWorkspace, 'Atlas Website Relaunch');
  const internalProject = await project(
    northstarOrg,
    northstarWorkspace,
    'Northstar Brand Refresh',
  );

  const mayaId = await user('maya.hassan@northstar.example', 'Maya Hassan');
  const omarId = await user('omar.adel@northstar.example', 'Omar Adel');
  const linaId = await user('lina.samir@northstar.example', 'Lina Samir');

  const mayaMembership = await membership(northstarOrg, mayaId, 'owner', true);
  const omarMembership = await membership(northstarOrg, omarId, 'manager', false);
  const linaMembership = await membership(northstarOrg, linaId, 'member', false);

  // The single disposable member the two mutating journeys act on, so that neither has to touch
  // a principal the other journeys depend on. A plain member (never the last administrator), so
  // offboarding her removes no administrator. The member-admin journey re-roles her and removes
  // her atlas-project membership (leaving her org membership); the offboarding journey then
  // revokes that org membership. The designer is left out of both — the work-delivery journeys
  // sign in as her and need her org and project access to still resolve. See
  // `SeedWorld.northstar.offboardee`.
  const ranaId = await user('rania.farouk@northstar.example', 'Rania Farouk');
  const ranaMembership = await membership(northstarOrg, ranaId, 'member', false);

  await projectMembership(northstarOrg, atlasProject, omarId);
  await projectMembership(northstarOrg, atlasProject, linaId);
  await projectMembership(northstarOrg, atlasProject, ranaId);
  // Deliberately: Lina is NOT a member of the Brand Refresh project. Same tenant,
  // different project — one of the grid cases in 25-AUTH-AND-TENANT-ISOLATION §11.
  await projectMembership(northstarOrg, internalProject, omarId);

  const northstarWorkItem = await workItem(
    northstarOrg,
    atlasProject,
    'Prepare mobile booking flow concepts',
    linaId,
  );

  // ── Northstar Studios — §11's adversarial twin ──────────────────────────────
  // Adjacent id, name differing by one letter, identical project and work-item titles.
  // Nothing about this tenant is related to Northstar Studio; everything about it is
  // designed to be mistaken for it.
  const twinOrg = await organization(
    'northstar-studios',
    'Northstar Studios',
    adjacentUuid(northstarOrg),
  );
  const twinWorkspace = await workspace(twinOrg, 'Client Delivery');
  const twinProject = await project(twinOrg, twinWorkspace, 'Atlas Website Relaunch');
  const mayaTwinId = await user('maya.hassan@northstar-studios.example', 'Maya Hasan');
  const mayaTwinMembership = await membership(twinOrg, mayaTwinId, 'owner', true);
  await projectMembership(twinOrg, twinProject, mayaTwinId);
  const twinWorkItem = await workItem(
    twinOrg,
    twinProject,
    'Prepare mobile booking flow concepts',
    mayaTwinId,
  );

  // ── Atlas Hospitality (client of Northstar) ─────────────────────────────────
  const atlasClientOrg = await clientOrganization(northstarOrg, 'Atlas Hospitality');
  const salmaId = await user('salma.riad@atlas.example', 'Salma Riad');
  const youssefId = await user('youssef.kamal@atlas.example', 'Youssef Kamal');
  const dinaId = await user('dina.ashraf@atlas.example', 'Dina Ashraf');

  const salmaMembership = await clientMembership(
    northstarOrg,
    atlasClientOrg,
    salmaId,
    'client_admin',
  );
  const youssefMembership = await clientMembership(
    northstarOrg,
    atlasClientOrg,
    youssefId,
    'client_reviewer',
  );
  const dinaMembership = await clientMembership(
    northstarOrg,
    atlasClientOrg,
    dinaId,
    'client_viewer',
  );
  await shareProject(northstarOrg, atlasProject, atlasClientOrg);

  // ── Meridian Retail — a second client of the SAME studio ────────────────────
  // Exists to prove the client-to-client boundary inside one tenant, which neither the
  // twin nor BrightOps can test because both are different tenants entirely.
  const meridianClientOrg = await clientOrganization(northstarOrg, 'Meridian Retail Group');
  const meridianProject = await project(
    northstarOrg,
    northstarWorkspace,
    'Meridian Loyalty Portal',
  );
  const hanaId = await user('hana.mostafa@meridian.example', 'Hana Mostafa');
  const hanaMembership = await clientMembership(
    northstarOrg,
    meridianClientOrg,
    hanaId,
    'client_reviewer',
  );
  await shareProject(northstarOrg, meridianProject, meridianClientOrg);

  // ── BrightOps Consulting — file 19's unrelated tenant ───────────────────────
  const brightopsOrg = await organization('brightops-consulting', 'BrightOps Consulting');
  const brightopsWorkspace = await workspace(brightopsOrg, 'Advisory');
  const financeProject = await project(brightopsOrg, brightopsWorkspace, 'Finance Process Review');
  const tarekId = await user('tarek.said@brightops.example', 'Tarek Said');
  const tarekMembership = await membership(brightopsOrg, tarekId, 'owner', true);
  await projectMembership(brightopsOrg, financeProject, tarekId);
  const brightopsWorkItem = await workItem(
    brightopsOrg,
    financeProject,
    'Map approval chain for vendor payments',
    tarekId,
  );

  // ---- platform-admin v2 · PA-02 ----
  const platformAdminId = await user(SEEDED_PLATFORM_ADMIN_EMAIL, 'Nour Platform');
  const supportCandidateId = await user(SEEDED_SUPPORT_CANDIDATE_EMAIL, 'Karim Support');
  const platformPasswordHash = await hashPassword(SEEDED_PLATFORM_PASSWORD);
  for (const id of [platformAdminId, supportCandidateId]) {
    await admin.execute('insert into user_passwords (user_id, password_hash) values (?, ?)', [
      id,
      platformPasswordHash,
    ]);
  }

  return {
    northstar: {
      organizationId: northstarOrg,
      workspaceId: northstarWorkspace,
      projectId: atlasProject,
      projectName: 'Atlas Website Relaunch',
      workItemId: northstarWorkItem,
      workItemTitle: 'Prepare mobile booking flow concepts',
      otherProjectId: internalProject,
      owner: {
        id: mayaId,
        email: 'maya.hassan@northstar.example',
        displayName: 'Maya Hassan',
        membershipId: mayaMembership,
        role: 'owner',
      },
      manager: {
        id: omarId,
        email: 'omar.adel@northstar.example',
        displayName: 'Omar Adel',
        membershipId: omarMembership,
        role: 'manager',
      },
      designer: {
        id: linaId,
        email: 'lina.samir@northstar.example',
        displayName: 'Lina Samir',
        membershipId: linaMembership,
        role: 'member',
      },
      offboardee: {
        id: ranaId,
        email: 'rania.farouk@northstar.example',
        displayName: 'Rania Farouk',
        membershipId: ranaMembership,
        role: 'member',
      },
    },
    twin: {
      organizationId: twinOrg,
      workspaceId: twinWorkspace,
      projectId: twinProject,
      projectName: 'Atlas Website Relaunch',
      workItemId: twinWorkItem,
      workItemTitle: 'Prepare mobile booking flow concepts',
      owner: {
        id: mayaTwinId,
        email: 'maya.hassan@northstar-studios.example',
        displayName: 'Maya Hasan',
        membershipId: mayaTwinMembership,
        role: 'owner',
      },
    },
    atlas: {
      clientOrganizationId: atlasClientOrg,
      admin: {
        id: salmaId,
        email: 'salma.riad@atlas.example',
        displayName: 'Salma Riad',
        membershipId: salmaMembership,
        role: 'client_admin',
      },
      reviewer: {
        id: youssefId,
        email: 'youssef.kamal@atlas.example',
        displayName: 'Youssef Kamal',
        membershipId: youssefMembership,
        role: 'client_reviewer',
      },
      viewer: {
        id: dinaId,
        email: 'dina.ashraf@atlas.example',
        displayName: 'Dina Ashraf',
        membershipId: dinaMembership,
        role: 'client_viewer',
      },
    },
    meridian: {
      clientOrganizationId: meridianClientOrg,
      projectId: meridianProject,
      reviewer: {
        id: hanaId,
        email: 'hana.mostafa@meridian.example',
        displayName: 'Hana Mostafa',
        membershipId: hanaMembership,
        role: 'client_reviewer',
      },
    },
    brightops: {
      organizationId: brightopsOrg,
      workspaceId: brightopsWorkspace,
      projectId: financeProject,
      projectName: 'Finance Process Review',
      workItemId: brightopsWorkItem,
      workItemTitle: 'Map approval chain for vendor payments',
      owner: {
        id: tarekId,
        email: 'tarek.said@brightops.example',
        displayName: 'Tarek Said',
        membershipId: tarekMembership,
        role: 'owner',
      },
    },
    platformAdmin: {
      id: platformAdminId,
      email: SEEDED_PLATFORM_ADMIN_EMAIL,
      displayName: 'Nour Platform',
      password: SEEDED_PLATFORM_PASSWORD,
    },
    supportCandidate: {
      id: supportCandidateId,
      email: SEEDED_SUPPORT_CANDIDATE_EMAIL,
      displayName: 'Karim Support',
      password: SEEDED_PLATFORM_PASSWORD,
    },
  };
}
