export interface CatalogCheck {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly stray: readonly string[];
  readonly empty: readonly string[];
  readonly placeholder: readonly string[];
  readonly missingShare: number;
  readonly identicalShare: number;
}

export function checkCatalog(
  en: Readonly<Record<string, unknown>>,
  catalog: Readonly<Record<string, unknown>>,
  options?: { readonly strict?: boolean; readonly maxMissingShare?: number },
): CatalogCheck;
