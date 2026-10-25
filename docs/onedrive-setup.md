# إعداد صور OneDrive للاستضافة

الدمج يستخدم Microsoft Graph بتسجيل دخول device code. كلمة مرور Outlook/Hotmail لا تمر على المتجر، ولا يوجد `client secret` في المتصفح أو السيرفر. صلاحية Graph المطلوبة هي `Files.ReadWrite.AppFolder` مع `offline_access`، والملفات تحفظ في مجلد التطبيق الخاص بحساب OneDrive. السيرفر يحفظ رمز التحديث مشفرًا قبل تخزينه في جدول `store_records` الخاص بـSupabase.

## تسجيل تطبيق Microsoft

1. افتح [Microsoft Entra admin center](https://entra.microsoft.com/) ثم **App registrations** و**New registration**.
2. اختر حسابات Microsoft الشخصية كنوع الحسابات المدعومة، ثم أنشئ التطبيق.
3. من **Authentication** فعّل **Allow public client flows** لتسجيل الدخول برمز الجهاز. لا تنشئ client secret.
4. من **API permissions** أضف Microsoft Graph ثم delegated permission باسم `Files.ReadWrite.AppFolder`. راجع بوابة Microsoft لو لم تظهر الصلاحية لحساب التطبيق؛ لا تستبدلها تلقائيًا بصلاحية قراءة/كتابة كل ملفات OneDrive.
5. انسخ **Application (client) ID** فقط. لا تنسخ كلمة المرور أو access token أو refresh token.

## إعداد Render

1. افتح خدمة المتجر في Render، ثم **Environment**.
2. أضف `ONEDRIVE_CLIENT_ID` واجعل قيمته Application (client) ID.
3. تأكد أن `SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` مضبوطين، لأن رمز تحديث OneDrive المشفر يحتاج تخزينًا دائمًا. لا تضع مفتاح Supabase في المتصفح أو المستودع.
4. احفظ التغيير وابدأ deploy يدويًا من Render بعد مراجعة إعدادات الخدمة. ملف الإعداد لا يفعّل خدمة مدفوعة أو ينشر تلقائيًا من هذا المستودع.
5. بعد نجاح النشر، افتح `/admin`، وسجّل دخول الإدارة، ثم تبويب المنتجات واضغط **ربط حساب OneDrive**. افتح رابط Microsoft، أدخل الكود الظاهر، ووافق على صلاحية مجلد التطبيق.
6. ارفع صورة اختبار غير حساسة، وافتح صفحة المنتج من نافذة زائر للتأكد من ظهورها. بعد تحقق الرفع والقراءة فقط يمكن اعتبار اتصال الصور عاملًا.

## ملاحظات تشغيل وأمان

- الخدمة لا تستخدم OneDrive قبل ضبط `ONEDRIVE_CLIENT_ID` وربط الحساب من لوحة الإدارة.
- تدفق كود الجهاز محفوظ مؤقتًا في ذاكرة عملية Node؛ الإعداد الحالي موجه لخدمة Render طويلة التشغيل ذات نسخة واحدة، وليس Netlify Functions أو خدمة serverless متعددة النسخ.
- لا ترسل كلمات مرور Microsoft أو رموز الدخول أو ملفات الصور الخاصة في المحادثة.
- صور المنتجات عامة بطبيعتها. السيرفر يعرضها عبر مسار وسيط، ولا يكشف bearer token أو رابط تنزيل مؤقت من Graph.
- إذا تغير `SESSION_SECRET` قد يتعذر فك تشفير رمز التحديث المحفوظ؛ أعد ربط الحساب من لوحة الإدارة.
- الاختبارات الآلية تحاكي ردود Microsoft ولا تسجل دخولًا إلى الحساب الحقيقي.
