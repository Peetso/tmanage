import { describe, expect, it } from 'vitest';

import {
  DUMP_END_MARKER,
  dumpDatabase,
  isGeneratedColumn,
  orderViews,
  sqlValue,
  stringLiteral,
  stripDefiner,
  valueKind,
} from './backup-dump.js';
import type { DumpCounts, DumpSource } from './backup-dump.js';

const b = (s: string): Buffer => Buffer.from(s, 'utf8');

function fakeSource(overrides: Partial<DumpSource> = {}): DumpSource {
  return {
    database: 'u1_tmanage',
    serverVersion: '11.8.3-MariaDB-log',
    baseTables: () => Promise.resolve(['work_items', 'files']),
    views: () => Promise.resolve([]),
    columns: (table) =>
      Promise.resolve(
        table === 'work_items'
          ? [
              { name: 'id', dataType: 'char', extra: '' },
              { name: 'n', dataType: 'bigint', extra: '' },
              { name: 'title', dataType: 'varchar', extra: '' },
              { name: 'title_lower', dataType: 'varchar', extra: 'VIRTUAL GENERATED' },
              { name: 'created_at', dataType: 'datetime', extra: 'DEFAULT_GENERATED' },
            ]
          : [
              { name: 'id', dataType: 'char', extra: '' },
              { name: 'sha', dataType: 'binary', extra: '' },
            ],
      ),
    createTable: (table) => Promise.resolve(`CREATE TABLE \`${table}\` (x int)`),
    routines: () => Promise.resolve([]),
    events: () => Promise.resolve([]),
    triggers: () => Promise.resolve([]),
    rows: (table) =>
      (async function* () {
        if (table === 'work_items') {
          yield [
            b('w1'),
            b('9007199254740993'),
            b('O\'Brien \\ "x"\n'),
            b('2026-11-20 03:00:00.123'),
          ];
          yield [b('w2'), null, b('ü'), b('2026-11-20 03:00:01.000')];
        } else {
          yield [b('f1'), Buffer.from([0x00, 0xff, 0x27])];
        }
      })(),
    ...overrides,
  };
}

async function dumpText(
  source: DumpSource,
  maxStatementBytes?: number,
): Promise<{ text: string; counts: DumpCounts }> {
  const counts: DumpCounts = { tables: 0, rows: 0, views: 0, routines: 0, events: 0, triggers: 0 };
  const parts: Buffer[] = [];
  for await (const chunk of dumpDatabase(source, counts, {
    now: new Date('2026-11-20T03:00:00Z'),
    ...(maxStatementBytes === undefined ? {} : { maxStatementBytes }),
  })) {
    parts.push(chunk);
  }
  return { text: Buffer.concat(parts).toString('utf8'), counts };
}

describe('value encoding (byte-faithful, MariaDB and MySQL)', () => {
  it('escapes exactly what mysql_real_escape_string escapes', () => {
    expect(
      stringLiteral(Buffer.from([0x61, 0x00, 0x0a, 0x0d, 0x1a, 0x22, 0x27, 0x5c, 0x62])).toString(
        'latin1',
      ),
    ).toBe(`'a\\0\\n\\r\\Z\\"\\'\\\\b'`);
  });

  it('writes binary as hex, numbers bare, dates and text quoted, NULL as NULL', () => {
    expect(sqlValue(Buffer.from([0xde, 0xad]), 'binary').toString()).toBe('0xdead');
    expect(sqlValue(Buffer.alloc(0), 'binary').toString()).toBe("''");
    expect(sqlValue(b('9007199254740993'), 'number').toString()).toBe('9007199254740993');
    expect(sqlValue(b('-12.50'), 'number').toString()).toBe('-12.50');
    expect(sqlValue(b('1e-7'), 'number').toString()).toBe('1e-7');
    expect(sqlValue(b('2026-11-20 03:00:00.123'), 'text').toString()).toBe(
      "'2026-11-20 03:00:00.123'",
    );
    expect(sqlValue(null, 'text').toString()).toBe('NULL');
    // A value that does not look like a number is quoted, never written bare.
    expect(sqlValue(b('1; DROP TABLE x'), 'number').toString()).toBe("'1; DROP TABLE x'");
  });

  it('classifies column types', () => {
    for (const t of ['varbinary', 'longblob', 'bit', 'geometry', 'BINARY'])
      expect(valueKind(t)).toBe('binary');
    for (const t of ['int', 'bigint', 'decimal', 'double', 'year'])
      expect(valueKind(t)).toBe('number');
    for (const t of ['varchar', 'longtext', 'json', 'datetime', 'timestamp', 'enum', 'uuid']) {
      expect(valueKind(t)).toBe('text');
    }
  });

  it('leaves out computed columns but keeps MySQL expression defaults', () => {
    expect(isGeneratedColumn('VIRTUAL GENERATED')).toBe(true);
    expect(isGeneratedColumn('STORED GENERATED')).toBe(true);
    expect(isGeneratedColumn('PERSISTENT')).toBe(true);
    expect(isGeneratedColumn('DEFAULT_GENERATED')).toBe(false);
    expect(isGeneratedColumn('DEFAULT_GENERATED on update CURRENT_TIMESTAMP')).toBe(false);
    expect(isGeneratedColumn('auto_increment')).toBe(false);
    expect(isGeneratedColumn('')).toBe(false);
  });

  it('strips definers in every form', () => {
    expect(stripDefiner('CREATE DEFINER=`u1`@`localhost` TRIGGER t')).toBe('CREATE TRIGGER t');
    expect(stripDefiner('CREATE ALGORITHM=UNDEFINED /*!50017 DEFINER=`a`@`%` */ VIEW v')).toBe(
      'CREATE ALGORITHM=UNDEFINED VIEW v',
    );
    expect(stripDefiner('CREATE DEFINER=CURRENT_USER PROCEDURE p()')).toBe('CREATE PROCEDURE p()');
  });
});

describe('dumpDatabase', () => {
  it('writes the header, each table with its stored columns and rows, and the end marker', async () => {
    const { text, counts } = await dumpText(fakeSource());
    expect(
      text.startsWith(
        '-- TManage logical dump (OFFSITE-BACKUP) of `u1_tmanage`, server 11.8.3-MariaDB-log',
      ),
    ).toBe(true);
    expect(text).toContain(
      "SET NAMES utf8mb4;\nSET TIME_ZONE='+00:00';\nSET FOREIGN_KEY_CHECKS=0;",
    );
    expect(text).toContain("SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';");
    // Tables in name order, generated column left out of the column list.
    expect(text.indexOf('CREATE TABLE `files`')).toBeLessThan(
      text.indexOf('CREATE TABLE `work_items`'),
    );
    expect(text).toContain(
      "INSERT INTO `work_items` (`id`,`n`,`title`,`created_at`) VALUES ('w1',9007199254740993,'O\\'Brien \\\\ \\\"x\\\"\\n','2026-11-20 03:00:00.123'),('w2',NULL,'ü','2026-11-20 03:00:01.000');",
    );
    expect(text).toContain("INSERT INTO `files` (`id`,`sha`) VALUES ('f1',0x00ff27);");
    expect(text).not.toContain('title_lower');
    expect(text.trimEnd().endsWith(DUMP_END_MARKER)).toBe(true);
    expect(counts).toMatchObject({ tables: 2, rows: 3 });
  });

  it('splits a long table into INSERTs under the statement cap', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [
      b(`id-${String(i).padStart(3, '0')}`),
      b('x'.repeat(40)),
    ]);
    const source = fakeSource({
      baseTables: () => Promise.resolve(['t']),
      columns: () =>
        Promise.resolve([
          { name: 'id', dataType: 'varchar', extra: '' },
          { name: 'v', dataType: 'text', extra: '' },
        ]),
      rows: () =>
        (async function* () {
          yield* rows;
        })(),
    });
    const { text, counts } = await dumpText(source, 500);
    const inserts = text.split('\n').filter((l) => l.startsWith('INSERT INTO'));
    expect(inserts.length).toBeGreaterThan(5);
    for (const l of inserts) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(500 + 40);
    expect(inserts.join('').match(/\('id-/gu)?.length).toBe(50);
    expect(counts.rows).toBe(50);
  });

  it('writes triggers last, under DELIMITER ;; and their own sql_mode, without definers', async () => {
    const source = fakeSource({
      triggers: () =>
        Promise.resolve([
          {
            name: 'trg_no_update',
            statement:
              "CREATE DEFINER=`u1`@`localhost` TRIGGER trg_no_update BEFORE UPDATE ON audit_events FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000'; END",
            sqlMode: 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION',
          },
        ]),
      routines: () =>
        Promise.resolve([
          {
            name: 'p1',
            kind: 'PROCEDURE',
            statement: 'CREATE DEFINER=`u1`@`%` PROCEDURE `p1`() BEGIN SELECT 1; END',
            sqlMode: '',
          },
        ]),
    });
    const { text, counts } = await dumpText(source);
    const delimiter = text.indexOf('DELIMITER ;;');
    expect(delimiter).toBeGreaterThan(text.lastIndexOf('INSERT INTO'));
    expect(text).toContain(
      "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION';;\nDROP TRIGGER IF EXISTS `trg_no_update`;;\nCREATE TRIGGER trg_no_update BEFORE UPDATE ON audit_events FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000'; END;;",
    );
    expect(text.indexOf('PROCEDURE `p1`')).toBeLessThan(text.indexOf('TRIGGER trg_no_update'));
    expect(text).not.toContain('DEFINER');
    expect(text).toContain('DELIMITER ;\n');
    expect(counts).toMatchObject({ triggers: 1, routines: 1 });
  });

  it('fails instead of writing a table it cannot read columns for', async () => {
    const source = fakeSource({ columns: () => Promise.resolve([]) });
    await expect(dumpText(source)).rejects.toThrow(/no stored columns/u);
  });

  it('fails when a row does not match the column list', async () => {
    const source = fakeSource({
      rows: () =>
        (async function* () {
          yield [b('only-one')];
        })(),
    });
    await expect(dumpText(source)).rejects.toThrow(/expected/u);
  });
});

describe('orderViews', () => {
  it('puts a view after the views it selects from', () => {
    const ordered = orderViews([
      { name: 'a_top', statement: 'CREATE VIEW `a_top` AS SELECT * FROM `b_mid`' },
      { name: 'b_mid', statement: 'CREATE VIEW `b_mid` AS SELECT * FROM `c_base`' },
      { name: 'c_base', statement: 'CREATE VIEW `c_base` AS SELECT 1' },
    ]);
    expect(ordered.map((v) => v.name)).toEqual(['c_base', 'b_mid', 'a_top']);
  });
});
