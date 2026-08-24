# Content and localization

## Voice
Plain, specific, consequence-first. State what happened, who is involved, what is needed and by when.
No exclamation marks, no gamification, no "oops". Internal copy may be terse; client copy always names
the benefit of acting ("Approving lets content migration start this week").

## Fixed strings (file 19 — used verbatim, never paraphrased)
- Internal — Only your team can see this. / داخلي — فريقك فقط يمكنه رؤية هذا المحتوى.
- Client visible — Related client members can see this after publication. / ظاهر للعميل — أعضاء العميل المرتبطون يمكنهم رؤيته بعد النشر.
- Client action required — Selected client members will be asked to act. / مطلوب إجراء من العميل — سيُطلب من أعضاء محددين لدى العميل اتخاذ إجراء.
- Publication warning, request acknowledgement, approval invalidation, empty action queue — as written in file 19, EN and AR.

## Arabic
- Alexandria Variable. Display sizes ~10% smaller than Latin, line height +12–14%, tracking exactly 0.
- Semantic mirroring: rail moves right, Context Lens left, Pulse Track starts right, arrows and label
  groups reorder — never a blind CSS transform.
- Isolated LTR inside Arabic: version hashes, file names, emails, URLs, code, `v2 · 8f2c·d41a`, and
  large numerals in metrics (rendered with `direction:ltr` inside an RTL block).
- Documented exception: chart-style time axes in INS-03/INS-04 remain LTR; the milestone Pulse Track
  mirrors. Each exception is recorded in the decision log.
- Long-string test: work titles up to 90 Arabic characters must ellipsis cleanly in a 38px row (proven in
  the dark/RTL artifact).

## Numbers, dates, time
Tabular numerals for anything that updates. Dates as "18 Aug" in dense contexts, "18 August 2026" in
decisions and portals. Relative time only for freshness ("26h", "3 days old"); never for commitments.
Timezone shown wherever a meeting or deadline crosses organizations.

## Notifications and email (file 35)
Subject states object + required action + date. Body repeats the audience label. No marketing tone in
transactional client email; the portal link is the primary action.
