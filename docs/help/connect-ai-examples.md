# Connect your AI: things you can ask (time and money)

Copy for the `/help/connect-ai` page (52-22). Keys: `help.connectAi.examples.*` (R18-b).
Each prompt maps to the action ids in `apps/api/src/modules/ai-actions/registry/finance-time.ts`.

Actions marked **Needs approval** never run straight from the AI. TManage holds them until a
person approves them in TManage. Cost and margin figures are only shown to finance managers.

## English

| Ask your AI                                                | What TManage does                                         | Approval       |
| ---------------------------------------------------------- | --------------------------------------------------------- | -------------- |
| "Log 2 hours on the Acme homepage task for yesterday"      | Adds a 120-minute line to your timesheet                  | Runs at once   |
| "Fill my timesheet this week like last week and submit it" | Copies last week's lines, then submits the timesheet      | Runs at once   |
| "Start my timer on the logo task" / "Stop my timer"        | Starts or stops your own timer                            | Runs at once   |
| "Submit a 49 USD software expense for Acme"                | Records and submits the expense                           | Runs at once   |
| "What is the burn on Project X?"                           | Reads the project's budget burn                           | Read only      |
| "Which clients are unprofitable this quarter?"             | Reads the profitability report by client                  | Read only      |
| "What have we not billed yet?"                             | Reads the unbilled work report                            | Read only      |
| "Create a 20-hour monthly retainer for Acme"               | Creates an internal draft retainer (client cannot see it) | Runs at once   |
| "Approve Sara's timesheet"                                 | Approves the timesheet                                    | Needs approval |
| "Export September expenses"                                | Returns the CSV                                           | Needs approval |
| "Designers are 95 an hour from January"                    | Adds a rate to the rate card                              | Needs approval |

## العربية

| اطلب من مساعدك                                            | ما يفعله TManage                         | الموافقة      |
| --------------------------------------------------------- | ---------------------------------------- | ------------- |
| "سجّل ساعتين على مهمة الصفحة الرئيسية لـ Acme ليوم أمس"   | يضيف سطراً من 120 دقيقة إلى جدولك الزمني | يُنفَّذ فوراً |
| "املأ جدولي الزمني هذا الأسبوع مثل الأسبوع الماضي وأرسله" | ينسخ سطور الأسبوع الماضي ثم يرسل الجدول  | يُنفَّذ فوراً |
| "شغّل المؤقّت على مهمة الشعار" / "أوقف المؤقّت"           | يشغّل مؤقّتك أو يوقفه                    | يُنفَّذ فوراً |
| "أرسل مصروف برمجيات بقيمة 49 دولاراً لـ Acme"             | يسجّل المصروف ويرسله                     | يُنفَّذ فوراً |
| "ما استهلاك الميزانية في المشروع X؟"                      | يقرأ استهلاك ميزانية المشروع             | قراءة فقط     |
| "أي العملاء غير مربحين هذا الربع؟"                        | يقرأ تقرير الربحية حسب العميل            | قراءة فقط     |
| "ما الذي لم نفوتره بعد؟"                                  | يقرأ تقرير العمل غير المفوتر             | قراءة فقط     |
| "أنشئ عقد احتفاظ شهرياً بـ 20 ساعة لـ Acme"               | ينشئ مسودة عقد داخلية (لا يراها العميل)  | يُنفَّذ فوراً |
| "اعتمد الجدول الزمني لسارة"                               | يعتمد الجدول الزمني                      | يحتاج موافقة  |
| "صدّر مصروفات سبتمبر"                                     | يعيد ملف CSV                             | يحتاج موافقة  |
| "سعر المصممين 95 للساعة اعتباراً من يناير"                | يضيف سعراً إلى بطاقة الأسعار             | يحتاج موافقة  |

الإجراءات التي "تحتاج موافقة" لا تُنفَّذ مباشرة من المساعد؛ يحتفظ بها TManage حتى يوافق عليها
شخص داخل TManage. أرقام التكلفة والهامش تظهر لمديري المالية فقط.
