import { createHash } from 'node:crypto';

/**
 * Tenant query guard — **ADR-0001 layer 3, the row-level-security replacement.**
 *
 * ## Why this file exists
 *
 * On PostgreSQL with RLS, a forgotten `WHERE organization_id = $1` returns zero rows. On
 * MySQL the identical omission returns **every tenant's rows**, and nothing in the engine
 * objects. The failure mode inverts from safe to catastrophic, and it is silent: the
 * endpoint works, happy-path tests pass, and the leak is invisible until a customer sees
 * another customer's data.
 *
 * Spec section 6 requires that "development/test query instrumentation rejects access to
 * tenant tables when a tenant predicate is missing". This is that instrumentation. Every
 * statement issued through the tenant connection wrapper passes through
 * {@link assertTenantScoped} first.
 *
 * ## What it checks
 *
 * For each statement it identifies the tenant-owned tables referenced, then requires that
 * every one of them is constrained — directly or through a chain of join equalities — to
 * a tenant key bound to the **active** `TenantContext`. Both halves matter:
 *
 * - A missing predicate is a leak.
 * - A predicate bound to *some other* organization id is also a leak, so the guard
 *   inspects the bound parameter values, not only the SQL text.
 *
 * ## Deliberate design choices
 *
 * **Fail closed.** Anything the analyser cannot confidently interpret is a violation, not
 * a pass. A false positive costs a developer one explicit escape hatch; a false negative
 * costs a cross-tenant disclosure. The asymmetry is not close.
 *
 * **Bound parameters only.** A tenant predicate written as a string literal is rejected
 * even when the literal is correct, because spec section 5 requires parameterized queries
 * and because a literal cannot be checked against the active context at all.
 *
 * **The escape hatch is explicit and audited.** Some statements are legitimately
 * cross-tenant — the outbox relay claiming the oldest unpublished events is the canonical
 * one. Those pass `allowUnscoped` with a mandatory reason string, which is recorded. The
 * guard is never loosened to accommodate them (ADR-0001, Consequences).
 *
 * ## What it is not
 *
 * It is not a SQL parser, and it is not a substitute for layers 1, 2, 4 and 5. It runs
 * inside the application, so it does nothing for a direct SQL session or a compromised
 * credential — ADR-0001 states that limitation plainly and layers 1 and 2 are what cover
 * those cases.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every tenant-owned table, mapped to the column that carries its tenant key.
 *
 * `organizations` is the exception: it *is* the tenant, so its tenant key is `id`. A read
 * of `organizations` is still required to be scoped — otherwise listing the customer base
 * would be one forgotten predicate away.
 *
 * Kept in step with the migrations by `tenant-isolation.db.test.ts`, which reads
 * `information_schema` and fails if any table with an `organization_id` column is missing
 * from this map. A new module migration cannot quietly opt out of the guard.
 */
export const TENANT_TABLES: Readonly<Record<string, 'organization_id' | 'id'>> = Object.freeze({
  organizations: 'id',
  memberships: 'organization_id',
  workspaces: 'organization_id',
  projects: 'organization_id',
  project_memberships: 'organization_id',
  client_organizations: 'organization_id',
  client_memberships: 'organization_id',
  project_clients: 'organization_id',
  // TEN-003. Tenant-owned like every other grant: an invitation names one organization, and
  // the acceptance path reaches it through `bootstrapRead` rather than by being global.
  invitations: 'organization_id',
  work_items: 'organization_id',
  // WORK-003. Both tenant-owned: an edge names two tenant rows, and a blocker's reason and
  // ask are internal prose about a studio's work.
  work_item_dependencies: 'organization_id',
  work_blockers: 'organization_id',
  // REQ-001. Tenant-owned and, unusually, also client-owned: `client_organization_id` is
  // NOT NULL, so every row belongs both to a studio and to one of its clients.
  client_requests: 'organization_id',
  // FR-05 (0027). Both tenant-owned: a deliverable version and the approval bound to it belong to
  // one studio, and an unscoped read of either would leak another studio's governed content or
  // decisions.
  deliverable_versions: 'organization_id',
  approvals: 'organization_id',
  // CHAT-001. All three are tenant-owned, and `messages` is the table in this system whose
  // content is most obviously somebody else's: an unscoped `SELECT ... FROM messages` is a
  // transcript of every studio on the server.
  conversations: 'organization_id',
  conversation_memberships: 'organization_id',
  messages: 'organization_id',
  // CHAT-002. Tenant-owned for the reason `messages` is — a revision is a message body that
  // was superseded, which is exactly as much somebody else's transcript as the current one.
  // The application never writes this table (the 0008 trigger does, with definer
  // privileges); registering it here scopes the READS.
  message_revisions: 'organization_id',
  // CHAT-003. Tenant-owned: the link names a message and a work item, both tenant rows, and
  // an unscoped read of it would be a map of which studio converted what.
  message_work_links: 'organization_id',
  outbox_events: 'organization_id',
  idempotency_records: 'organization_id',
  audit_events: 'organization_id',
  // NOTIF-001. Tenant-owned: a notification names a tenant object, and an unscoped read of
  // it would be a feed of what is happening inside every studio on the server.
  notifications: 'organization_id',
  // NOTIF-001 preferences. Tenant-owned: a person's channel, digest and quiet-hours settings
  // are per studio, and an unscoped read would be every person's settings in every studio.
  notification_preferences: 'organization_id',
  // FILE-001. All four are tenant-owned. The counter is a customer's bill in progress;
  // the asset, its versions and the session name a project and carry an object key, and
  // an unscoped read of any of them would be an inventory of every studio's files.
  usage_counters: 'organization_id',
  file_assets: 'organization_id',
  file_versions: 'organization_id',
  upload_sessions: 'organization_id',
  // USAGE-001 slice 2 (migration 0021). Tenant-owned like `usage_counters`, whose every
  // move it records: `organization_id` is NOT NULL and it carries the `(organization_id, id)`
  // key every tenant table has. An unscoped read would be a per-organization ledger of every
  // studio's storage spend, so the guard must scope its READS.
  usage_ledger_entries: 'organization_id',
  // ON-09 (migration 0028). Tenant-owned: an import attempt names one organization, and an
  // unscoped read would be every studio's onboarding-import history. `organization_id` is NOT
  // NULL and it carries the `(organization_id, id)` key every tenant table has, so the guard
  // scopes its reads and writes.
  import_jobs: 'organization_id',
  // CAL-01 / MTG-01 (x90). Tenant-owned: a meeting names a project, and an unscoped
  // `SELECT ... FROM meetings` would be every studio's calendar on the server. The guard must
  // scope its reads and its writes.
  meetings: 'organization_id',
  // DOC-01 (x91). Tenant-owned: a document names a project, and an unscoped
  // `SELECT ... FROM documents` would be every studio's knowledge base on the server. The guard
  // must scope its reads and its writes.
  documents: 'organization_id',
});

/**
 * Tables that are intentionally global, listed so the omission is a decision rather than
 * an oversight. `users`, `sessions` and `session_refresh_tokens` are cross-tenant identity:
 * one person, one account, memberships in many organizations — forking identity per tenant
 * would break revocation across them. `schema_migrations` belongs to the migrator.
 *
 * This list is not merely documentation. `TenantDatabase.identityRead()` and
 * `.identityTransaction()` require every table they are declared over to appear here, so a
 * table cannot be reached from the no-tenant-context path unless it is registered as global
 * in this file. `tenant-isolation.db.test.ts` holds it to `information_schema`: every table
 * in the database is in exactly one of the two registries.
 */
export const NON_TENANT_TABLES: readonly string[] = Object.freeze([
  'users',
  'sessions',
  'session_refresh_tokens',
  'schema_migrations',
  // ID-002. A person is one account holding memberships in many organizations, so their
  // credentials cannot be forked per tenant: doing so would mean revoking a password in one
  // organization left it working in the rest. `authentication_events` is non-tenant for a
  // sharper reason still — it records attempts made before any tenant has been resolved, and
  // some of them name no user at all.
  'user_passwords',
  'user_mfa_factors',
  'user_recovery_codes',
  'authentication_events',
  // D05d. The notice queue that tells an account holder their credentials changed. Global
  // for the same reason the credentials are: the change it describes is not a fact about
  // one tenant, and it is written on the identity path, before any tenant exists. It is
  // deliberately NOT `outbox_events` — that table's `organization_id` is NOT NULL and this
  // path has no organization to put in it. `0020_credential_change_notices.sql` explains.
  'credential_change_notices',
]);

export function isTenantTable(name: string): boolean {
  return Object.hasOwn(TENANT_TABLES, name.toLowerCase());
}

export function isNonTenantTable(name: string): boolean {
  return NON_TENANT_TABLES.includes(name.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

type TokenKind = 'word' | 'punct' | 'param' | 'literal' | 'number';

interface Token {
  readonly kind: TokenKind;
  /** Lower-cased for words and punctuation; the raw text for literals and numbers. */
  readonly value: string;
  /** Paren nesting depth at which the token appears. */
  readonly depth: number;
  /** Ordinal position among `?` placeholders, so a token can be matched to its parameter. */
  readonly paramIndex?: number;
}

const OPERATORS = ['<=>', '<>', '!=', '<=', '>=', ':=', '&&', '||', '=', '<', '>'] as const;

/**
 * Reduce a statement to tokens, discarding comments and collapsing string literals.
 *
 * Collapsing literals is a correctness requirement, not a tidiness one: without it the
 * text `'... organization_id = ...'` inside a string would register as a tenant predicate,
 * which is precisely the injection an attacker would reach for.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;
  let paramCount = 0;

  while (i < sql.length) {
    const ch = sql[i] as string;
    const rest = sql.slice(i);

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '#' || (ch === '-' && /^--[\s]/.test(rest))) {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? sql.length : eol + 1;
      continue;
    }

    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    // Backtick-quoted identifiers become ordinary words, so `organization_id` and
    // organization_id are the same token to the analyser.
    if (ch === '`') {
      let j = i + 1;
      let name = '';
      while (j < sql.length) {
        if (sql[j] === '`') {
          if (sql[j + 1] === '`') {
            name += '`';
            j += 2;
            continue;
          }
          break;
        }
        name += sql[j];
        j += 1;
      }
      tokens.push({ kind: 'word', value: name.toLowerCase(), depth });
      i = j + 1;
      continue;
    }

    // MySQL's default mode treats double quotes as string delimiters; the migrations never
    // enable ANSI_QUOTES, and the connection factory does not set it either.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        const c = sql[j] as string;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      tokens.push({ kind: 'literal', value: sql.slice(i + 1, j), depth });
      i = j + 1;
      continue;
    }

    if (ch === '?') {
      tokens.push({ kind: 'param', value: '?', depth, paramIndex: paramCount });
      paramCount += 1;
      i += 1;
      continue;
    }

    if (/[A-Za-z_@$]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_@$]/.test(sql[j] as string)) j += 1;
      tokens.push({ kind: 'word', value: sql.slice(i, j).toLowerCase(), depth });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[0-9.eE+-]/.test(sql[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: sql.slice(i, j), depth });
      i = j;
      continue;
    }

    if (ch === '(') {
      depth += 1;
      tokens.push({ kind: 'punct', value: '(', depth });
      i += 1;
      continue;
    }

    if (ch === ')') {
      tokens.push({ kind: 'punct', value: ')', depth });
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }

    const operator = OPERATORS.find((op) => rest.startsWith(op));
    if (operator) {
      tokens.push({ kind: 'punct', value: operator, depth });
      i += operator.length;
      continue;
    }

    tokens.push({ kind: 'punct', value: ch, depth });
    i += 1;
  }

  return tokens;
}

/**
 * Every tenant-owned table named anywhere in a statement, however it is used.
 *
 * Deliberately cruder than {@link analyzeStatement}'s `tenantTables`, and that is the point.
 * `tenantTables` reports the tables the reference scanner *understood* — the ones introduced
 * by `FROM`, `JOIN`, `UPDATE`, `INTO`. This reports every tenant table name that survives
 * tokenization, including one sitting somewhere the scanner could not interpret.
 *
 * Used by the bootstrap read path (`TenantDatabase.bootstrapRead`), where the question is
 * not "is this statement scoped" — nothing there can be — but "does this statement stay
 * inside the small set of tables the caller declared". For that question the conservative
 * answer is the correct one: a name the analyser could not place must still count against
 * the allowlist, or an unanalysable statement would slip past the very check that exists
 * because the tenant predicate has been waived.
 *
 * String literals are collapsed by the tokenizer before this runs, so `'projects'` inside a
 * value does not register as a reference to `projects`.
 */
export function tenantTablesMentioned(sql: string): readonly string[] {
  const names = new Set<string>();
  for (const token of tokenize(sql)) {
    if (token.kind === 'word' && isTenantTable(token.value)) names.add(token.value);
  }
  return [...names].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

/** Words that can never be a table alias, so `from projects where …` is not read as an alias. */
const NON_ALIAS_WORDS = new Set([
  'where',
  'on',
  'using',
  'join',
  'inner',
  'left',
  'right',
  'outer',
  'cross',
  'natural',
  'straight_join',
  'set',
  'group',
  'order',
  'limit',
  'offset',
  'having',
  'union',
  'intersect',
  'except',
  'for',
  'values',
  'value',
  'select',
  'insert',
  'update',
  'delete',
  'replace',
  'into',
  'as',
  'partition',
  'force',
  'use',
  'ignore',
  'index',
  'key',
  'lock',
  'procedure',
  'when',
  'then',
  'else',
  'end',
  'and',
  'or',
  'not',
  'is',
  'null',
  'window',
  'with',
  'duplicate',
  'share',
  'mode',
  'returning',
  'default',
  'from',
  'distinct',
]);

const TABLE_INTRODUCERS = new Set(['from', 'join', 'update', 'into', 'table']);

interface TableRef {
  readonly table: string;
  readonly alias: string;
  readonly tenantColumn: 'organization_id' | 'id';
  /** Paren depth of the declaration, used to resolve unqualified columns to the right scope. */
  readonly depth: number;
}

export interface GuardAnalysis {
  readonly kind: string;
  readonly tenantTables: readonly string[];
  readonly violations: readonly string[];
  /** Literal-free rendering, safe to log. Parameters appear as `?`, never as their values. */
  readonly fingerprint: string;
  readonly shape: string;
}

/** Union-find over aliases, so `a.organization_id = b.organization_id` propagates scoping. */
class Groups {
  private readonly parent = new Map<string, string>();

  find(a: string): string {
    const p = this.parent.get(a);
    if (p === undefined || p === a) {
      this.parent.set(a, a);
      return a;
    }
    const root = this.find(p);
    this.parent.set(a, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function renderShape(tokens: readonly Token[]): string {
  return tokens
    .map((t) => (t.kind === 'literal' ? "'…'" : t.kind === 'number' ? 'N' : t.value))
    .join(' ')
    .slice(0, 500);
}

/**
 * Statically analyse one statement against one organization id.
 *
 * Exported separately from {@link assertTenantScoped} so the isolation corpus can assert
 * the analyser's verdicts directly, without needing a server for every case.
 */
export function analyzeStatement(
  sql: string,
  params: readonly unknown[],
  organizationId: string,
): GuardAnalysis {
  const tokens = tokenize(sql);
  const shape = renderShape(tokens);
  const fingerprint = createHash('sha256').update(shape).digest('hex').slice(0, 16);
  const violations: string[] = [];
  const kind = tokens[0]?.value ?? 'empty';

  const base = { kind, fingerprint, shape };

  if (tokens.length === 0) return { ...base, tenantTables: [], violations: [] };

  // `multipleStatements` is off on every pool this guard protects. If a second statement
  // ever appears, the analyser has only inspected the first — refuse rather than approve.
  const trailingSemicolon = tokens.findIndex(
    (t, index) => t.kind === 'punct' && t.value === ';' && index < tokens.length - 1,
  );
  if (trailingSemicolon !== -1) {
    return {
      ...base,
      tenantTables: [],
      violations: ['statement contains more than one SQL statement; only the first was analysed'],
    };
  }

  // ── Table references ───────────────────────────────────────────────────────
  const refs: TableRef[] = [];
  const consumedAsTable = new Set<number>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind !== 'word' || !TABLE_INTRODUCERS.has(token.value)) continue;

    let j = i + 1;
    for (;;) {
      // `from (select …) t` — a derived table, whose inner FROM is scanned on its own.
      const head = tokens[j];
      if (!head || head.kind !== 'word' || NON_ALIAS_WORDS.has(head.value)) break;

      let table = head.value;
      let end = j;
      // `schema.table`
      if (tokens[j + 1]?.value === '.' && tokens[j + 2]?.kind === 'word') {
        table = (tokens[j + 2] as Token).value;
        end = j + 2;
      }
      consumedAsTable.add(end);

      let alias = table;
      let next = end + 1;
      if (tokens[next]?.kind === 'word' && tokens[next]?.value === 'as') next += 1;
      const aliasToken = tokens[next];
      if (aliasToken?.kind === 'word' && !NON_ALIAS_WORDS.has(aliasToken.value)) {
        alias = aliasToken.value;
        end = next;
      }

      const tenantColumn = TENANT_TABLES[table];
      if (tenantColumn !== undefined) {
        refs.push({ table, alias, tenantColumn, depth: head.depth });
      }

      // Comma-joined table lists: `from projects p, work_items w`.
      if (tokens[end + 1]?.kind === 'punct' && tokens[end + 1]?.value === ',') {
        j = end + 2;
        continue;
      }
      break;
    }
  }

  const tenantTables = [...new Set(refs.map((r) => r.table))].sort();
  const declaredNames = new Set<string>(refs.flatMap((r) => [r.table, r.alias]));

  // Fail-closed safety net: a tenant table name that appears somewhere the reference
  // scanner did not understand means the statement's shape is beyond this analyser.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind !== 'word' || !isTenantTable(token.value)) continue;
    if (consumedAsTable.has(i)) continue;
    if (tokens[i - 1]?.value === '.') continue; // a column named like a table
    if (declaredNames.has(token.value)) continue; // used as its own implicit alias
    violations.push(
      `tenant table '${token.value}' appears in a position this guard cannot analyse; ` +
        `rewrite the statement or use an audited allowUnscoped escape`,
    );
  }

  if (refs.length === 0) {
    return { ...base, tenantTables, violations };
  }

  // ── Statement kinds that cannot carry a predicate ──────────────────────────
  const SCOPEABLE = new Set(['select', 'insert', 'replace', 'update', 'delete', 'with']);
  if (!SCOPEABLE.has(kind)) {
    violations.push(
      `'${kind}' cannot be tenant-scoped but touches ${tenantTables.join(', ')}; ` +
        `schema and bulk operations belong in a migration, not in application code`,
    );
    return { ...base, tenantTables, violations };
  }

  // ── Regions excluded from predicate scanning ───────────────────────────────
  // Anchors are only meaningful in predicates. A projected expression or an assignment
  // that happens to read `organization_id = ?` must never be mistaken for scoping.
  const excluded = new Set<number>();
  const excludeRange = (from: number, to: number): void => {
    for (let i = from; i <= to && i < tokens.length; i += 1) excluded.add(i);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if (token.kind !== 'word' || token.value !== 'select') continue;
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j] as Token;
      if (t.kind === 'word' && t.value === 'from' && t.depth === token.depth) break;
      j += 1;
    }
    excludeRange(i + 1, j - 1);
  }

  // UPDATE … SET … : assignments are excluded, and assigning the tenant column is a
  // violation in its own right. The database enforces this too (immutability trigger);
  // catching it here turns a runtime SIGNAL into a developer-time failure.
  if (kind === 'update') {
    const setIndex = tokens.findIndex(
      (t) => t.kind === 'word' && t.value === 'set' && t.depth === 0,
    );
    if (setIndex !== -1) {
      let end = tokens.length - 1;
      for (let i = setIndex + 1; i < tokens.length; i += 1) {
        const t = tokens[i] as Token;
        if (
          t.kind === 'word' &&
          t.depth === 0 &&
          (t.value === 'where' || t.value === 'order' || t.value === 'limit')
        ) {
          end = i - 1;
          break;
        }
      }
      for (let i = setIndex; i <= end; i += 1) {
        const t = tokens[i] as Token;
        if (t.kind === 'word' && (t.value === 'organization_id' || t.value === 'id')) {
          const owner = resolveOwner(refs, tokens, i);
          if (owner && owner.tenantColumn === t.value) {
            violations.push(
              `UPDATE assigns ${owner.table}.${t.value}; the tenant key is immutable ` +
                `(spec section 5) — move data between organizations through the audited workflow`,
            );
          }
        }
      }
      excludeRange(setIndex, end);
    }
  }

  // ON DUPLICATE KEY UPDATE is an assignment region with the same hazard.
  for (let i = 0; i < tokens.length - 2; i += 1) {
    if (
      tokens[i]?.value === 'on' &&
      tokens[i + 1]?.value === 'duplicate' &&
      tokens[i + 2]?.value === 'key'
    ) {
      for (let j = i + 3; j < tokens.length; j += 1) {
        const t = tokens[j] as Token;
        if (t.kind === 'word' && (t.value === 'organization_id' || t.value === 'id')) {
          const owner = resolveOwner(refs, tokens, j);
          if (owner && owner.tenantColumn === t.value) {
            violations.push(
              `ON DUPLICATE KEY UPDATE assigns ${owner.table}.${t.value}; the tenant key is immutable`,
            );
          }
        }
      }
      excludeRange(i + 3, tokens.length - 1);
      break;
    }
  }

  // ── INSERT / REPLACE ───────────────────────────────────────────────────────
  if (kind === 'insert' || kind === 'replace') {
    violations.push(...analyzeInsert(tokens, refs, params, organizationId, excluded));
  }

  // ── Predicate anchoring for everything that reads or narrows rows ──────────
  // An INSERT … SELECT still needs its SELECT half scoped, so this runs for inserts too.
  const hasReadHalf =
    kind !== 'insert' && kind !== 'replace'
      ? true
      : tokens.some((t) => t.kind === 'word' && t.value === 'select');

  if (hasReadHalf) {
    // The INSERT target has no predicate by nature — its scoping was checked above by
    // inspecting the written tenant key. Only the SELECT half is anchor-checked.
    const readRefs = kind === 'insert' || kind === 'replace' ? refs.slice(1) : refs;
    if (readRefs.length > 0) {
      violations.push(...analyzeAnchors(tokens, readRefs, params, organizationId, excluded));
    }
  }

  return { ...base, tenantTables, violations: [...new Set(violations)] };
}

/**
 * Which table a column reference belongs to.
 *
 * A qualified `p.organization_id` names its alias outright. An unqualified
 * `organization_id` resolves the way MySQL resolves it: to the tables declared in the
 * innermost enclosing scope, which is approximated here by paren depth. When more than one
 * candidate remains the reference is genuinely ambiguous — MySQL would reject it too — so
 * it anchors nothing.
 */
function resolveOwner(
  refs: readonly TableRef[],
  tokens: readonly Token[],
  index: number,
): TableRef | undefined {
  const qualifier =
    tokens[index - 1]?.value === '.' && tokens[index - 2]?.kind === 'word'
      ? tokens[index - 2]?.value
      : undefined;

  if (qualifier !== undefined) {
    return refs.find((r) => r.alias === qualifier || r.table === qualifier);
  }

  const depth = (tokens[index] as Token).depth;
  const sameDepth = refs.filter((r) => r.depth === depth);
  if (sameDepth.length === 1) return sameDepth[0];
  if (sameDepth.length > 1) return undefined;

  // No table declared at this depth: fall back to the nearest enclosing scope.
  const enclosing = refs.filter((r) => r.depth < depth);
  if (enclosing.length === 0) return undefined;
  const nearest = Math.max(...enclosing.map((r) => r.depth));
  const candidates = enclosing.filter((r) => r.depth === nearest);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function analyzeAnchors(
  tokens: readonly Token[],
  refs: readonly TableRef[],
  params: readonly unknown[],
  organizationId: string,
  excluded: ReadonlySet<number>,
): string[] {
  const violations: string[] = [];
  const groups = new Groups();
  const anchored = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    if (excluded.has(i)) continue;
    const token = tokens[i] as Token;
    if (token.kind !== 'word') continue;
    if (token.value !== 'organization_id' && token.value !== 'id') continue;

    const owner = resolveOwner(refs, tokens, i);
    if (!owner || owner.tenantColumn !== token.value) continue;

    const operator = tokens[i + 1];
    if (!operator || operator.kind !== 'punct') {
      // `IN (?, ?)` — every listed value must belong to the active organization.
      if (operator?.kind === 'word' && operator.value === 'in' && tokens[i + 2]?.value === '(') {
        const listed: Token[] = [];
        for (let j = i + 3; j < tokens.length; j += 1) {
          const t = tokens[j] as Token;
          if (t.kind === 'punct' && t.value === ')') break;
          if (t.kind === 'punct' && t.value === ',') continue;
          listed.push(t);
        }
        const allParams = listed.length > 0 && listed.every((t) => t.kind === 'param');
        if (!allParams) {
          violations.push(
            `${owner.table}.${owner.tenantColumn} IN (…) must list bound parameters only`,
          );
          continue;
        }
        const allMatch = listed.every((t) => params[t.paramIndex as number] === organizationId);
        if (!allMatch) {
          violations.push(
            `${owner.table}.${owner.tenantColumn} IN (…) includes an organization other than ` +
              `the active tenant context`,
          );
          continue;
        }
        anchored.add(groups.find(owner.alias));
      }
      continue;
    }

    if (operator.value !== '=' && operator.value !== '<=>') continue;

    const rhs = tokens[i + 2];
    if (!rhs) continue;

    if (rhs.kind === 'param') {
      const bound = params[rhs.paramIndex as number];
      if (bound === organizationId) {
        anchored.add(groups.find(owner.alias));
      } else {
        violations.push(
          `${owner.table}.${owner.tenantColumn} is bound to a value that is not the active ` +
            `tenant context; a repository must derive the organization from TenantContext`,
        );
      }
      continue;
    }

    if (rhs.kind === 'literal' || rhs.kind === 'number') {
      violations.push(
        `${owner.table}.${owner.tenantColumn} is compared to an inline literal; tenant ` +
          `predicates must be bound parameters (spec section 5)`,
      );
      continue;
    }

    if (rhs.kind === 'word') {
      // Join equality: `a.organization_id = b.organization_id` (or `= o.id`). The right
      // side is either a bare column at i+2 or a qualified one whose column sits at i+4.
      const rhsIndex = tokens[i + 3]?.value === '.' ? i + 4 : i + 2;
      const rhsToken = tokens[rhsIndex];
      if (!rhsToken || rhsToken.kind !== 'word') continue;
      const other = resolveOwner(refs, tokens, rhsIndex);
      if (other && other.tenantColumn === rhsToken.value && other.alias !== owner.alias) {
        groups.union(owner.alias, other.alias);
      }
    }
  }

  // Re-resolve roots after all unions, then require every referenced tenant table to sit
  // in a group that is anchored to the active organization.
  const anchoredRoots = new Set([...anchored].map((a) => groups.find(a)));
  const unscoped = refs.filter((r) => !anchoredRoots.has(groups.find(r.alias)));
  for (const ref of [...new Map(unscoped.map((r) => [r.alias, r])).values()]) {
    violations.push(
      `no organization_id predicate binds ${ref.table}` +
        (ref.alias === ref.table ? '' : ` (alias ${ref.alias})`) +
        ` to the active tenant context`,
    );
  }

  return violations;
}

/**
 * An INSERT has no WHERE to inspect, so scoping means something different: the row being
 * written must *carry* the active organization id. Spec section 6 — "Mutation repositories
 * derive organization_id from TenantContext, never from the DTO" — is what this enforces
 * mechanically.
 */
function analyzeInsert(
  tokens: readonly Token[],
  refs: readonly TableRef[],
  params: readonly unknown[],
  organizationId: string,
  excluded: Set<number>,
): string[] {
  const violations: string[] = [];
  const target = refs[0];
  if (!target) return violations;

  const intoIndex = tokens.findIndex((t) => t.kind === 'word' && t.value === 'into');
  const setIndex = tokens.findIndex((t) => t.kind === 'word' && t.value === 'set' && t.depth === 0);

  // `INSERT … SET col = value` form.
  if (setIndex !== -1) {
    let matched = false;
    for (let i = setIndex + 1; i < tokens.length; i += 1) {
      const t = tokens[i] as Token;
      if (t.kind !== 'word' || t.value !== target.tenantColumn) continue;
      if (tokens[i + 1]?.value !== '=') continue;
      const rhs = tokens[i + 2];
      if (rhs?.kind !== 'param') {
        violations.push(
          `INSERT … SET ${target.table}.${target.tenantColumn} must be a bound parameter`,
        );
      } else if (params[rhs.paramIndex as number] !== organizationId) {
        violations.push(
          `INSERT into ${target.table} writes an organization other than the active ` +
            `tenant context`,
        );
      } else {
        matched = true;
      }
      excluded.add(i);
    }
    if (!matched && violations.length === 0) {
      violations.push(`INSERT into ${target.table} does not set ${target.tenantColumn}`);
    }
    return violations;
  }

  // `INSERT … (cols) VALUES (…)` / `INSERT … (cols) SELECT …`
  const openParen = tokens.findIndex(
    (t, index) => index > intoIndex && t.kind === 'punct' && t.value === '(',
  );
  if (openParen === -1) {
    violations.push(
      `INSERT into ${target.table} has no explicit column list; positional inserts into ` +
        `tenant tables are not reviewable`,
    );
    return violations;
  }

  const columns: string[] = [];
  let closeParen = -1;
  for (let i = openParen + 1; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'punct' && t.value === ')') {
      closeParen = i;
      break;
    }
    if (t.kind === 'word') columns.push(t.value);
  }

  const columnIndex = columns.indexOf(target.tenantColumn);
  if (columnIndex === -1) {
    violations.push(
      `INSERT into ${target.table} omits ${target.tenantColumn}; the tenant key is never ` +
        `optional on a tenant-owned table`,
    );
    return violations;
  }

  // The column list is not a predicate region.
  for (let i = openParen; i <= closeParen; i += 1) excluded.add(i);

  const valuesIndex = tokens.findIndex(
    (t, index) =>
      index > closeParen && t.kind === 'word' && (t.value === 'values' || t.value === 'value'),
  );

  if (valuesIndex === -1) {
    // `INSERT … SELECT …`: the value cannot be read statically, so the SELECT half must be
    // tenant-scoped and is checked by analyzeAnchors. Recorded here so the limitation is
    // visible rather than implied.
    const selectIndex = tokens.findIndex(
      (t, index) => index > closeParen && t.kind === 'word' && t.value === 'select',
    );
    if (selectIndex === -1) {
      violations.push(`INSERT into ${target.table} has neither VALUES nor SELECT`);
    }
    return violations;
  }

  // Walk each `( … )` tuple and check the value sitting at the tenant column's position.
  //
  // Only the *first* token of the value at that position is inspected: a value can be a
  // multi-token expression such as `uuid()` or `? + 1`, and re-entering the check for each
  // of its tokens would report the same problem repeatedly and, worse, read a later
  // column's parameter. Tuple boundaries are matched by paren depth, so nested calls do
  // not shift the column count.
  let tupleStart = -1;
  let tupleDepth = 0;
  let position = 0;
  let valueChecked = false;
  let tupleCount = 0;

  for (let i = valuesIndex + 1; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'punct' && t.value === '(' && tupleStart === -1) {
      tupleStart = i;
      tupleDepth = t.depth;
      position = 0;
      valueChecked = false;
      tupleCount += 1;
      continue;
    }
    if (tupleStart === -1) continue;
    if (t.kind === 'punct' && t.value === ')' && t.depth === tupleDepth) {
      tupleStart = -1;
      continue;
    }
    if (t.kind === 'punct' && t.value === ',' && t.depth === tupleDepth) {
      position += 1;
      valueChecked = false;
      continue;
    }
    if (position !== columnIndex || valueChecked) continue;
    valueChecked = true;

    if (t.kind === 'param') {
      if (params[t.paramIndex as number] !== organizationId) {
        violations.push(
          `INSERT into ${target.table} writes an organization other than the active ` +
            `tenant context`,
        );
      }
    } else if (t.kind === 'literal') {
      violations.push(
        `INSERT into ${target.table} supplies ${target.tenantColumn} as an inline literal; ` +
          `it must be a bound parameter derived from TenantContext`,
      );
    } else if (t.kind === 'word') {
      violations.push(
        `INSERT into ${target.table} supplies ${target.tenantColumn} from expression ` +
          `'${t.value}', which the guard cannot verify against the active tenant context`,
      );
    }
  }

  if (tupleCount === 0) {
    violations.push(`INSERT into ${target.table} has a VALUES keyword but no value tuple`);
  }

  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement
// ─────────────────────────────────────────────────────────────────────────────

export type TenantGuardMode = 'enforce' | 'observe';

/**
 * Safe metadata only. `shape` has every string literal collapsed and every parameter left
 * as `?`, so a guard event can be logged in production without carrying tenant data into
 * the log pipeline.
 */
export interface TenantGuardEvent {
  readonly organizationId: string;
  readonly correlationId: string;
  readonly mode: TenantGuardMode;
  readonly statementKind: string;
  readonly tenantTables: readonly string[];
  readonly violations: readonly string[];
  readonly fingerprint: string;
  readonly shape: string;
  /** Present only for an audited `allowUnscoped` escape. */
  readonly allowedReason?: string;
}

export class TenantGuardViolation extends Error {
  constructor(
    readonly event: TenantGuardEvent,
    readonly sql: string,
  ) {
    super(
      `Tenant guard rejected a statement touching ` +
        `${event.tenantTables.join(', ') || '(no tenant table)'}:\n` +
        event.violations.map((v) => `  - ${v}`).join('\n') +
        `\n  statement: ${event.shape}` +
        `\n  MySQL has no row-level security: without an organization_id predicate this ` +
        `statement would read or write every tenant's rows (ADR-0001 layer 3).`,
    );
    this.name = 'TenantGuardViolation';
  }
}

export interface TenantGuardOptions {
  readonly mode: TenantGuardMode;
  /** Security-event sink. Called for every violation, in both modes. */
  readonly onEvent?: (event: TenantGuardEvent) => void;
  /**
   * A deliberate, reviewed cross-tenant statement — the outbox relay, a migration-time
   * repair, an owner support command. The reason is mandatory and is recorded, so an
   * escape is visible in the audit trail rather than being a silent bypass.
   */
  readonly allowUnscoped?: { readonly reason: string };
}

export interface GuardedContext {
  readonly organizationId: string;
  readonly correlationId: string;
}

/**
 * Throw (or, in `observe`, record) when a statement is not bound to the active tenant.
 *
 * Production defaults to `enforce`. ADR-0001 argues why: logging and serving means the
 * first occurrence of the bug is also a live data leak, and a 500 is recoverable where a
 * cross-tenant disclosure is not. `observe` exists for a documented incident and is set
 * through `TENANT_GUARD_MODE`, never by code.
 */
export function assertTenantScoped(
  sql: string,
  params: readonly unknown[],
  context: GuardedContext,
  options: TenantGuardOptions,
): GuardAnalysis {
  const analysis = analyzeStatement(sql, params, context.organizationId);

  if (options.allowUnscoped) {
    const reason = options.allowUnscoped.reason.trim();
    if (reason.length < 10) {
      throw new TypeError(
        'allowUnscoped requires a substantive reason string; it is recorded as a security event',
      );
    }
    if (analysis.tenantTables.length > 0) {
      options.onEvent?.({
        organizationId: context.organizationId,
        correlationId: context.correlationId,
        mode: options.mode,
        statementKind: analysis.kind,
        tenantTables: analysis.tenantTables,
        violations: analysis.violations,
        fingerprint: analysis.fingerprint,
        shape: analysis.shape,
        allowedReason: reason,
      });
    }
    return analysis;
  }

  if (analysis.violations.length === 0) return analysis;

  const event: TenantGuardEvent = {
    organizationId: context.organizationId,
    correlationId: context.correlationId,
    mode: options.mode,
    statementKind: analysis.kind,
    tenantTables: analysis.tenantTables,
    violations: analysis.violations,
    fingerprint: analysis.fingerprint,
    shape: analysis.shape,
  };

  options.onEvent?.(event);

  if (options.mode === 'enforce') throw new TenantGuardViolation(event, sql);
  return analysis;
}
