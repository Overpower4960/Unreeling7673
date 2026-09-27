# xpanel روی ریلوی (اجرای همان Worker.js روی Node)

هدف: رباتِ پنل از سقفِ روزانهٔ D1 کلودفلر آزاد شود. **همان فایلِ `Worker.js`
بدونِ تغییر** روی Node اجرا می‌شود؛ فقط یک لایهٔ سازگاری، D1 را به SQLite محلی
و cron کلودفلر را به یک حلقهٔ هر‌دقیقه تبدیل می‌کند.

## اجزا
| فایل | کار |
|---|---|
| `Worker.js` | **همان** کدِ ربات (f66) — دست‌نخورده |
| `server.mjs` | سرورِ HTTP + حلقهٔ کرون + لایهٔ سازگاریِ D1⇒SQLite (+KV قلابی) |
| `migrate.mjs` | انتقالِ داده از D1 کلودفلر به SQLite (page-by-page، idempotent) |
| `Dockerfile` · `railway.json` | ساخت و اجرا روی ریلوی (healthcheck = `/health`) |

## راه‌اندازی (گام‌به‌گام)
1. سرویسِ ریلوی از همین ریپو بساز (Dockerfile). یک **Volume** روی مسیر `/data` وصل کن
   (فایلِ پایگاه‌داده همان‌جا می‌ماند و با هر دیپلوی پاک نمی‌شود).
2. متغیرها: `SQLITE_PATH=/data/xpanel.db` · `CF_API_TOKEN=…` (فقط برای مهاجرت).
3. مهاجرتِ داده: `npm run migrate` (یک‌بار).
4. `/health` باید `installed:true` بدهد.
5. **انتقالِ وبهوک:** در D1 کلید `cfg:bot_token` را بردار و
   `setWebhook` را به `https://<railway-domain>/webhook` با همان `secret_token`
   (کلیدِ `cfg:wh_secret`) بزن.
6. **خاموش‌کردنِ کرونِ کلودفلر** تا دو ربات هم‌زمان پیام نفرستند:
   `PUT /accounts/<acc>/workers/scripts/noisy-silence-aee4/schedules` با `[]`.

## برگشت (rollback)
- کرونِ کلودفلر را دوباره با `*/1 * * * *` روشن کن،
- وبهوک را به `https://noisy-silence-aee4.guts-nuclei-sloped.workers.dev/webhook` برگردان.
دادهٔ D1 دست‌نخورده می‌ماند (SQLite فقط کپی می‌گیرد).

## نکته‌ها
- SQLite در حالت `WAL` و با `busy_timeout` اجرا می‌شود؛ قفل‌های توزیع‌شدهٔ D1 لازم نیست
  (تک‌پروسه) ولی کد دست‌نخورده با آن‌ها هم کار می‌کند.
- `SKIP_CRON=1` برای تست‌های محلی (بدونِ فرستادنِ پیامِ کرون).
