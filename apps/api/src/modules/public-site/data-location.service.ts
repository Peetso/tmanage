/**
 * 54-17 — where customer data lives today, for the public "Where your data lives" page and the
 * organization's Data-location card.
 *
 * The statement's words are copy (EN + AR catalogs on the web); what changes per deployment is the
 * data-centre label, which only the operator can confirm (hPanel → Plan details → Server location).
 * It is read from `TMANAGE_DATA_REGION_LABEL` at call time, the `fileScanJobEnabled(env)` shape, so
 * no config schema changes. Unset or blank is `null`, and the screens fall back to their own label.
 *
 * Every organization is in the `default` region until 54-18 adds a region per organization.
 */

/** The public data-location view. Paired `Exact` with the web's view in the contracts gate. */
export interface PublicDataLocationView {
  /** The region id. `default` until 54-18. */
  readonly region: string;
  /** The operator's data-centre label, e.g. "Europe (Hostinger)"; `null` when not configured. */
  readonly regionLabel: string | null;
  /** The date the statement was last revised, `YYYY-MM-DD`. */
  readonly updatedOn: string;
}

/** The revision date of the statement's copy. Bump it when the words change. */
export const DATA_LOCATION_UPDATED_ON = '2026-10-29';

const MAX_LABEL_LENGTH = 80;

export class DataLocationService {
  /** The data-location view for this deployment. */
  getDataLocation(env: NodeJS.ProcessEnv = process.env): PublicDataLocationView {
    const raw = env['TMANAGE_DATA_REGION_LABEL']?.trim() ?? '';
    return {
      region: 'default',
      regionLabel: raw === '' ? null : raw.slice(0, MAX_LABEL_LENGTH),
      updatedOn: DATA_LOCATION_UPDATED_ON,
    };
  }
}
