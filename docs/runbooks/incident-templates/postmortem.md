# Postmortem (56-13)

Within 5 working days of a SEV0/SEV1 (or a SEV2 over 4 hours). No blame: describe what the system
allowed. Keep it private; put its link in the register (`postmortem_url`). Customers who were told
get the English or Arabic summary (section 1) on request.

## English

1. **Summary for customers.** {{incident_title}}: {{plain_summary}}
2. **Timeline** (UTC): started {{started_at}}, detected {{detected_at}}, contained
   {{contained_at}}, customers told {{notified_customers_at}}, authority told
   {{notified_authority_at}}, resolved {{resolved_at}}.
3. **Impact.** Severity {{severity}}. Organizations: {{organization_count}}. People:
   {{people_count}}. Data: {{data_categories}}.
4. **Root cause.** {{root_cause}}
5. **What went well.** {{went_well}}
6. **What was slow or unclear.** {{went_badly}}
7. **Action items.** Each with an owner and a date: {{action_items}}

## العربية

1. **ملخص للعملاء.** {{incident_title}}: {{plain_summary}}
2. **التسلسل الزمني** (بالتوقيت العالمي): البداية {{started_at}}، الاكتشاف {{detected_at}}،
   الاحتواء {{contained_at}}، إبلاغ العملاء {{notified_customers_at}}، إبلاغ الجهة المختصة
   {{notified_authority_at}}، الحل {{resolved_at}}.
3. **الأثر.** الخطورة {{severity}}. المؤسسات: {{organization_count}}. الأشخاص: {{people_count}}.
   البيانات: {{data_categories}}.
4. **السبب الجذري.** {{root_cause}}
5. **ما نجح.** {{went_well}}
6. **ما كان بطيئًا أو غير واضح.** {{went_badly}}
7. **الإجراءات.** لكل إجراء مسؤول وتاريخ: {{action_items}}
