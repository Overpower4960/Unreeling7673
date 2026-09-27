#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
#  move_to_account.py — انتقالِ کاملِ ربات به **اکانتِ تازهٔ ریلوی** بدونِ از دست
#  رفتنِ یک ردیف داده.
#
#  ترتیبِ کار (هیچ‌وقت داده بی‌بکاپ نمی‌ماند):
#    ۱) preflight : ابزار/توکن‌ها را چک می‌کند و وضعیتِ نسخهٔ زنده را می‌خواند
#    ۲) backup    : روی سرویسِ فعلی یک بکاپِ **تازه** می‌گیرد و در گیت‌هاب پوش می‌کند
#    ۳) deploy    : روی اکانتِ تازه پروژه/سرویس/والیوم(/data)/متغیرها + دیپلوی
#    ۴) verify    : /health و /admin/info را می‌خوانَد؛ ردیف‌ها باید ≥ منبع باشند
#                   (با AUTO_RESTORE=1 خودِ سرویس، آخرین بکاپ را ری‌استور می‌کند)
#    ۵) webhook   : وبهوکِ تلگرام را روی دامنهٔ تازه سوییچ می‌کند (+ تستِ getWebhookInfo)
#    ۶) report    : خلاصه + دستورِ خاموش‌کردنِ سرویسِ قدیمی و خطِ بازگشت
#
#  اجرا:
#    NEW_RAILWAY_TOKEN=<توکنِ اکانتِ تازه> python3 move_to_account.py
#  فقط یک مرحله:
#    NEW_RAILWAY_TOKEN=… python3 move_to_account.py --only backup
#
#  ⚠️ سرویسِ قدیمی تا پایانِ مرحلهٔ ۵ روشن می‌ماند؛ بعد از آن هم **پاک نمی‌شود**
#     (خطِ بازگشت در پایان چاپ می‌شود).
# ─────────────────────────────────────────────────────────────────────────────
import argparse, json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))          # پوشهٔ xpanel-railway
SRC_URL = os.environ.get("SRC_URL", "https://xpanel-production-3bb5.up.railway.app").rstrip("/")
NEW_URL = os.environ.get("NEW_URL", "")                     # بعد از گرفتنِ دامنه پر می‌شود
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
NEW_TOKEN = os.environ.get("NEW_RAILWAY_TOKEN", "")
GH_TOKEN = os.environ.get("GH_TOKEN", "")
OLD_TOKEN = os.environ.get("RAILWAY_TOKEN", "")
BACKUP_REPO = "baddarksss/xpanel-railway"
PROJECT_NAME = os.environ.get("PROJECT_NAME", "xpanel")
OLD_PROJECT_ID = os.environ.get("OLD_PROJECT_ID", "20269781-e16f-4746-8902-0bf1068d0b13")
TMP = os.environ.get("MOVE_TMP", "/tmp/railway-move")
BUNNY = "🐰"

def log(msg): print(msg, flush=True)
def die(msg): log("❌ " + msg); sys.exit(1)

# ── CLI ─────────────────────────────────────────────────────────────────────
def find_railway():
    for c in (os.environ.get("RAILWAY_BIN"), shutil.which("railway"), "/tmp/node_modules/.bin/railway",
              os.path.expanduser("~/node_modules/.bin/railway")):
        if c and os.path.exists(c): return c
    die("railway CLI پیدا نشد. نصب: npm i -g @railway/cli")
RAIL = None

def rail(*args, token=None, check=True, capture=True, cwd=None):
    """اجرای CLI با توکنِ درست (RAILWAY_TOKEN را unset می‌کنیم — وگرنه Unauthorized)."""
    env = dict(os.environ)
    env.pop("RAILWAY_TOKEN", None)
    if token: env["RAILWAY_API_TOKEN"] = token
    else: env.pop("RAILWAY_API_TOKEN", None)
    p = subprocess.run([RAIL, *args], cwd=cwd or ROOT, env=env, text=True,
                       stdout=subprocess.PIPE if capture else None,
                       stderr=subprocess.STDOUT if capture else None, timeout=600)
    out = (p.stdout or "").strip()
    if check and p.returncode != 0 and "deprecated" not in out:
        die(f"railway {' '.join(args)} → کد {p.returncode}\n{out[-500:]}")
    return out

def http(url, method="GET", body=None, headers=None, timeout=60):
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
        headers={"Content-Type": "application/json", "User-Agent": "xpanel-mover", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try: return r.status, json.loads(raw)
            except Exception: return r.status, raw[:300].decode(errors="ignore")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, e.read()[:200].decode(errors="ignore")
    except Exception as e:
        return 0, str(e)[:200]

def src_admin(path, method="GET", body=None):
    if not ADMIN_TOKEN: die("ADMIN_TOKEN لازم است (توکنِ محلی: xpanel-railway/.admin_token)")
    return http(SRC_URL + path, method, body, {"x-admin-token": ADMIN_TOKEN})

# ── مراحل ───────────────────────────────────────────────────────────────────
summary = {}

def preflight():
    global RAIL
    RAIL = find_railway()
    log(f"{BUNNY} CLI: {RAIL} · {rail('--version')}")
    st, info = src_admin("/admin/info")
    if st != 200 or not isinstance(info, dict): die(f"سرویسِ مبدأ جواب نداد: {st} {info}")
    st2, h = http(SRC_URL + "/health")
    log(f"   مبدأ: rows={info.get('rows'):,} · db={info.get('dbPath')}")
    log(f"   نسخهٔ زنده: {h.get('codeStamp') if isinstance(h, dict) else h}")
    summary["source_rows"] = info.get("rows")
    if not NEW_TOKEN: die("NEW_RAILWAY_TOKEN را بده (توکنِ اکانتِ تازهٔ ریلوی)")
    log("   توکنِ تازه: ✅ دیده شد")

def backup():
    st, r = src_admin("/admin/backup", "POST", {})
    if st != 200: die(f"بکاپ نگرفت: {st} {r}")
    log(f"   💾 بکاپِ تازه: {r.get('rows'):,} ردیف · {r.get('bytes'):,} بایت · پوش → {r.get('pushed')}")
    if str(r.get("pushed", "")).startswith("error"): die("پوش به گیت‌هاب انجام نشد — انتقالِ امن نیست")
    summary["backup"] = r

def deploy():
    """دیپلوی روی اکانتِ تازه — در یک کپیِ موقت انجام می‌شود تا لینکِ پوشهٔ اصلی
    به پروژهٔ قبلی دست‌نخورده بماند (اجرای دستورهای اضطراری روی اکانتِ قبلی)."""
    global NEW_URL
    if os.path.exists(TMP): shutil.rmtree(TMP)
    shutil.copytree(ROOT, TMP, ignore=shutil.ignore_patterns("node_modules", "data", ".git", "*.db*", "*.log"))
    log(f"   کپیِ موقت: {TMP}")
    log(f"   پروژهٔ «{PROJECT_NAME}» روی اکانتِ تازه…")
    log("   " + rail("init", "-n", PROJECT_NAME, "--json", token=NEW_TOKEN, cwd=TMP).replace("\n", " ")[:160])
    rail("add", "-s", PROJECT_NAME, token=NEW_TOKEN, cwd=TMP)
    log("   والیوم روی /data…")
    log("   " + rail("volume", "add", "-m", "/data", "--json", token=NEW_TOKEN, cwd=TMP)[:160])
    log("   متغیرها…")
    vars_cmd = ["variables"]
    for k, v in (("SQLITE_PATH", "/data/xpanel.db"), ("BACKUP_DIR", "/data/backups"),
                 ("ADMIN_TOKEN", ADMIN_TOKEN), ("BACKUP_REPO", BACKUP_REPO),
                 ("BACKUP_GH_TOKEN", GH_TOKEN), ("BACKUP_EVERY_H", "6"),
                 ("AUTO_RESTORE", "1"), ("TZ", "UTC")):
        vars_cmd += ["--set", f"{k}={v}"]
    rail(*vars_cmd, token=NEW_TOKEN, cwd=TMP)
    log("   دیپلوی (چند دقیقه)…")
    rail("up", "--detach", "-y", token=NEW_TOKEN, cwd=TMP)

def wait_deploy():
    last = ""
    for i in range(40):
        try:
            arr = json.loads(rail("deployment", "list", "--json", token=NEW_TOKEN, check=False) or "[]")
            st = arr[0]["status"] if arr else "?"
        except Exception:
            st = "?"
        if st != last: log(f"   [{i}] {st}")
        last = st
        if st in ("SUCCESS", "FAILED", "CRASHED"): break
        time.sleep(15)
    if last != "SUCCESS": die(f"دیپلوی به پایانِ خوب نرسید: {last}")
    out = rail("domain", "--json", token=NEW_TOKEN, check=False)
    try: NEW_URL = json.loads(out.split("\n")[-1])["domain"] if "{" in out else json.loads(out)["domain"]
    except Exception: die("دامنهٔ عمومی ساخته نشد (Public Networking → Generate Domain): " + out[:200])
    log(f"   🔗 {NEW_URL}")
    summary["new_url"] = NEW_URL
    return NEW_URL

def verify(new_url):
    for i in range(20):
        st, h = http(new_url + "/health", timeout=25)
        if st == 200: break
        time.sleep(6)
    else: die("‏/health روی سرویسِ تازه بالا نیامد")
    log(f"   /health ⇒ {h}")
    rows = 0
    for i in range(30):
        st, info = http(new_url + "/admin/info", headers={"x-admin-token": ADMIN_TOKEN}, timeout=25)
        rows = (info or {}).get("rows", 0) if isinstance(info, dict) else 0
        if rows: break
        log(f"   … ری‌استور در جریان (rows={rows})")
        time.sleep(10)
    src = summary.get("source_rows", 0)
    log(f"   ردیف‌های سرویسِ تازه: {rows:,} (مبدأ: {src:,})")
    if rows < src * 0.98: die("داده کامل ری‌استور نشد — سوییچِ وبهوک را انجام نده")
    summary["new_rows"] = rows
    return rows

def webhook(new_url):
    st, r = http(new_url + "/admin/setwebhook", "POST", {}, {"x-admin-token": ADMIN_TOKEN}, timeout=60)
    log(f"   ثبتِ وبهوک: {st} {r}")
    if st != 200 or not (r or {}).get("ok"): die("ثبتِ وبهوک ناموفق")
    st, info = http(new_url + "/admin/sql", "POST", {"sql": "SELECT value FROM store WHERE key='cfg:bot_token'"}, {"x-admin-token": ADMIN_TOKEN})
    tok = None
    try:
        v = info["result"][0]["value"]
        for _ in range(4):
            if isinstance(v, str) and v[:1] in "{[":
                try: v = json.loads(v); continue
                except Exception: break
            if isinstance(v, dict) and "data" in v: v = v["data"]; continue
            break
        tok = str(v)
    except Exception: pass
    if tok:
        st, wi = http(f"https://api.telegram.org/bot{tok}/getWebhookInfo")
        url = (wi or {}).get("result", {}).get("url")
        log(f"   تلگرام: url={url} · pending={(wi or {}).get('result',{}).get('pending_update_count')} · err={(wi or {}).get('result',{}).get('last_error_message')}")
        summary["telegram"] = url

def report():
    log("\n──────── خلاصه ────────")
    for k, v in summary.items(): log(f"  {k}: {v}")
    n_new = summary.get("new_rows") or 0
    n_src = summary.get("source_rows") or 0
    log(f"""
✅ ربات روی اکانتِ تازه بالا آمد: {summary.get('new_url') or '—'}
   داده: {n_new:,} ردیف (مبدأ: {n_src:,})
   وبهوکِ تلگرام: {summary.get('telegram') or '—'}

🔻 خاموش‌کردنِ سرویسِ قدیمی (توصیه‌شده تا پیامِ تکراری ندهد):
   env -u RAILWAY_TOKEN RAILWAY_API_TOKEN=<توکنِ اکانتِ قبلی> \
     {RAIL} down -p {OLD_PROJECT_ID} -y
   (والیوم و داده‌اش پاک نمی‌شود؛ برگشت = همان دستور با `redeploy`)

↩️ بازگشتِ فوری به قبلی (اگر جایی مشکل داشت):
   env -u RAILWAY_TOKEN RAILWAY_API_TOKEN=<توکنِ قبلی> {RAIL} redeploy -p {OLD_PROJECT_ID} -y
   و در تلگرام وبهوک را به {SRC_URL}/webhook برگردان (یا /admin/setwebhook روی همان سرویس).

📦 پوشهٔ کاریِ پروژهٔ تازه: {TMP}   (لینکِ پوشهٔ اصلی به پروژهٔ قبلی دست‌نخورده ماند)
""")

STAGES = {"preflight": preflight, "backup": backup, "deploy": deploy, "verify": verify, "webhook": webhook, "report": report}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="all",
                    choices=["all", "preflight", "backup", "deploy", "verify", "webhook", "report"])
    a = ap.parse_args()
    o = a.only
    if o in ("all", "preflight"):
        log("\n▶ preflight"); preflight()
    if o in ("all", "backup"):
        log("\n▶ backup"); backup()
    if o in ("all", "deploy"):
        log("\n▶ deploy"); deploy()
        log("\n▶ verify"); url = wait_deploy(); verify(url)
        log("\n▶ webhook"); webhook(url)
        log("\n▶ report"); report()
    elif o == "verify":
        log("\n▶ verify"); verify(NEW_URL or die("NEW_URL را بده"))
    elif o == "webhook":
        log("\n▶ webhook"); webhook(NEW_URL or die("NEW_URL را بده"))
    elif o == "report":
        log("\n▶ report"); report()

if __name__ == "__main__":
    main()
