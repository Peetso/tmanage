import { LEGAL_COPY_AR, LEGAL_ENGLISH_PREVAILS_AR as ENGLISH_PREVAILS_AR } from '@tmanage/domain';
import type { LegalDoc } from '../../lib/api/public-legal';

/**
 * **Arabic legal copy (live-check M2).** A faithful Arabic translation of the Terms of Service and the
 * Privacy Policy in `@tmanage/domain` (`LEGAL_DOCUMENTS`, last updated 28 October 2026), shown by
 * `MarketingLegalScreen` when the active locale is Arabic.
 *
 * The English document stays the source of truth and is never touched here: the server HTML is the
 * English text (Google's OAuth brand review reads it), and each Arabic page says that the English
 * version prevails. Sections are keyed by the English section `id`, so the anchors stay the same and
 * a section with no translation falls back to its English text. Web and email addresses are kept in
 * ASCII and followed by a space or a bracket, so `LinkedText` still turns them into links.
 *
 * platform-admin v2 · PA-03: the copy itself now lives in `@tmanage/domain` (`legal-content-ar.ts`,
 * beside the English, with the new `operator-access` section); this module keeps its exports so the
 * screen and its tests read it unchanged.
 */
export interface ArabicLegalDocument {
  readonly title: string;
  readonly intro: string;
  readonly sections: Readonly<Record<string, { readonly heading: string; readonly body: string }>>;
}

/** Shown under the intro of each Arabic legal page. */
export const LEGAL_ENGLISH_PREVAILS_AR: string = ENGLISH_PREVAILS_AR;

export const LEGAL_DOCUMENTS_AR: Readonly<Record<LegalDoc, ArabicLegalDocument>> = LEGAL_COPY_AR;
