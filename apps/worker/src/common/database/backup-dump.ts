/**
 * OFFSITE-BACKUP. A logical dump of the database written by Node itself, so the backup needs no
 * `mysqldump` / `mariadb-dump` binary on the host (Hostinger shared hosting gives the Node app
 * no root, and which client binaries its sandbox carries, and in which version, is not under our
 * control; a MySQL 8 `mysqldump` against MariaDB 11.8 also needs flags a MariaDB one rejects).
 *
 * The output is what `mysqldump --single-transaction --hex-blob --routines --triggers --events
 * --skip-lock-tables --no-tablespaces` writes, in the form the `mysql`/`mariadb` client replays
 * (`scripts/ops/restore.mjs`):
 *
 * 1. a session header (`SET NAMES utf8mb4`, UTC, no FK / unique checks, `NO_AUTO_VALUE_ON_ZERO`);
 * 2. per base table, `DROP TABLE IF EXISTS` + its `SHOW CREATE TABLE` + multi-row `INSERT`s of
 *    the stored columns (generated columns are left out: the server recomputes them);
 * 3. views, in dependency order;
 * 4. routines, events and triggers inside `DELIMITER ;;`, each under the `sql_mode` it was created
 *    with; triggers last, so loading the rows fires none of them;
 * 5. a closing marker line, so a truncated replay is visible.
 *
 * Values are read with `typeCast: false`, i.e. as the exact bytes the server sends, and written
 * back without decoding: binary types as `0x…` hex, numbers as they are, everything else as an
 * escaped string literal. A date is never turned into a JS `Date`, a DECIMAL never into a float,
 * a BIGINT never into a lossy number, so the dump is byte-faithful on MariaDB and MySQL alike.
 * `DEFINER=` clauses are dropped, because shared hosting cannot restore another user's definer.
 */

/** One column of a base table, from `information_schema.COLUMNS`. */
export interface DumpColumn {
  readonly name: string;
  /** `DATA_TYPE`, e.g. `varchar`, `longblob`, `decimal`. */
  readonly dataType: string;
  /** `EXTRA`, e.g. `auto_increment`, `VIRTUAL GENERATED`, `DEFAULT_GENERATED`. */
  readonly extra: string;
}

export interface DumpObject {
  readonly name: string;
  readonly statement: string;
  /** The `sql_mode` the object was created under (routines, events, triggers). */
  readonly sqlMode?: string;
}

export interface DumpRoutine extends DumpObject {
  readonly kind: 'PROCEDURE' | 'FUNCTION';
}

/** The read side of a dump: implemented on a consistent-snapshot connection in `backup-store.ts`. */
export interface DumpSource {
  readonly database: string;
  readonly serverVersion: string;
  baseTables(): Promise<readonly string[]>;
  views(): Promise<readonly DumpObject[]>;
  columns(table: string): Promise<readonly DumpColumn[]>;
  createTable(table: string): Promise<string>;
  routines(): Promise<readonly DumpRoutine[]>;
  events(): Promise<readonly DumpObject[]>;
  triggers(): Promise<readonly DumpObject[]>;
  /** The values of `columns`, in that order, as raw bytes (`null` for SQL NULL). */
  rows(table: string, columns: readonly string[]): AsyncIterable<readonly (Buffer | null)[]>;
}

export const DUMP_END_MARKER = '-- TManage dump complete';

/** One INSERT carries rows up to this many bytes (a single larger row gets its own INSERT). */
export const DEFAULT_MAX_STATEMENT_BYTES = 1024 * 1024;

const BINARY_TYPES = new Set([
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'bit',
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'geomcollection',
  'vector',
]);

const NUMERIC_TYPES = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'bigint',
  'decimal',
  'numeric',
  'float',
  'double',
  'real',
  'year',
]);

export type ValueKind = 'binary' | 'number' | 'text';

export function valueKind(dataType: string): ValueKind {
  const t = dataType.toLowerCase();
  if (BINARY_TYPES.has(t)) return 'binary';
  if (NUMERIC_TYPES.has(t)) return 'number';
  return 'text';
}

/**
 * A stored column, or one the server computes. MySQL marks expression defaults
 * `DEFAULT_GENERATED`, which IS stored and must be dumped; only `VIRTUAL GENERATED`,
 * `STORED GENERATED` (both engines) and MariaDB's older `PERSISTENT` are computed.
 */
export function isGeneratedColumn(extra: string): boolean {
  return /(?:^|\s)(?:VIRTUAL|STORED) GENERATED(?:\s|$)|(?:^|\s)PERSISTENT(?:\s|$)/iu.test(extra);
}

/** A backquoted identifier; a backquote inside the name is doubled. */
export function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/gu, '``')}\``;
}

const NUMBER_TEXT = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u;

const ESCAPES: Readonly<Record<number, string>> = {
  0x00: '\\0',
  0x0a: '\\n',
  0x0d: '\\r',
  0x1a: '\\Z',
  0x22: '\\"',
  0x27: "\\'",
  0x5c: '\\\\',
};

/** A quoted string literal over raw bytes, escaped as `mysql_real_escape_string` does. */
export function stringLiteral(bytes: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from("'")];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const escape = ESCAPES[bytes[i] ?? -1];
    if (escape === undefined) continue;
    if (i > start) parts.push(bytes.subarray(start, i));
    parts.push(Buffer.from(escape));
    start = i + 1;
  }
  if (start < bytes.length) parts.push(bytes.subarray(start));
  parts.push(Buffer.from("'"));
  return Buffer.concat(parts);
}

/** One value as SQL: `NULL`, `0x…`, a bare number, or an escaped string. */
export function sqlValue(value: Buffer | null, kind: ValueKind): Buffer {
  if (value === null) return Buffer.from('NULL');
  if (kind === 'binary') {
    return value.length === 0 ? Buffer.from("''") : Buffer.from(`0x${value.toString('hex')}`);
  }
  if (kind === 'number' && NUMBER_TEXT.test(value.toString('latin1'))) return value;
  return stringLiteral(value);
}

/** Drops `DEFINER=…` (plain or inside a `/*!50017 … *\/` comment) from a CREATE statement. */
export function stripDefiner(statement: string): string {
  return statement
    .replace(/\/\*!\d+ DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*`\s*\*\/ ?/gu, '')
    .replace(/DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*` ?/gu, '')
    .replace(/DEFINER=CURRENT_USER(?:\(\))? ?/giu, '');
}

/** Views ordered so each comes after the views its definition names. */
export function orderViews(views: readonly DumpObject[]): readonly DumpObject[] {
  const byName = new Map(views.map((v) => [v.name, v]));
  const done = new Set<string>();
  const out: DumpObject[] = [];
  const visit = (view: DumpObject, path: Set<string>): void => {
    if (done.has(view.name) || path.has(view.name)) return;
    path.add(view.name);
    for (const other of byName.values()) {
      if (other.name !== view.name && view.statement.includes(quoteIdentifier(other.name))) {
        visit(other, path);
      }
    }
    done.add(view.name);
    out.push(view);
  };
  for (const view of [...views].sort((a, b) => (a.name < b.name ? -1 : 1))) visit(view, new Set());
  return out;
}

const line = (text: string): Buffer => Buffer.from(`${text}\n`, 'utf8');

const HEADER = [
  'SET NAMES utf8mb4;',
  "SET TIME_ZONE='+00:00';",
  'SET FOREIGN_KEY_CHECKS=0;',
  'SET UNIQUE_CHECKS=0;',
  "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';",
  'SET SQL_NOTES=0;',
];

const FOOTER = ['SET UNIQUE_CHECKS=1;', 'SET FOREIGN_KEY_CHECKS=1;', 'SET SQL_NOTES=1;'];

/** Escapes a value for a single-quoted `SET SESSION sql_mode = '…'`. */
const modeLiteral = (mode: string): string => `'${mode.replace(/[\\']/gu, (c) => `\\${c}`)}'`;

export interface DumpOptions {
  readonly maxStatementBytes?: number;
  readonly now?: Date;
}

export interface DumpCounts {
  tables: number;
  rows: number;
  views: number;
  routines: number;
  events: number;
  triggers: number;
}

/**
 * The dump as a stream of byte chunks. `counts` is filled in as the dump proceeds and is final
 * once the iterator has finished.
 */
export async function* dumpDatabase(
  source: DumpSource,
  counts: DumpCounts,
  options: DumpOptions = {},
): AsyncGenerator<Buffer> {
  const maxBytes = options.maxStatementBytes ?? DEFAULT_MAX_STATEMENT_BYTES;
  const at = (options.now ?? new Date()).toISOString();
  yield line(
    `-- TManage logical dump (OFFSITE-BACKUP) of ${quoteIdentifier(source.database)}, server ${source.serverVersion.replace(/[\r\n]/gu, ' ')}, taken ${at}`,
  );
  for (const h of HEADER) yield line(h);

  for (const table of [...(await source.baseTables())].sort()) {
    const q = quoteIdentifier(table);
    yield line('');
    yield line(`DROP TABLE IF EXISTS ${q};`);
    yield line(`${(await source.createTable(table)).trimEnd()};`);
    const stored = (await source.columns(table)).filter((c) => !isGeneratedColumn(c.extra));
    if (stored.length === 0) throw new Error(`table ${table} reports no stored columns`);
    const kinds = stored.map((c) => valueKind(c.dataType));
    const prefix = Buffer.from(
      `INSERT INTO ${q} (${stored.map((c) => quoteIdentifier(c.name)).join(',')}) VALUES `,
    );
    let batch: Buffer[] = [];
    let batchBytes = 0;
    for await (const row of source.rows(
      table,
      stored.map((c) => c.name),
    )) {
      if (row.length !== kinds.length) {
        throw new Error(
          `table ${table}: a row has ${String(row.length)} values, expected ${String(kinds.length)}`,
        );
      }
      const values: Buffer[] = [Buffer.from('(')];
      row.forEach((value, i) => {
        if (i > 0) values.push(Buffer.from(','));
        values.push(sqlValue(value, kinds[i] ?? 'text'));
      });
      values.push(Buffer.from(')'));
      const tuple = Buffer.concat(values);
      if (batch.length > 0 && batchBytes + tuple.length + 1 > maxBytes) {
        yield Buffer.concat([prefix, ...batch, Buffer.from(';\n')]);
        batch = [];
        batchBytes = 0;
      }
      if (batch.length > 0) {
        batch.push(Buffer.from(','));
        batchBytes += 1;
      }
      batch.push(tuple);
      batchBytes += tuple.length;
      counts.rows += 1;
    }
    if (batch.length > 0) yield Buffer.concat([prefix, ...batch, Buffer.from(';\n')]);
    counts.tables += 1;
  }

  for (const view of orderViews(await source.views())) {
    yield line('');
    yield line(`DROP VIEW IF EXISTS ${quoteIdentifier(view.name)};`);
    yield line(`${stripDefiner(view.statement).trimEnd()};`);
    counts.views += 1;
  }

  const routines = await source.routines();
  const events = await source.events();
  const triggers = await source.triggers();
  if (routines.length + events.length + triggers.length > 0) {
    yield line('');
    yield line('DELIMITER ;;');
    const program = (kind: string, objects: readonly DumpObject[]): Buffer[] =>
      objects.map((o) =>
        Buffer.from(
          [
            ...(o.sqlMode === undefined
              ? []
              : [`SET SESSION sql_mode = ${modeLiteral(o.sqlMode)};;`]),
            `DROP ${kind} IF EXISTS ${quoteIdentifier(o.name)};;`,
            `${stripDefiner(o.statement).trimEnd()};;`,
            '',
          ].join('\n'),
          'utf8',
        ),
      );
    for (const kind of ['PROCEDURE', 'FUNCTION'] as const) {
      for (const chunk of program(
        kind,
        routines.filter((r) => r.kind === kind),
      )) {
        yield chunk;
      }
    }
    for (const chunk of program('EVENT', events)) yield chunk;
    for (const chunk of program('TRIGGER', triggers)) yield chunk;
    yield line("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO';;");
    yield line('DELIMITER ;');
    counts.routines = routines.length;
    counts.events = events.length;
    counts.triggers = triggers.length;
  }

  yield line('');
  for (const f of FOOTER) yield line(f);
  yield line(DUMP_END_MARKER);
}
