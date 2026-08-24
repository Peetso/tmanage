# TManage — Notification, Email, and System Copy Specification

## 1. Delivery rules

In-app is canonical. Email/push are delivery channels and deep-link to current authorized state. Never include confidential content by default; use project/deliverable title only when tenant policy permits. Access is checked when notification is generated and again when link/action opens. Every email includes organization, action, deadline/timezone, why recipient, safe CTA, preference/support route.

## 2. Priority

- Critical security: sign-in risk, MFA/credential/role changes, export, suspected breach; bypass quiet hours where policy permits.
- Action required: approval, clarification, upload, invitation, reassignment.
- Important update: blocker affecting recipient, committed date change, approval invalidation.
- Informational: mentions, comments, general updates; bundle/digest by default.

## 3. Templates

### Invitation — internal

Subject: `{{inviter}} invited you to {{organization}} on TManage`

Body: `You’ve been invited as {{role}} with access to {{scope}}. This invitation expires {{expiry}}.` CTA: `Review invitation`.

### Invitation — client

Subject: `{{organization}} invited you to the {{project}} client portal`

Body: `Use TManage to view progress, files, and actions shared with {{clientOrganization}}. Your role is {{role}}. You will not see the team’s internal workspace.` CTA: `Review access`.

### Client request received

Subject: `Request received: {{requestTitle}}`

Body: `We received your request for {{project}}. {{desiredDate}} is a requested date, not a confirmed commitment yet. {{manager}} will review the scope and confirm what happens next.` CTA: `Track request`.

### Clarification required

Subject: `Your input is needed for {{requestTitle}}`

Body: `The team needs {{questionCount}} answer(s) before it can confirm scope and timing.` CTA: `Answer questions`.

### Request accepted

Subject: `Request accepted: {{requestTitle}}`

Body: `Committed outcome: {{scopeSummary}}. Current committed date: {{committedDate}} {{timezone}}.` CTA: `View plan`.

### Approval requested

Subject: `Approval needed by {{dueDate}}: {{deliverableTitle}} {{versionLabel}}`

Body: `{{publisher}} asked you to review the exact version {{versionLabel}} for {{project}}. Estimated review time: {{reviewMinutes}} minutes. Your decision will be recorded for this version.` CTA: `Review and decide`.

### Approval reminder

Subject: `Reminder: {{deliverableTitle}} needs your decision`

Body: `Your review is due {{relativeDue}}. The project schedule {{impactSummary}}.` CTA: `Review now`.

### Changes requested

Subject: `Changes requested for {{deliverableTitle}} {{versionLabel}}`

Body: `{{reviewer}} requested {{feedbackCount}} change(s). A new version will require a new decision.` CTA: `View requested changes`.

### Approved

Subject: `Approved: {{deliverableTitle}} {{versionLabel}}`

Body: `{{reviewer}} approved this governed version on {{decisionTime}}. Approval record: {{shortRecordId}}.` CTA: `View approval record`.

### Approval invalidated

Subject: `A new review is required for {{deliverableTitle}}`

Body: `The governed version changed after the previous request. The old approval request is no longer valid.` CTA: `Review the new version`.

### Date changed

Subject: `Schedule update for {{project}}`

Body: `{{milestone}} changed from {{oldDate}} to {{newDate}}. Reason shared with you: {{clientSafeReason}}.` CTA: `View timeline`.

### Offboarding/security

Subject: `Access removed from {{organization}}`

Body: `Your TManage access to {{organization}} was removed at {{time}}. Active sessions were revoked. Contact {{adminContact}} if this is unexpected.`

## 4. In-app bundle copy

- `{{project}} · {{count}} updates` with summary of actionable versus informational.
- `Waiting on you · {{count}}` sorted by consequence/due date.
- `Client actions · {{count}}` identifies client organization and schedule impact.
- “Why important”: `Due today`, `Blocks 2 people`, `Client decision required`, `Mentioned directly`.

## 5. Error and permission copy

- Not found/inaccessible: `This item isn’t available. It may have been removed, or you may not have access.`
- Conflict: `This changed while you were editing. Review the latest version before applying your update.`
- Offline: `You’re offline. Your draft is saved on this device; actions that change shared work will wait for connection.`
- Scan rejected: `This file couldn’t be made available because it did not pass the security check. Upload a different file or contact support with {{correlationId}}.`
- Publication blocked: `Client publication is blocked because {{count}} linked item(s) are internal. Remove the references or publish a client-safe summary.`

## 6. Arabic baseline templates

Approval subject: `مطلوب اعتماد قبل {{dueDate}}: {{deliverableTitle}} {{versionLabel}}`

Approval body: `طلب منك {{publisher}} مراجعة النسخة المحددة {{versionLabel}} الخاصة بمشروع {{project}}. سيتم تسجيل قرارك لهذه النسخة.` CTA: `مراجعة واتخاذ القرار`.

Request received: `تم استلام طلبك الخاص بمشروع {{project}}. التاريخ المطلوب لم يصبح موعدًا مؤكدًا بعد. سيراجع {{manager}} النطاق ويؤكد الخطوة التالية.`

Permission: `هذا العنصر غير متاح. ربما تمت إزالته أو لا تملك صلاحية الوصول إليه.`

Final translation receives professional Arabic content review; variables and punctuation must render correctly in RTL/mixed-direction content.

## 7. Deliverability and safety

SPF, DKIM, DMARC; bounce/complaint suppression; unsubscribe/preferences for non-transactional mail; one-click actions still require appropriate authentication/CSRF/replay protection; no approval through an unauthenticated tracking pixel or simple GET.
