import type {
  ChainDocumentKind,
  ChainLink,
  EinvoiceChainStore,
} from '../../jobs/einvoice-chain-reconciler.js';
import { incrementOrganizationSignal } from './security-signal-store.js';
import type { WorkerDatabase } from './worker-database.js';

/**
 * 52-12 (R22-b, 0314) — the SQL behind `jobs/einvoice-chain-reconciler.ts`, as `tmanage_worker`:
 * SELECT, INSERT, DELETE on `einvoice_chain_checks`; SELECT on five columns of `client_invoices`
 * and `client_credit_notes` (id, organization_id, zatca_icv, zatca_pih, zatca_xml_hash) and on
 * `org_finance_profiles.einvoice_regime`; the break signal goes through the security-signal
 * store's `incrementOrganizationSignal` (existing 56-23 grant). Every chain read names one
 * organization; the two cross-tenant reads are the organization list and the newest verdict time.
 * Nothing here writes a document table.
 */

const LATEST_SQL = `SELECT MAX(checked_at) AS latest FROM einvoice_chain_checks`;

const ORGANIZATIONS_SQL = `SELECT organization_id FROM org_finance_profiles
  WHERE einvoice_regime = 'zatca'
 UNION
 SELECT DISTINCT organization_id FROM client_invoices WHERE zatca_icv IS NOT NULL
 UNION
 SELECT DISTINCT organization_id FROM client_credit_notes WHERE zatca_icv IS NOT NULL`;

const LINKS_SQL = `SELECT 'invoice' AS kind, id, zatca_icv, zatca_pih, zatca_xml_hash
   FROM client_invoices WHERE organization_id = ? AND zatca_icv IS NOT NULL
 UNION ALL
 SELECT 'credit_note' AS kind, id, zatca_icv, zatca_pih, zatca_xml_hash
   FROM client_credit_notes WHERE organization_id = ? AND zatca_icv IS NOT NULL
 ORDER BY zatca_icv`;

const INSERT_SQL = `INSERT INTO einvoice_chain_checks
   (id, organization_id, checked_at, status, head_icv, documents, break_icv, break_reason,
    detail_json)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const PRUNE_SQL = `DELETE FROM einvoice_chain_checks WHERE checked_at < ?`;

interface LinkDbRow {
  readonly kind: string;
  readonly id: string;
  readonly zatca_icv: number | string;
  readonly zatca_pih: string | null;
  readonly zatca_xml_hash: string | null;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(at.getTime()) ? null : at;
}

const linkOf = (row: LinkDbRow): ChainLink => ({
  icv: Number(row.zatca_icv),
  pih: row.zatca_pih,
  xmlHash: row.zatca_xml_hash,
  kind: (row.kind === 'credit_note' ? 'credit_note' : 'invoice') satisfies ChainDocumentKind,
  id: String(row.id),
});

export function createEinvoiceChainStore(database: WorkerDatabase): EinvoiceChainStore {
  return {
    latestCheckedAt: () =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { readonly latest: unknown }[]>(LATEST_SQL);
        return toDate(rows[0]?.latest);
      }),
    zatcaOrganizations: () =>
      database.read(async (tx) => {
        const rows =
          await tx.query<readonly { readonly organization_id: string }[]>(ORGANIZATIONS_SQL);
        return rows.map((row) => String(row.organization_id));
      }),
    chainLinks: (organizationId) =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly LinkDbRow[]>(LINKS_SQL, [
          organizationId,
          organizationId,
        ]);
        return rows.map(linkOf);
      }),
    insertCheck: async (check) => {
      await database.transaction((tx) =>
        tx.query(INSERT_SQL, [
          check.id,
          check.organizationId,
          check.checkedAt,
          check.status,
          check.headIcv,
          check.documents,
          check.breakIcv,
          check.breakReason,
          JSON.stringify(check.detail),
        ]),
      );
    },
    recordBreak: (signal) =>
      incrementOrganizationSignal(database, {
        id: signal.id,
        organizationId: signal.organizationId,
        ruleKey: signal.ruleKey,
        severity: signal.severity,
        sourceHash: signal.sourceHash,
        count: signal.count,
        seenAt: signal.seenAt,
        details: { breakIcv: signal.breakIcv, reason: signal.reason },
      }),
    pruneBefore: (before) =>
      database.transaction(async (tx) => {
        const result = await tx.query<{ readonly affectedRows?: number }>(PRUNE_SQL, [before]);
        return Number(result.affectedRows ?? 0);
      }),
  };
}
