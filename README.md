# 🚂 xpanel-railway — نسخهٔ ریلویِ ربات (۰ تا ۱۰۰)

> همان `Worker.js` (نسخهٔ زندهٔ `f72`)، فقط اجراکننده‌اش عوض شده: **Node + SQLite روی ریلوی** به‌جای Cloudflare Workers + D1.
> نتیجهٔ عملی: **دیگر سقفِ ۱۰۰٬۰۰۰ ردیفِ نوشتنِ روزانه وجود ندارد** — نه ریستِ نیمه‌شب، نه «ربات خاموش شد».

| موضوع | کلودفلر (قبلی) | ریلوی (اینجا) |
|---|---|---|
| سقفِ نوشتنِ روزانه | ۱۰۰٬۰۰۰ ردیفِ **حساب‌سطح** | **ندارد** |
| سقفِ درخواست | ۱۰۰٬۰۰۰ در روز | ندارد |
| داده | D1 (۳ شارد ⇒ f72: یکی) | یک فایلِ `xpanel.db` روی والیوم |
| بکاپ | بکاپِ داخلیِ ربات به گیت‌هاب | همان + **بکاپِ فایلِ دیتابیس** هر ۶ ساعت |
| هزینه | رایگان (با سقف) | کردیتِ رایگان، بعد پلنِ ۵$/ماهِ ریلوی |

---

## ۱) معماریِ نسخهٔ ریلوی (خیلی کوتاه)
```
تلگرام ──(وبهوک)──▶ https://<خدمت>.up.railway.app/webhook
                              │
                     server.mjs (Node) ── Worker.js (بدونِ تغییر)
                              │
                        /data/xpanel.db   ← همهٔ دادهٔ کاربران (یک فایل!)
                        /data/backups/*.db.gz  ← ۶ بکاپِ آخر
```
**همهٔ داده در یک فایل است.** پس بکاپ = یک فایل، انتقال = همان فایل. همین.

---

## ۲) پیش‌نیازها
1. اکانتِ **ریلوی** (با کردیتِ رایگان).
2. همین ریپو (خصوصی است ⇒ هرجا دیپلوی می‌کنی به گیت‌هاب دسترسی بده).
3. توکنِ گیت‌هاب با دسترسیِ `Contents: read/write` روی همین ریپو ⇒ برای بکاپِ خودکار.
4. دیتابیسِ کلودفلر فعلی (: `7a5acc79-4157-4485-9f1b-fbe4dce329ba`) ⇒ برای انتقالِ یک‌بارهٔ داده‌ها.

---

## ۳) ساختِ پروژه روی ریلوی (راهِ ساده، از موبایل)

1. **railway.app** → وارد شو → **New Project**.
2. **Deploy from GitHub repo** → همین ریپو (`xpanel-railway`) را انتخاب کن.
   - اگر ریپو دیده نشد: **Configure GitHub App** → دسترسی به این ریپو بده.
3. سرویس ساخته می‌شود و اولین بیلد شروع می‌شود (`Dockerfile` خودش اجرا می‌شود).
4. **➕ والیوم بساز (حتماً!）：** سرویس → **Settings → Volumes → Add Volume** → **Mount path = `/data`**
   > بدونِ والیوم، دیتابیس با هر دیپلوی پاک می‌شود ❗️
5. **Variables** را اضافه کن (Settings → Variables):

| متغیر | مقدار |
|---|---|
| `SQLITE_PATH` | `/data/xpanel.db` |
| `BACKUP_DIR` | `/data/backups` |
| `ADMIN_TOKEN` | یک رمزِ دلخواهِ طولانی (برای `/admin/*`) |
| `BACKUP_REPO` | `baddarksss/xpanel-railway` |
| `BACKUP_GH_TOKEN` | توکنِ گیت‌هاب |
| `BACKUP_EVERY_H` | `6` |
| `AUTO_RESTORE` | `1` |
| `CF_API_TOKEN` / `CF_ACCOUNT` / `CF_D1` | برای انتقالِ یک‌بارهٔ D1 (بعداً می‌توانی پاک کنی) |
| `TZ` | `UTC` |

6. **Public Networking → Generate Domain** ⇒ یک آدرس مثلِ `xpanel-railway-production-xxxx.up.railway.app` می‌گیری.
7. تست: `https://<آدرس>/health` ⇒ باید بدهد `{"status":"ok", …, "codeStamp":"2026-09-27-f72"}`

### راهِ CLI (اگر ترمینال دوست داری)
```bash
npm i -g @railway/cli
railway login                       # یا: export RAILWAY_TOKEN=…
railway init -n xpanel              # پروژهٔ تازه
railway link                        # سرویس را وصل کن
railway volume add -m /data         # والیوم (اگر خطا داد، در UI بساز)
railway variables --set "SQLITE_PATH=/data/xpanel.db" --set "ADMIN_TOKEN=…"
railway up                          # همین پوشه را آپلود و دیپلوی می‌کند
railway domain                      # دامنهٔ عمومی
```

---

## ۴) انتقالِ دادهٔ کاربران از کلودفلر (یک‌بار)

**راهِ ۱ — از داخل خودِ سرویس (کوتاه‌ترین):**
```bash
curl -X POST "https://<آدرس>/admin/migrate" -H "x-admin-token: <ADMIN_TOKEN>"
# ⇒ {"ok":true,"copied":11509,"local":11509,"remote":11509,…}
```
**راهِ ۲ — محلی (اگر خواستی قبلش ببینی):**  
```bash
CF_API_TOKEN=… CF_ACCOUNT=03ca… CF_D1=7a5acc79-… SQLITE_PATH=./data/xpanel.db node migrate.mjs
# بعد فایل را با /admin/import بالا بفرست:
gzip -c data/xpanel.db | curl -X POST "https://<آدرس>/admin/import" \
  -H "x-admin-token: <ADMIN_TOKEN>" -H "Content-Type: application/gzip" --data-binary @-
```
**راهِ ۳ — از بکاپِ گیت‌هابِ خودِ ربات:** فایلِ JSONی که ربات در ریپو پوش کرده را با یک اسکریپت کوچک به SQLite برگردان، یا از `/admin/restore` استفاده کن (بکاپِ `.db.gz` این ریپو).

> بعد از انتقال، `cfg:webhook_url` را به دامنهٔ ریلوی به‌روزرسانی کن (برای لینک‌های `/d/<token>/…`):
> ```bash
> # یک بار با ربات در تلگرام دستورِ راه‌اندازی را بزن، یا مستقیم:
> curl -X POST "https://<آدرس>/admin/migrate" -H "x-admin-token: …"   # فقط برای داده
> ```
> ساده‌ترین راه: در ربات، بخشِ ادمین ⇒ «راه‌اندازی/وبهوک» را یک‌بار اجرا کن (خودش URL جدید را ثبت می‌کند).

---

## ۵) وصل‌کردنِ تلگرام به ریلوی (سوییچ)

وبهوکِ تلگرام تک‌آدرسی است ⇒ تا وقتی این را نزنی، ربات هنوز روی کلودفلر کار می‌کند.

```bash
# ۱) آدرسِ جدید را ثبت کن (SECRET همان cfg:wh_secret قبلی است — از /admin/info یا D1 قدیمی)
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<آدرس>/webhook" -d "secret_token=<SECRET>" \
  -d 'allowed_updates=["message","callback_query","channel_post","edited_channel_post"]'
# ۲) چک
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```
- ساده‌تر: در خودِ ربات (پنلِ ادمین) دکمهٔ **«ثبت وبهوک»** را بزن — چون کد همان URLِ درخواست را ثبت می‌کند.
- **بازگشت به کلودفلر (فوری، اگر لازم شد):**
```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://noisy-silence-aee4.guts-nuclei-sloped.workers.dev/webhook" -d "secret_token=<SECRET>"
```

---

## ۶) بکاپ — سه لایه، همه خودکار

| لایه | چه‌وقت | کجا |
|---|---|---|
| محلی (والیوم) | هر ۶ ساعت + قبل از هر ری‌استارت | `/data/backups/xpanel-<تاریخ>.db.gz` (۶ نسخهٔ آخر) |
| گیت‌هاب | هر ۶ ساعت + قبل از ری‌استارت | `backups/latest.db.gz` در همین ریپو |
| بکاپِ خودِ ربات | مثل قبل (۰۰:۰۷ و ۱۲:۰۷) | ریپوی `xpanel/backups/` |

```bash
# بکاپِ دستی همین حالا
curl -X POST "https://<آدرس>/admin/backup" -H "x-admin-token: …"
# دانلودِ فایلِ دیتابیس (برای نگه‌داشتن روی گوشی/درایو)
curl -H "x-admin-token: …" "https://<آدرس>/admin/export" -o xpanel.db.gz
# وضعیت
curl -H "x-admin-token: …" "https://<آدرس>/admin/info"
```

**بازگرداندن:**
```bash
curl -X POST "https://<آدرس>/admin/restore?force=1" -H "x-admin-token: …"   # از گیت‌هاب
# یا فایلِ دلخواه:
curl -X POST "https://<آدرس>/admin/import" -H "x-admin-token: …" --data-binary @xpanel.db.gz
```

---

## ۷) 🔁 انتقال به اکانت / سرورِ تازه (۰ تا ۱۰۰)

وقتی کردیتِ این اکانت تمام شد یا خواستی جای دیگری بروی:

**گامِ ۱ — بکاپِ نهایی از منبعِ فعلی**
```bash
curl -X POST "https://<آدرس-قدیمی>/admin/backup" -H "x-admin-token: …"   # گیت‌هاب به‌روز می‌شود
```

**گامِ ۲ — پروژهٔ تازه**
1. در اکانت/سرورِ جدید: **New Project → Deploy from GitHub repo** (همین ریپو).
2. **والیوم روی `/data`** + همان متغیرها (`ADMIN_TOKEN` می‌تواند همان قبلی باشد).
3. صبر کن `/health` جواب بدهد. چون `AUTO_RESTORE=1` است، **خودش آخرین بکاپِ گیت‌هاب را برمی‌گرداند** و ربات با همهٔ کاربران بالا می‌آید.

اگر خودکار برنگشت:
```bash
curl -X POST "https://<آدرس-جدید>/admin/restore?force=1" -H "x-admin-token: …"
curl -H "x-admin-token: …" "https://<آدرس-جدید>/admin/info"      # تعداد ردیف‌ها را چک کن
```

**گامِ ۳ — سوییچِ وبهوک** (بخشِ ۵).
**گامِ ۴ — خاموش‌کردنِ سرویسِ قدیمی** (تا دو ربات هم‌زمان جواب ندهند — تلگرام فقط یکی را می‌بیند، ولی بهتر است قدیمی خاموش شود).
**چک‌لیستِ بعد از انتقال:**
- [ ] `/health` = نسخهٔ درست
- [ ] `/admin/info` ⇒ `rows` برابر با منبعِ قبلی
- [ ] `getWebhookInfo` ⇒ همان URLِ جدید، `pending_update_count` کم، بدونِ `last_error`
- [ ] در تلگرام: یک `/start` + گرفتنِ یک کانفیگ (تستِ زنده)
- [ ] بکاپِ دستی یکی بزن و ببین در گیت‌هاب کامیت می‌شود

---

## ۸) هزینه، کردیت، و یک هشدارِ صادقانه
- ریلوی به اکانتِ تازه **کردیتِ رایگانِ محدود (۳۰ روزه/۵ دلاری)** می‌دهد؛ بعدش پلن **Hobby (۵$ در ماه)** لازم است.
- ⚠️ **ساختِ پشتِ‌سرِهمِ اکانتِ تازه فقط برای گرفتنِ کردیتِ رایگان خلافِ قوانینِ ریلوی است** و به بستنِ اکانت (و از دست رفتنِ سرویسِ در حالِ اجرا) می‌انجامد. راهِ درست: پلنِ ۵$ یا یک **VPSِ ارزان** (همین ریپو آنجا هم بدونِ تغییر اجرا می‌شود: `node server.mjs`).
- مصرفِ این ربات سبک است (یک کانتینرِ کوچک + SQLite) ⇒ عملاً همان ~۵$ در ماه یا کمتر.
- ⛔️ یادآوریِ قانونیِ قبلی: روی ریلوی چیزی که ترافیکِ VPN را رد کند (پروکسی/ری‌سِل) ممنوع است — این ربات فقط یک **کنترل‌پنل** است و خودش ترافیک رد نمی‌کند، پس مشکلی ندارد.

---

## ۹) عیب‌یابی

| نشانه | علت | راهِ حل |
|---|---|---|
| بیلد می‌افتد روی `better-sqlite3` | نودِ قدیمی | `Dockerfile` خودش `node:20` است؛ بیلدر را روی **Dockerfile** بگذار (نه Nixpacks) |
| `/health` بالا نمی‌آید | پورتِ اشتباه | ریلوی `PORT` را خودش می‌دهد؛ کد `process.env.PORT` را می‌خواند ⇒ دست نزن |
| داده بعد از هر دیپلوی می‌پرد | والیوم وصل نیست | والیوم روی `/data` + `SQLITE_PATH=/data/xpanel.db` |
| ربات جواب نمی‌دهد ولی `/health` سالم است | وبهوک هنوز روی کلودفلر است | بخشِ ۵ |
| بکاپ به گیت‌هاب نمی‌رود | توکن/ریپو | `BACKUP_REPO` و `BACKUP_GH_TOKEN` (دسترسی `Contents: read/write`) |
| «file is not a database» بعد از restore | فایلِ نیمه | از `/admin/restore` (بکاپِ `.gz` سالم) استفاده کن، نه کپیِ دستیِ `-wal` |
| کرون اجرا نمی‌شود | `SKIP_CRON` روشن است | متغیر را بردار |

## ۱۰) فایل‌ها
| فایل | کار |
|---|---|
| `Worker.js` | **همان** کدِ ربات (f72) — دست نزن |
| `server.mjs` | اجراکنندهٔ Node + لایهٔ D1⇒SQLite + KV + کرون + بکاپ/انتقال |
| `migrate.mjs` | انتقالِ یک‌بارهٔ D1 کلودفلر ⇒ SQLite |
| `Dockerfile` · `railway.json` | بیلد و تنظیماتِ ریلوی |
| `backups/latest.db.gz` | آخرین بکاپِ خودکار (توسط خودِ سرویس ساخته می‌شود) |
