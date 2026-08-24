import { describe, expect, it } from 'vitest';
import { splitStatements } from './migrator.js';

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
