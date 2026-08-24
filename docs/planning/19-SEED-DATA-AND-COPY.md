# TManage — Seed Data and Product Copy

## 1. Demo tenants

### Northstar Studio (internal organization)

Workspace: Client Delivery. Team: Web Experience. Project: Atlas Website Relaunch. Members: Maya Hassan (Owner), Omar Adel (Project Manager), Lina Samir (Designer), Karim Nabil (Developer), Noor Fathy (Content).

### Atlas Hospitality (client organization)

Salma Riad (Client Admin/Sponsor), Youssef Kamal (Client Reviewer), Dina Ashraf (Client Viewer).

### Isolation tenant

BrightOps Consulting with unrelated project “Finance Process Review.” It exists solely to prove no search, ID, notification, cache, file, or audit leakage.

## 2. Project seed

Milestones: Discovery complete; Homepage direction; Content migration; Quality review; Launch. Client request: “Add Arabic booking FAQ before launch,” desired 3 September, category Content, awaiting triage. Internal task from chat: “Prepare mobile booking flow concepts,” assigned Lina, due 20 August, source `#atlas-relaunch`.

Deliverable: Homepage Concept, v1 internal, v2 in client review. Approval criteria: brand alignment, booking CTA clarity, Arabic/English consistency, mobile hierarchy. Reviewer Youssef; due 18 August.

## 3. Required UI copy

### Audience labels

- Internal — Only your team can see this.
- Client visible — Related client members can see this after publication.
- Client action required — Selected client members will be asked to act.

Arabic:

- داخلي — فريقك فقط يمكنه رؤية هذا المحتوى.
- ظاهر للعميل — أعضاء العميل المرتبطون يمكنهم رؤيته بعد النشر.
- مطلوب إجراء من العميل — سيُطلب من أعضاء محددين لدى العميل اتخاذ إجراء.

### Publication warning

“You’re about to publish Homepage Concept v2 to 2 client reviewers. Internal comments and cost fields will not be shared.”

Arabic: “أنت على وشك نشر النسخة الثانية من Homepage Concept لمراجعين اثنين لدى العميل. لن تتم مشاركة التعليقات الداخلية أو بيانات التكلفة.”

### Client request acknowledgement

“Request received. The requested date is not committed yet. Omar will review scope and confirm the plan.”

Arabic: “تم استلام الطلب. التاريخ المطلوب غير مؤكد حتى الآن. سيراجع عمر النطاق ويؤكد الخطة.”

### Approval invalidation

“This approval is no longer valid because the reviewed version changed. Review the new version before deciding.”

Arabic: “لم تعد هذه الموافقة سارية لأن النسخة التي تمت مراجعتها تغيّرت. راجع النسخة الجديدة قبل اتخاذ القرار.”

### Empty action queue

“You’re all caught up. We’ll notify you when your review, file, or answer is needed.”

Arabic: “لا توجد إجراءات مطلوبة منك الآن. سنرسل لك إشعارًا عند الحاجة إلى مراجعة أو ملف أو إجابة.”

## 4. Data rules

Seed scripts are deterministic and safe to rerun. Passwords/tokens are local-test only and never committed as real secrets. Every seed record has organization scope. Tests assert the Atlas user cannot discover BrightOps data through list, direct ID, search, file URL, notification, realtime, or audit.
