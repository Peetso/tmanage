/**
 * 53-02 — the MENA holiday packs, as data the API imports without touching the file system.
 *
 * The source of truth is the versioned text files beside this module,
 * `holiday-packs/{ksa,uae,eg}-{year}.json`; `holiday-packs.test.ts` fails if this mirror and a file
 * disagree. Packs are static and shipped with the app — never fetched at runtime.
 *
 * Fixed national days carry `estimated: false`. Hijri-based days (Eid al-Fitr, Arafat, Eid
 * al-Adha, the Islamic New Year and the Prophet's birthday where the country observes them) are
 * the **expected** dates, `estimated: true`, for an admin to confirm once announced.
 */

export interface HolidayPackDay {
  readonly date: string;
  readonly labelEn: string;
  readonly labelAr: string;
  readonly estimated: boolean;
}

export interface HolidayPack {
  readonly packKey: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  readonly year: number;
  readonly version: string;
  readonly holidays: readonly HolidayPackDay[];
}

const d = (date: string, labelEn: string, labelAr: string, estimated: boolean): HolidayPackDay => ({
  date,
  labelEn,
  labelAr,
  estimated,
});

const KSA_2026: HolidayPack = {
  packKey: 'ksa-2026',
  country: 'SA',
  year: 2026,
  version: '2026.1',
  holidays: [
    d('2026-02-22', 'Founding Day', 'يوم التأسيس', false),
    d('2026-03-20', 'Eid al-Fitr', 'عيد الفطر', true),
    d('2026-03-21', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2026-03-22', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2026-05-26', 'Arafat Day', 'يوم عرفة', true),
    d('2026-05-27', 'Eid al-Adha', 'عيد الأضحى', true),
    d('2026-05-28', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2026-05-29', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2026-09-23', 'Saudi National Day', 'اليوم الوطني السعودي', false),
  ],
};

const KSA_2027: HolidayPack = {
  packKey: 'ksa-2027',
  country: 'SA',
  year: 2027,
  version: '2027.1',
  holidays: [
    d('2027-02-22', 'Founding Day', 'يوم التأسيس', false),
    d('2027-03-09', 'Eid al-Fitr', 'عيد الفطر', true),
    d('2027-03-10', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2027-03-11', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2027-05-15', 'Arafat Day', 'يوم عرفة', true),
    d('2027-05-16', 'Eid al-Adha', 'عيد الأضحى', true),
    d('2027-05-17', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2027-05-18', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2027-09-23', 'Saudi National Day', 'اليوم الوطني السعودي', false),
  ],
};

const UAE_2026: HolidayPack = {
  packKey: 'uae-2026',
  country: 'AE',
  year: 2026,
  version: '2026.1',
  holidays: [
    d('2026-01-01', "New Year's Day", 'رأس السنة الميلادية', false),
    d('2026-03-20', 'Eid al-Fitr', 'عيد الفطر', true),
    d('2026-03-21', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2026-03-22', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2026-05-26', 'Arafat Day', 'يوم عرفة', true),
    d('2026-05-27', 'Eid al-Adha', 'عيد الأضحى', true),
    d('2026-05-28', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2026-05-29', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2026-06-16', 'Islamic New Year', 'رأس السنة الهجرية', true),
    d('2026-08-25', "Prophet's Birthday", 'المولد النبوي الشريف', true),
    d('2026-12-01', 'Commemoration Day', 'يوم الشهيد', false),
    d('2026-12-02', 'UAE National Day', 'اليوم الوطني', false),
    d('2026-12-03', 'UAE National Day', 'اليوم الوطني', false),
  ],
};

const UAE_2027: HolidayPack = {
  packKey: 'uae-2027',
  country: 'AE',
  year: 2027,
  version: '2027.1',
  holidays: [
    d('2027-01-01', "New Year's Day", 'رأس السنة الميلادية', false),
    d('2027-03-09', 'Eid al-Fitr', 'عيد الفطر', true),
    d('2027-03-10', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2027-03-11', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2027-05-15', 'Arafat Day', 'يوم عرفة', true),
    d('2027-05-16', 'Eid al-Adha', 'عيد الأضحى', true),
    d('2027-05-17', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2027-05-18', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2027-06-06', 'Islamic New Year', 'رأس السنة الهجرية', true),
    d('2027-08-14', "Prophet's Birthday", 'المولد النبوي الشريف', true),
    d('2027-12-01', 'Commemoration Day', 'يوم الشهيد', false),
    d('2027-12-02', 'UAE National Day', 'اليوم الوطني', false),
    d('2027-12-03', 'UAE National Day', 'اليوم الوطني', false),
  ],
};

const EG_2026: HolidayPack = {
  packKey: 'eg-2026',
  country: 'EG',
  year: 2026,
  version: '2026.1',
  holidays: [
    d('2026-01-07', 'Coptic Christmas', 'عيد الميلاد المجيد', false),
    d('2026-01-25', 'Revolution Day and Police Day', 'ثورة 25 يناير وعيد الشرطة', false),
    d('2026-03-20', 'Eid al-Fitr', 'عيد الفطر', true),
    d('2026-03-21', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2026-03-22', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2026-04-13', 'Sham el-Nessim', 'شم النسيم', false),
    d('2026-04-25', 'Sinai Liberation Day', 'عيد تحرير سيناء', false),
    d('2026-05-01', 'Labour Day', 'عيد العمال', false),
    d('2026-05-26', 'Arafat Day', 'يوم عرفة', true),
    d('2026-05-27', 'Eid al-Adha', 'عيد الأضحى', true),
    d('2026-05-28', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2026-05-29', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2026-06-16', 'Islamic New Year', 'رأس السنة الهجرية', true),
    d('2026-06-30', 'June 30 Revolution', 'ذكرى ثورة 30 يونيو', false),
    d('2026-07-23', 'July 23 Revolution', 'ذكرى ثورة 23 يوليو', false),
    d('2026-08-25', "Prophet's Birthday", 'المولد النبوي الشريف', true),
    d('2026-10-06', 'Armed Forces Day', 'عيد القوات المسلحة', false),
  ],
};

const EG_2027: HolidayPack = {
  packKey: 'eg-2027',
  country: 'EG',
  year: 2027,
  version: '2027.1',
  holidays: [
    d('2027-01-07', 'Coptic Christmas', 'عيد الميلاد المجيد', false),
    d('2027-01-25', 'Revolution Day and Police Day', 'ثورة 25 يناير وعيد الشرطة', false),
    d('2027-03-09', 'Eid al-Fitr', 'عيد الفطر', true),
    d('2027-03-10', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2027-03-11', 'Eid al-Fitr holiday', 'عطلة عيد الفطر', true),
    d('2027-04-25', 'Sinai Liberation Day', 'عيد تحرير سيناء', false),
    d('2027-05-01', 'Labour Day', 'عيد العمال', false),
    d('2027-05-03', 'Sham el-Nessim', 'شم النسيم', false),
    d('2027-05-15', 'Arafat Day', 'يوم عرفة', true),
    d('2027-05-16', 'Eid al-Adha', 'عيد الأضحى', true),
    d('2027-05-17', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2027-05-18', 'Eid al-Adha holiday', 'عطلة عيد الأضحى', true),
    d('2027-06-06', 'Islamic New Year', 'رأس السنة الهجرية', true),
    d('2027-06-30', 'June 30 Revolution', 'ذكرى ثورة 30 يونيو', false),
    d('2027-07-23', 'July 23 Revolution', 'ذكرى ثورة 23 يوليو', false),
    d('2027-08-14', "Prophet's Birthday", 'المولد النبوي الشريف', true),
    d('2027-10-06', 'Armed Forces Day', 'عيد القوات المسلحة', false),
  ],
};

export const HOLIDAY_PACKS: Readonly<Record<string, HolidayPack>> = Object.freeze({
  'ksa-2026': KSA_2026,
  'ksa-2027': KSA_2027,
  'uae-2026': UAE_2026,
  'uae-2027': UAE_2027,
  'eg-2026': EG_2026,
  'eg-2027': EG_2027,
});

export const HOLIDAY_PACK_KEYS: readonly string[] = Object.freeze(Object.keys(HOLIDAY_PACKS));

/** The pack for `packKey`, or null for an unknown key. */
export function holidayPack(packKey: string): HolidayPack | null {
  return Object.prototype.hasOwnProperty.call(HOLIDAY_PACKS, packKey)
    ? (HOLIDAY_PACKS[packKey] ?? null)
    : null;
}
