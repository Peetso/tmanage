import { createPool } from 'mysql2/promise';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';

/**
 * Demo/review data top-up: People teams, disciplines, weekly capacity and allocations for the seeded
 * Northstar Studio, so the People "Teams" panel and the Portfolio "Capacity" panel have something to
 * show on the review database (the two-tenant seed in `seed-two-tenants.ts` deliberately leaves them
 * empty, and every database suite depends on that seed, so it is not extended here).
 *
 * Run after `seed-cli.ts` (and the review account script, which adds Nadia Fathy):
 *   `tsx test/demo-teams-capacity-cli.ts` with `TMANAGE_SEED_DATABASE_URL` set.
 *
 * Idempotent: every row is keyed by its natural key (team name per org, the team/member pair, one
 * capacity row and one profile per member, one allocation per project/member), so a second run
 * writes nothing new and never overwrites a value someone has since edited in the app. Members or
 * projects that do not exist are skipped, never created. Only the one demo organization is touched.
 * Test/review tooling only; nothing in any runtime path invokes it. SQL is MariaDB 11.8-safe.
 */

const ORG_SLUG = 'northstar-studio';

/** Discipline (member_profiles.department) and weekly hours per member, by email. */
const PEOPLE: readonly { email: string; department: string; weeklyHours: number }[] = [
  { email: 'maya.hassan@northstar.example', department: 'Delivery', weeklyHours: 32 },
  { email: 'omar.adel@northstar.example', department: 'Delivery', weeklyHours: 40 },
  { email: 'lina.samir@northstar.example', department: 'Design', weeklyHours: 40 },
  { email: 'rania.farouk@northstar.example', department: 'Engineering', weeklyHours: 36 },
  { email: 'nadia.fathy@northstar.example', department: 'Operations', weeklyHours: 24 },
];

const TEAMS: readonly { name: string; members: readonly string[] }[] = [
  {
    name: 'Design & Brand',
    members: ['lina.samir@northstar.example', 'maya.hassan@northstar.example'],
  },
  {
    name: 'Product Engineering',
    members: ['rania.farouk@northstar.example', 'omar.adel@northstar.example'],
  },
  {
    name: 'Client Delivery',
    members: [
      'omar.adel@northstar.example',
      'maya.hassan@northstar.example',
      'lina.samir@northstar.example',
    ],
  },
  {
    name: 'Studio Operations',
    members: ['nadia.fathy@northstar.example', 'maya.hassan@northstar.example'],
  },
];

/** Share of each member's week per project (by project name); open-ended from the start date. */
const ALLOCATIONS: readonly { email: string; project: string; percent: number }[] = [
  { email: 'lina.samir@northstar.example', project: 'Atlas Website Relaunch', percent: 60 },
  { email: 'lina.samir@northstar.example', project: 'Northstar Brand Refresh', percent: 40 },
  { email: 'rania.farouk@northstar.example', project: 'Cedar Clinics Patient App', percent: 70 },
  { email: 'rania.farouk@northstar.example', project: 'Meridian Loyalty Portal', percent: 40 },
  { email: 'omar.adel@northstar.example', project: 'Atlas Website Relaunch', percent: 50 },
  { email: 'omar.adel@northstar.example', project: 'Meridian Loyalty Portal', percent: 30 },
  {
    email: 'maya.hassan@northstar.example',
    project: 'Studio Operations Playbook 2027',
    percent: 30,
  },
  { email: 'maya.hassan@northstar.example', project: 'Atlas Website Relaunch', percent: 20 },
  {
    email: 'nadia.fathy@northstar.example',
    project: 'Studio Operations Playbook 2027',
    percent: 50,
  },
];

const EFFECTIVE_FROM = '2026-01-05';
const ALLOCATION_START = '2026-09-01';

interface Member {
  readonly membershipId: string;
  readonly userId: string;
}

export interface DemoTopUpResult {
  readonly organizationId: string;
  readonly teams: number;
  readonly teamAssignments: number;
  readonly capacityRows: number;
  readonly profiles: number;
  readonly allocations: number;
  readonly skipped: readonly string[];
}

export async function seedDemoTeamsAndCapacity(pool: Pool): Promise<DemoTopUpResult> {
  const [orgRows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM organizations WHERE slug = ?',
    [ORG_SLUG],
  );
  const organizationId = orgRows[0]?.['id'] as string | undefined;
  if (organizationId === undefined) throw new Error(`organization ${ORG_SLUG} not found`);

  const [memberRows] = await pool.query<RowDataPacket[]>(
    `SELECT m.id AS membershipId, m.user_id AS userId, u.email AS email
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? AND m.status = 'active'`,
    [organizationId],
  );
  const members = new Map<string, Member>(
    memberRows.map((row) => [
      String(row['email']).toLowerCase(),
      { membershipId: String(row['membershipId']), userId: String(row['userId']) },
    ]),
  );
  const [projectRows] = await pool.query<RowDataPacket[]>(
    'SELECT id, name FROM projects WHERE organization_id = ?',
    [organizationId],
  );
  const projects = new Map<string, string>(
    projectRows.map((row) => [String(row['name']), String(row['id'])]),
  );

  const skipped: string[] = [];
  let teams = 0;
  let teamAssignments = 0;
  let capacityRows = 0;
  let profiles = 0;
  let allocations = 0;

  for (const person of PEOPLE) {
    const member = members.get(person.email);
    if (member === undefined) {
      skipped.push(`member ${person.email}`);
      continue;
    }
    // Fill the discipline only where none is set, so an edit made in the app survives a re-run.
    // (NOT EXISTS rather than ON DUPLICATE KEY: mysql2 reports found rows, so a no-op duplicate
    // would still count as 1 and the printed summary would lie about a re-run.)
    const [profile] = await pool.query<ResultSetHeader>(
      `INSERT INTO member_profiles (id, organization_id, user_id, department)
       SELECT ?, ?, ?, ? FROM DUAL
        WHERE NOT EXISTS (SELECT 1 FROM member_profiles WHERE organization_id = ? AND user_id = ?)`,
      [uuidv7(), organizationId, member.userId, person.department, organizationId, member.userId],
    );
    const [filled] = await pool.query<ResultSetHeader>(
      `UPDATE member_profiles SET department = ?
        WHERE organization_id = ? AND user_id = ? AND department IS NULL`,
      [person.department, organizationId, member.userId],
    );
    if (profile.affectedRows + filled.affectedRows > 0) profiles += 1;
    // One capacity row per member; an existing figure is kept as is.
    const [capacity] = await pool.query<ResultSetHeader>(
      `INSERT INTO person_capacity (id, organization_id, membership_id, weekly_hours, effective_from)
       SELECT ?, ?, ?, ?, ? FROM DUAL
        WHERE NOT EXISTS
          (SELECT 1 FROM person_capacity WHERE organization_id = ? AND membership_id = ?)`,
      [
        uuidv7(),
        organizationId,
        member.membershipId,
        person.weeklyHours,
        EFFECTIVE_FROM,
        organizationId,
        member.membershipId,
      ],
    );
    capacityRows += capacity.affectedRows;
  }

  for (const team of TEAMS) {
    const [existing] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM member_teams WHERE organization_id = ? AND name = ? AND team_id IS NULL',
      [organizationId, team.name],
    );
    let teamId = existing[0]?.['id'] as string | undefined;
    if (teamId === undefined) {
      teamId = uuidv7();
      await pool.query('INSERT INTO member_teams (id, organization_id, name) VALUES (?, ?, ?)', [
        teamId,
        organizationId,
        team.name,
      ]);
      teams += 1;
    }
    for (const email of team.members) {
      const member = members.get(email);
      if (member === undefined) {
        skipped.push(`team member ${email}`);
        continue;
      }
      const [assignment] = await pool.query<ResultSetHeader>(
        `INSERT INTO member_teams (id, organization_id, team_id, membership_id)
         SELECT ?, ?, ?, ? FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM member_teams
                             WHERE organization_id = ? AND team_id = ? AND membership_id = ?)`,
        [
          uuidv7(),
          organizationId,
          teamId,
          member.membershipId,
          organizationId,
          teamId,
          member.membershipId,
        ],
      );
      teamAssignments += assignment.affectedRows;
    }
  }

  for (const allocation of ALLOCATIONS) {
    const member = members.get(allocation.email);
    const projectId = projects.get(allocation.project);
    if (member === undefined || projectId === undefined) {
      skipped.push(`allocation ${allocation.email} -> ${allocation.project}`);
      continue;
    }
    const [existing] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM person_allocations
        WHERE organization_id = ? AND project_id = ? AND membership_id = ? LIMIT 1`,
      [organizationId, projectId, member.membershipId],
    );
    if (existing.length > 0) continue;
    await pool.query(
      `INSERT INTO person_allocations
         (id, organization_id, project_id, membership_id, percent, start_date, end_date)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [
        uuidv7(),
        organizationId,
        projectId,
        member.membershipId,
        allocation.percent,
        ALLOCATION_START,
      ],
    );
    allocations += 1;
  }

  return { organizationId, teams, teamAssignments, capacityRows, profiles, allocations, skipped };
}

const url = process.env['TMANAGE_SEED_DATABASE_URL'];
if (!url) {
  console.error('TMANAGE_SEED_DATABASE_URL is not set');
  process.exit(1);
}

const pool = createPool({ uri: url, connectionLimit: 2, timezone: 'Z' });
try {
  const result = await seedDemoTeamsAndCapacity(pool);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}
