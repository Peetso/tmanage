/**
 * The API's CSV writer is the domain's — 52-29 moved the one escaping rule (RFC 4180 quoting plus
 * the formula-injection guard) to `@tmanage/domain`. This thin re-export keeps existing importers
 * where they are; `scripts/lint/csv-exports.mjs` accepts it as a domain import.
 */
export { escapeCsvCell, toCsv } from '@tmanage/domain';
