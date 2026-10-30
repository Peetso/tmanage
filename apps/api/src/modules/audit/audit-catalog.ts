import { AUDIT_ACTIONS, auditActionLabel, auditObjectTypeFor } from '@tmanage/domain';
import type { AuditAction } from '@tmanage/domain';

/**
 * 56-11 — the organization audit-action catalog (`GET …/admin/audit/catalog`, `audit.read`).
 *
 * Derived from the domain's `AUDIT_ACTION_CATALOG`, so a new action appears here the moment it can
 * be written — the census test fails if any catalogued action lacks an English or Arabic line.
 * English is the domain's plain sentence (`auditActionLabel`). Arabic is composed from the
 * action's verb and its object type until the UI slice supplies reviewed copy per action; an
 * unmapped verb falls back to a neutral "an action was recorded" sentence rather than to a code.
 */

export interface AuditCatalogEntry {
  readonly action: AuditAction;
  readonly objectType: string;
  readonly descriptionEn: string;
  readonly descriptionAr: string;
}

const AR_VERBS: Readonly<Record<string, string>> = {
  created: 'تم الإنشاء',
  updated: 'تم التعديل',
  edited: 'تم التعديل',
  deleted: 'تم الحذف',
  restored: 'تمت الاستعادة',
  archived: 'تمت الأرشفة',
  purged: 'تم الحذف النهائي',
  renamed: 'تمت إعادة التسمية',
  removed: 'تمت الإزالة',
  revoked: 'تم الإلغاء',
  cancelled: 'تم الإلغاء',
  role_changed: 'تم تغيير الدور',
  status_changed: 'تم تغيير الحالة',
  settings_changed: 'تم تغيير الإعدادات',
  transitioned: 'تم نقل الحالة',
  submitted: 'تم الإرسال للمراجعة',
  requested: 'تم الطلب',
  sent: 'تم الإرسال',
  emailed: 'تم الإرسال بالبريد',
  exported: 'تم التصدير',
  downloaded: 'تم التنزيل',
  uploaded: 'تم الرفع',
  attached: 'تم الإرفاق',
  connected: 'تم الربط',
  disconnected: 'تم فصل الربط',
  accepted: 'تم القبول',
  approved: 'تمت الموافقة',
  declined: 'تم الرفض',
  rejected: 'تم الرفض',
  refused: 'تم الرفض',
  expired: 'انتهت الصلاحية',
  invited: 'تمت الدعوة',
  granted: 'تم المنح',
  issued: 'تم الإصدار',
  opened: 'تم الفتح',
  decided: 'تم اتخاذ قرار',
  commented: 'تمت إضافة تعليق',
  verified: 'تم التحقق',
  failed: 'فشل الإجراء',
  capability_denied: 'تم منع الوصول',
};

const AR_FALLBACK = 'تم تسجيل إجراء';

export function arabicAuditDescription(action: string, objectType: string): string {
  const verb = action.slice(action.lastIndexOf('.') + 1);
  return `${AR_VERBS[verb] ?? AR_FALLBACK} (${objectType})`;
}

export function auditCatalog(): readonly AuditCatalogEntry[] {
  return AUDIT_ACTIONS.map((action) => {
    const objectType = auditObjectTypeFor(action);
    return {
      action,
      objectType,
      descriptionEn: auditActionLabel(action),
      descriptionAr: arabicAuditDescription(action, objectType),
    };
  });
}
