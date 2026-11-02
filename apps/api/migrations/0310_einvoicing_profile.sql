-- 0310_einvoicing_profile — 52-12 e-invoicing readiness (backend, part 1), R21-c.
--
-- Governing source: 52-FEATURE-GAPS-AGENCY-CORE "52-12" scope 1: "extend 52-23's address columns
-- with a structured `address_json TEXT`". The organization's finance profile (0260, 0303) gains
--   `address_json` — the structured seller address an e-invoice needs: building number, street,
--                     district, city, postal code, country code (a JSON object written by the API
--                     through `parseAddressJson`; NULL = not given yet). The free-text
--                     `address_en/ar` lines stay for the PDF.
--
-- MariaDB-safe (Hostinger): TEXT, not the JSON type; no CHECK, no generated column, no IF NOT
-- EXISTS. The shape (ZATCA: 4-digit building, 5-digit postal code in SA) is checked by the app.
-- Registry: no new table (schema.ts one column; the tenant guard already knows the table);
-- users.sql unchanged (the app already UPDATEs org_finance_profiles).

ALTER TABLE org_finance_profiles
  ADD COLUMN address_json TEXT NULL;
