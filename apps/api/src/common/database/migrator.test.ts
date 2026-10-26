import { describe, expect, it } from 'vitest';
import { isAlreadyExistsError, isDataStatement, splitStatements } from './migrator.js';

/**
 * Statement splitting, tested without a server.
 *
 * Every case here is one that `sql.split(';')` gets wrong, and all but the last occur in
 * `0001_tenancy.sql` — which is why the migrator carries a scanner instead of a split.
 */
describe('splitStatements', () => {
  it('splits ordinary statements', () => {
    expect(splitStatements('select 1;\nselect 2;\n')).toEqual(['select 1', 'select 2']);
  });

  it('tolerates a missing trailing semicolon', () => {
    expect(splitStatements('select 1')).toEqual(['select 1']);
  });

  it('ignores semicolons inside string literals', () => {
    expect(splitStatements(`insert into t values ('a;b');`)).toEqual([
      `insert into t values ('a;b')`,
    ]);
  });

  it('ignores semicolons inside escaped and doubled quotes', () => {
    expect(splitStatements(`select 'it''s; fine';`)).toEqual([`select 'it''s; fine'`]);
    expect(splitStatements(`select 'a\\'; b';`)).toEqual([`select 'a\\'; b'`]);
  });

  it('ignores semicolons inside comments and drops the comments', () => {
    expect(splitStatements('select 1; -- a; comment\nselect 2;')).toEqual(['select 1', 'select 2']);
    expect(splitStatements('select 1; # a; comment\nselect 2;')).toEqual(['select 1', 'select 2']);
    expect(splitStatements('select /* a; b */ 1;')).toEqual(['select  1']);
  });

  it('preserves backtick-quoted identifiers, semicolons and all', () => {
    expect(splitStatements('select `we;ird` from t;')).toEqual(['select `we;ird` from t']);
  });

  it('honours DELIMITER so a trigger body stays one statement', () => {
    const sql = `
CREATE TABLE t (a INT);

DELIMITER $$
CREATE TRIGGER trg BEFORE UPDATE ON t FOR EACH ROW
BEGIN
  IF NEW.a <> OLD.a THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no';
  END IF;
END$$
DELIMITER ;

CREATE INDEX ix ON t (a);
`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe('CREATE TABLE t (a INT)');
    expect(statements[1]).toContain('END IF;');
    expect(statements[1]?.endsWith('END')).toBe(true);
    expect(statements[2]).toBe('CREATE INDEX ix ON t (a)');
  });

  it('drops empty fragments rather than emitting blank statements', () => {
    expect(splitStatements(';;\n\n  ;\nselect 1;;')).toEqual(['select 1']);
  });

  it('does not treat a column named delimiter as a directive', () => {
    expect(splitStatements('select delimiter from t;')).toEqual(['select delimiter from t']);
  });
});

/**
 * The two classifiers the resume of a killed run depends on (migrator.ts, "`running` rows").
 * The behaviour against a real server is in test/migrator-resume.db.test.ts.
 */
describe('isAlreadyExistsError', () => {
  it('accepts exactly the "object already exists" server errors', () => {
    for (const errno of [1050, 1060, 1061, 1022, 1826, 1304, 1359]) {
      expect(isAlreadyExistsError(Object.assign(new Error('x'), { errno }))).toBe(true);
    }
  });

  it('rejects every other error, and anything that is not a server error', () => {
    // 1062 duplicate entry (a data error), 1146 no such table, 1064 syntax.
    for (const errno of [1062, 1146, 1064, 1051, 1091]) {
      expect(isAlreadyExistsError(Object.assign(new Error('x'), { errno }))).toBe(false);
    }
    expect(isAlreadyExistsError(new Error('Table exists'))).toBe(false);
    expect(isAlreadyExistsError({ errno: '1050' })).toBe(false);
    expect(isAlreadyExistsError(null)).toBe(false);
    expect(isAlreadyExistsError('1050')).toBe(false);
  });
});

describe('isDataStatement', () => {
  it('classifies INSERT, UPDATE, DELETE and REPLACE as data statements', () => {
    expect(isDataStatement('INSERT INTO t VALUES (1)')).toBe(true);
    expect(isDataStatement('update t set a = 1')).toBe(true);
    expect(isDataStatement('  DELETE FROM t')).toBe(true);
    expect(isDataStatement('REPLACE INTO t VALUES (1)')).toBe(true);
  });

  it('classifies DDL and anything else as not a data statement', () => {
    expect(isDataStatement('CREATE TABLE t (a INT)')).toBe(false);
    expect(isDataStatement('ALTER TABLE t ADD COLUMN updated_at INT')).toBe(false);
    expect(
      isDataStatement('CREATE TRIGGER trg BEFORE UPDATE ON t FOR EACH ROW SET NEW.a = 1'),
    ).toBe(false);
    expect(isDataStatement('SET FOREIGN_KEY_CHECKS = 0')).toBe(false);
    expect(isDataStatement('inserts_are_not_a_keyword')).toBe(false);
  });
});
