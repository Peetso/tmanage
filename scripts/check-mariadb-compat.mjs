#!/usr/bin/env node
/**
 * Static guard: keeps SQL that MariaDB 11.8 does not accept out of `apps/api/migrations`.
 *
 * MariaDB 11.8 is the project's only database engine: production (Hostinger shared hosting),
 * local development, docker compose, CI and the DB test suite all run it. The DB suite would
 * refuse a bad migration too, but it takes about 30 minutes; this check is a fast, offline
 * pre-check that answers in seconds. It targets constructs that MariaDB rejects or treats
 * differently - historically MySQL-8-only syntax such as functional indexes, generated-column
 * index forms, MEMBER OF and ALTER TABLE ... DROP CHECK. The first live deploy failed on
 * migration 0011, whose generated column `if(resolved_at is null, work_item_id, NULL)` backed a
 * unique index - accepted by MySQL 8, refused by MariaDB.
 *
 * Usage: node scripts/check-mariadb-compat.mjs [dir]   (default: apps/api/migrations)
 *
 * Comments (`--`, `#`, block) and string literals are blanked before matching, so prose about a
 * forbidden construct never trips the check; line numbers still map to the original file.
 * Exit 1 on any hit, 0 when clean. `apps/api/src/common/database/mariadb-compat.test.ts` keeps
 * the behaviour honest.
 *
 * Deliberately NOT flagged (accepted by MariaDB): JSON column type, CHECK constraints, triggers /
 * SIGNAL / DELIMITER, FULLTEXT, UUID(), ON UPDATE CURRENT_TIMESTAMP(3).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TRIGGER_FIX =
  'use a plain column maintained by BEFORE INSERT/UPDATE triggers (as 0011/0150/0153 do)';

/** @type {{ name: string, re: RegExp, reason: string }[]} */
const RULES = [
  {
    name: 'GENERATED ALWAYS AS',
    re: /\bGENERATED\s+ALWAYS\s+AS\b/gi,
    reason: `generated columns are restricted on MariaDB (allowed functions, indexes) - ${TRIGGER_FIX}`,
  },
  {
    name: 'AS (...) STORED|VIRTUAL',
    re: /\)\s*(STORED|VIRTUAL|PERSISTENT)\b/gi,
    reason: `generated column shorthand - ${TRIGGER_FIX}`,
  },
  {
    name: 'utf8mb4_0900_* collation',
    re: /\butf8mb4_0900_\w*/gi,
    reason:
      'MariaDB has no 0900 collations - use utf8mb4_unicode_ci, or CAST(x AS BINARY) for byte-exact',
  },
  {
    name: 'functional key part',
    re: /\b(KEY|INDEX)\b[^;(]*\(\s*\(/gi,
    reason:
      'MariaDB has no functional indexes ((expr)) - index a plain column kept by triggers instead',
  },
  {
    name: 'DEFAULT (expr)',
    re: /\bDEFAULT\s*\(/gi,
    reason:
      'expression defaults behave differently on MariaDB - use a literal default or set it in a BEFORE INSERT trigger',
  },
  {
    name: 'RENAME COLUMN',
    re: /\bRENAME\s+COLUMN\b/gi,
    reason: 'not in MariaDB 10.4 and earlier - use CHANGE COLUMN old new <full definition>',
  },
  {
    name: 'INVISIBLE / VISIBLE',
    re: /\b(IN)?VISIBLE\b/gi,
    reason:
      'MariaDB uses different keywords for invisible indexes/columns (IGNORED / INVISIBLE semantics differ) - drop the attribute',
  },
  {
    name: '->> / -> JSON path operator',
    re: /->>?/g,
    reason: 'MariaDB has no -> / ->> - use JSON_UNQUOTE(JSON_EXTRACT(col, path)) or JSON_EXTRACT',
  },
  {
    name: 'JSON_TABLE',
    re: /\bJSON_TABLE\b/gi,
    reason: 'JSON_TABLE semantics differ on MariaDB - avoid in migrations',
  },
  {
    name: 'MEMBER OF',
    re: /\bMEMBER\s+OF\b/gi,
    reason: 'MariaDB has no MEMBER OF - use JSON_CONTAINS(doc, JSON_QUOTE(value))',
  },
  {
    name: 'CAST(... AS JSON)',
    re: /\bAS\s+JSON\b/gi,
    reason: 'MariaDB cannot CAST to JSON - use JSON_EXTRACT / JSON_COMPACT, or store the text',
  },
  {
    name: 'DROP CHECK',
    re: /\bDROP\s+CHECK\b/gi,
    reason: 'MariaDB has no DROP CHECK - use DROP CONSTRAINT <name> (supported by MariaDB)',
  },
  {
    name: 'ALGORITHM=INSTANT',
    re: /\bALGORITHM\s*=\s*INSTANT\b/gi,
    reason: 'MariaDB support for INSTANT differs by operation - omit the ALGORITHM clause',
  },
  {
    name: 'SRID',
    re: /\bSRID\b/gi,
    reason: 'MariaDB does not support SRID column attributes - omit it',
  },
];

const VERSIONED_RULE = {
  name: '/*!8 versioned comment',
  reason:
    'MariaDB executes /*!8xxxx */ code (its version number is higher) - write the SQL plainly or drop it',
};

/**
 * Blank comments and string literals (keeping newlines and length, so offsets map back to the
 * original line numbers) and collect `/*!8` versioned comments on the way.
 * @param {string} text
 * @returns {{ code: string, versioned: number[] }}
 */
function blankCommentsAndStrings(text) {
  const out = text.split('');
  const versioned = [];
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-' && (i + 2 >= n || /\s/.test(text[i + 2]))) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '#') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      if (text[i + 2] === '!' && text[i + 3] === '8') versioned.push(i);
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
        } else if (text[j] === c && text[j + 1] === c) {
          j += 2;
        } else if (text[j] === c) {
          break;
        } else {
          j += 1;
        }
      }
      blank(i + 1, Math.min(j, n));
      i = j + 1;
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1);
      i = end === -1 ? n : end + 1;
    } else {
      i += 1;
    }
  }
  return { code: out.join(''), versioned };
}

/**
 * Scan one migration's SQL for constructs MariaDB does not accept.
 * @param {string} text
 * @param {string} filename
 * @returns {{ file: string, line: number, pattern: string, reason: string }[]}
 */
export function scanSql(text, filename) {
  const lineStarts = [0];
  for (let k = 0; k < text.length; k += 1) if (text[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const { code, versioned } = blankCommentsAndStrings(text);
  const hits = versioned.map((offset) => ({
    file: filename,
    line: lineOf(offset),
    pattern: VERSIONED_RULE.name,
    reason: VERSIONED_RULE.reason,
  }));
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const match of code.matchAll(rule.re)) {
      hits.push({
        file: filename,
        line: lineOf(match.index),
        pattern: rule.name,
        reason: rule.reason,
      });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = resolve(process.argv[2] ?? join(repoRoot, 'apps', 'api', 'migrations'));
  const files = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort();
  const hits = [];
  for (const name of files) {
    const path = join(dir, name);
    const rel = relative(process.cwd(), path);
    const shown = (rel.startsWith('..') ? path : rel).split('\\').join('/');
    hits.push(...scanSql(readFileSync(path, 'utf8'), shown));
  }
  if (hits.length > 0) {
    for (const hit of hits)
      console.error(`${hit.file}:${hit.line}: ${hit.pattern} - ${hit.reason}`);
    console.error(
      `mariadb-compat: ${hits.length} MariaDB-incompatible construct(s) in ${files.length} files`,
    );
    process.exit(1);
  }
  console.log(`mariadb-compat: ${files.length} files clean`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
