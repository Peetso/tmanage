# In-app banner (56-13)

Post through Platform admin → Settings → Announcements. Severity `critical` while the service is
affected, `warning` once it is contained. At most 14 words per line; no organization names.

## English

- **Title:** {{component}} is not working as expected
- **Text:** We are fixing it now. Your data is safe unless we email you. Updates: {{status_url}}

When contained:

- **Title:** {{component}} is working again
- **Text:** We fixed the problem at {{contained_at}}. Details: {{status_url}}

## العربية

- **العنوان:** ‏{{component}} لا يعمل كما ينبغي
- **النص:** نعمل على إصلاحه الآن. بياناتك آمنة ما لم نراسلك. التحديثات: {{status_url}}

بعد الاحتواء:

- **العنوان:** ‏{{component}} يعمل من جديد
- **النص:** أصلحنا المشكلة في {{contained_at}}. التفاصيل: {{status_url}}
