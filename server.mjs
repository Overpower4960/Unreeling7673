// ─────────────────────────────────────────────────────────────────────────────
//  server.mjs — اجرای همان Worker.js روی Node (ریلوی / هر VPS)
//
//  • HTTP سرور: همهٔ مسیرهای ربات (وبهوکِ تلگرام، /health، /diag، /d/<token>، …)
//  • حلقهٔ هر دقیقه به‌جای cron کلودفلر
//  • D1 ⇒ SQLite (better-sqlite3): همان SQL، همان معناشناسی، **بدونِ سقفِ روزانه**
//  • KV ⇒ جدولِ `kv` در همان SQLite (چند-روز ماندگار)
//  • 💾 بکاپ: خودکار روی والیوم + پوش به گیت‌هاب (هر BACKUP_EVERY_H ساعت)
//  • 🔁 انتقالِ داده: /admin/migrate (از D1 کلودفلر) · /admin/export · /admin/import · /admin/restore
//  • 🧯 خاموشیِ تمیز (SIGTERM): یک بکاپِ آخر قبل از ری‌استارت می‌گیرد
//
//  متغیرهای محیطی مهم (ریلوی → Variables):
//    SQLITE_PATH=/data/xpanel.db      مسیرِ دیتابیس روی والیوم (به /data والیوم بده)
//    ADMIN_TOKEN=<یک رمزِ دلخواه>      برای مسیرهای /admin/*
//    BACKUP_REPO=baddarksss/xpanel-railway   ریپوی بکاپ
//    BACKUP_GH_TOKEN=github_pat_…      توکنِ گیت‌هاب (فقط Contents: read/write)
//    BACKUP_EVERY_H=6                  فاصلهٔ بکاپِ خودکار (ساعت)
//    AUTO_RESTORE=1                    اگر دیتابیس خالی بود، آخرین بکاپِ گیت‌هاب را برگردان
//    VAR_*                             هر متغیری با پیشوندِ VAR_ به env ربات پاس می‌شود
//    SKIP_CRON=1 / SKIP_BACKUP=1       خاموش‌کردن (فقط برای تست)
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from "node:http";
import { existsSync, mkdirSync, copyFileSync, renameSync, statSync, readdirSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = process.env.WORKER_PATH || join(__dirname, "Worker.js");
const DB_PATH = process.env.SQLITE_PATH || join(__dirname, "data", "xpanel.db");
const PORT = Number(process.env.PORT || 8080);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const GH_TOKEN = process.env.BACKUP_GH_TOKEN || process.env.GH_TOKEN || "";
const BACKUP_REPO = process.env.BACKUP_REPO || "";
const BACKUP_EVERY_H = Number(process.env.BACKUP_EVERY_H || 6);
const KEEP_LOCAL = Number(process.env.KEEP_LOCAL_BACKUPS || 6);
const AUTO_RESTORE = String(process.env.AUTO_RESTORE || "") === "1";
const log = (...a) => console.log(new Date().toISOString(), ...a);

mkdirSync(dirname(DB_PATH), { recursive: true });
const BACKUP_DIR = process.env.BACKUP_DIR || join(dirname(DB_PATH), "backups");
mkdirSync(BACKUP_DIR, { recursive: true });

// ── SQLite ───────────────────────────────────────────────────────────────────
let db;
function openDb() {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 8000");
  db.pragma("synchronous = NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)");
  return db;
}
openDb();

// ── لایهٔ سازگاریِ D1 روی SQLite ────────────────────────────────────────────
const san = (v) => (v === undefined ? null
  : typeof v === "boolean" ? (v ? 1 : 0)
  : (v !== null && typeof v === "object" && !(v instanceof ArrayBuffer) && !Buffer.isBuffer(v)) ? JSON.stringify(v)
  : v);

function stmtApi(sql, vals) {
  const run = () => {
    const info = db.prepare(sql).run(...vals);
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), duration: 0, rows_written: info.changes } };
  };
  const first = (col) => {
    const row = db.prepare(sql).get(...vals);
    if (row === undefined) return null;
    return col ? row[col] : row;
  };
  const all = () => ({ success: true, results: db.prepare(sql).all(...vals), meta: {} });
  return {
    async run() { try { return run(); } catch (e) { throw new Error(String(e.message || e)); } },
    async first(col) { try { return first(col); } catch (e) { throw new Error(String(e.message || e)); } },
    async all() { try { return all(); } catch (e) { throw new Error(String(e.message || e)); } },
    async raw() { return db.prepare(sql).raw().all(...vals); },
  };
}
const DB = {
  prepare: (sql) => {
    const api = stmtApi(sql, []);
    return Object.assign(api, {
      bind: (...args) => stmtApi(sql, args.map(san)),
      __run: api.run,
    });
  },
  async batch(stmts) { const out = []; for (const s of stmts) out.push(s && s.__run ? await s.__run() : null); return out; },
  async exec(sql) { db.exec(sql); return { count: 0, duration: 0 }; },
  dump() { throw new Error("dump not supported"); },
};

// ── KV روی SQLite (پایدار، مقدم بر D1 برای زبان و کش‌های کلید-محور) ─────────
const KV = {
  async get(key, type) {
    const r = db.prepare("SELECT value, expires_at FROM kv WHERE key=?").get(key);
    if (!r) return null;
    if (r.expires_at && r.expires_at < Date.now()) { try { db.prepare("DELETE FROM kv WHERE key=?").run(key); } catch {} return null; }
    if (type === "json") { try { return JSON.parse(r.value); } catch { return null; } }
    return r.value;
  },
  async put(key, value, opts = {}) {
    const v = typeof value === "string" ? value : JSON.stringify(value);
    const exp = opts && opts.expirationTtl ? Date.now() + Number(opts.expirationTtl) * 1000 : null;
    db.prepare("INSERT INTO kv(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at").run(key, v, exp);
  },
  async delete(key) { db.prepare("DELETE FROM kv WHERE key=?").run(key); },
  async list({ prefix = "", limit = 1000 } = {}) {
    const rows = db.prepare("SELECT key FROM kv WHERE key LIKE ? LIMIT ?").all(prefix + "%", limit);
    return { keys: rows.map((r) => ({ name: r.key })), list_complete: true };
  },
  async getWithMetadata(key) { return { value: await KV.get(key), metadata: null }; },
};

// ── env دقیقاً مثلِ بایندینگ‌های کلودفلر ─────────────────────────────────────
const passthrough = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => k.startsWith("VAR_"))
  .map(([k, v]) => [k.slice(4), v]));
const env = { DB, DB2: null, DB3: null, XPanelBot: KV, KV, ...passthrough };
const ctx = { waitUntil: (p) => { try { Promise.resolve(p).catch(() => {}); } catch {} }, passThroughOnException: () => {} };

// ── import رباط (ESM) ───────────────────────────────────────────────────────
let worker;
async function loadWorker() { worker = (await import(WORKER_PATH + (WORKER_PATH.includes("?") ? "" : `?v=${Date.now()}`))).default; return worker; }
await loadWorker();

// ── 💾 بکاپ ─────────────────────────────────────────────────────────────────
const state = { lastBackup: null, lastBackupPush: null, lastRestore: null, lastMigrate: null, startedAt: new Date().toISOString(), bootRestored: false };

async function snapshotTo(file) {
  if (existsSync(file)) unlinkSync(file);
  await db.backup(file);                     // بکاپِ آنلاینِ SQLite (بدونِ قفل‌کردن)
  return file;
}
function pruneLocal() {
  try {
    const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db.gz")).sort().reverse();
    for (const f of files.slice(KEEP_LOCAL)) unlinkSync(join(BACKUP_DIR, f));
  } catch (e) { log("prune error", e.message); }
}
async function ghApi(path, method = "GET", body = null) {
  const res = await fetch(`https://api.github.com/repos/${BACKUP_REPO}/${path}`, {
    method,
    headers: { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "xpanel-railway", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json = null; try { json = JSON.parse(txt); } catch {}
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${String(json?.message || txt).slice(0, 120)}`);
  return json;
}
/** یک بکاپ می‌گیرد: محلی روی والیوم + (اختیاری) پوش به گیت‌هاب */
export async function doBackup({ push = true, reason = "auto" } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const raw = join(BACKUP_DIR, `xpanel-${stamp}.db`);
  await snapshotTo(raw);
  const gz = raw + ".gz";
  writeFileSync(gz, gzipSync(readFileSync(raw)));
  unlinkSync(raw);
  pruneLocal();
  let pushed = null;
  if (push && GH_TOKEN && BACKUP_REPO) {
    try {
      const content = readFileSync(gz).toString("base64");
      let sha = null;
      try { sha = (await ghApi("contents/backups/latest.db.gz"))?.sha || null; } catch {}
      const body = { message: `backup ${stamp} (${reason})`, content, branch: "main" };
      if (sha) body.sha = sha;
      const r = await ghApi("contents/backups/latest.db.gz", "PUT", body);
      pushed = r?.content?.sha || "ok";
      state.lastBackupPush = { at: new Date().toISOString(), sha: pushed, bytes: statSync(gz).size };
    } catch (e) { log("backup push failed:", e.message); pushed = "error: " + e.message; }
  }
  state.lastBackup = { at: new Date().toISOString(), file: basename(gz), bytes: statSync(gz).size, rows: rowCount(), pushed };
  log("backup done:", JSON.stringify(state.lastBackup));
  return state.lastBackup;
}
function rowCount() { try { return db.prepare("SELECT count(*) n FROM store").get().n; } catch { return -1; } }

/** آخرین بکاپِ گیت‌هاب را می‌آورد و جای دیتابیس می‌گذارد */
export async function restoreFromGitHub({ force = false } = {}) {
  if (!GH_TOKEN || !BACKUP_REPO) throw new Error("BACKUP_GH_TOKEN/BACKUP_REPO لازم است");
  const rows = rowCount();
  if (rows > 0 && !force) return { ok: false, skipped: true, rows, hint: "دیتابیس خالی نیست؛ برای جای‌گزینی force=1" };
  const meta = await ghApi("contents/backups/latest.db.gz");
  const buf = gunzipSync(Buffer.from(meta.content, "base64"));
  const tmp = join(BACKUP_DIR, "restore.tmp.db");
  writeFileSync(tmp, buf);
  installDbFile(tmp);
  state.bootRestored = true;
  state.lastRestore = { at: new Date().toISOString(), sha: meta.sha, rows: rowCount() };
  log("restored from GitHub:", JSON.stringify(state.lastRestore));
  return { ok: true, ...state.lastRestore };
}
function installDbFile(srcFile) {
  try { db.close(); } catch {}
  if (existsSync(DB_PATH)) {
    const aside = DB_PATH + ".replaced-" + Date.now();
    try { renameSync(DB_PATH, aside); log("old db kept:", aside); } catch {}
  }
  for (const ext of ["-wal", "-shm"]) { try { if (existsSync(DB_PATH + ext)) unlinkSync(DB_PATH + ext); } catch {} }
  copyFileSync(srcFile, DB_PATH);
  openDb();
}

// ── 🔁 انتقالِ داده از D1 کلودفلر ──────────────────────────────────────────
export async function migrateFromD1() {
  const CF = process.env.CF_API_TOKEN, ACC = process.env.CF_ACCOUNT, D1 = process.env.CF_D1;
  if (!CF || !ACC || !D1) throw new Error("CF_API_TOKEN/CF_ACCOUNT/CF_D1 لازم است");
  const d1 = async (sql) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${D1}/query`, {
      method: "POST", headers: { Authorization: `Bearer ${CF}`, "Content-Type": "application/json", "User-Agent": "xpanel-railway" },
      body: JSON.stringify({ sql }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(JSON.stringify(j.errors || j).slice(0, 200));
    return j.result[0].results;
  };
  const up = db.prepare("INSERT INTO store(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at");
  let last = 0, total = 0;
  const t0 = Date.now();
  for (;;) {
    const rows = await d1(`SELECT rowid AS r,key,value,expires_at FROM store WHERE rowid>${last} ORDER BY rowid LIMIT 200`);
    if (!rows.length) break;
    db.transaction((rs) => { for (const x of rs) up.run(x.key, x.value, x.expires_at); })(rows);
    total += rows.length; last = rows[rows.length - 1].r;
    if (total % 2000 === 0) log(`migrate… ${total}`);
  }
  const remote = (await d1("SELECT count(*) n FROM store"))[0].n;
  state.lastMigrate = { at: new Date().toISOString(), copied: total, local: rowCount(), remote, ms: Date.now() - t0 };
  log("migrate done:", JSON.stringify(state.lastMigrate));
  return { ok: true, ...state.lastMigrate };
}

// ── مسیرهای مدیریتی ────────────────────────────────────────────────────────
function json(res, code, obj) { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); }
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0); }
// ── خواندن/نوشتنِ کلیدهای store با همان قالبِ بسته‌بندیِ ربات ({"data":…}) ──
function storeGet(key) {
  const r = db.prepare("SELECT value FROM store WHERE key=?").get(key);
  if (!r) return null;
  try { const o = JSON.parse(r.value); return (o && typeof o === "object" && "data" in o) ? o.data : o; } catch { return r.value; }
}
function storePut(key, value) {
  db.prepare("INSERT INTO store(key,value,expires_at) VALUES(?,?,NULL) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, JSON.stringify({ data: value }));
}

// ── سرور ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    const url = `http://${req.headers.host || "localhost"}${req.url}`;
    const path = new URL(url).pathname;

    if (path.startsWith("/admin/")) {
      const tok = req.headers["x-admin-token"] || new URL(url).searchParams.get("token") || "";
      if (!ADMIN_TOKEN || tok !== ADMIN_TOKEN) return json(res, 403, { ok: false, error: "forbidden (ADMIN_TOKEN می‌خواهد)" });
      if (path === "/admin/info") return json(res, 200, { ok: true, rows: rowCount(), kv: db.prepare("SELECT count(*) n FROM kv").get().n, dbPath: DB_PATH, cron: !process.env.SKIP_CRON, backupEveryH: BACKUP_EVERY_H, backupRepo: BACKUP_REPO || null, ...state });
      if (path === "/admin/migrate") { try { return json(res, 200, await migrateFromD1()); } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); } }
      if (path === "/admin/backup") { try { return json(res, 200, await doBackup({ push: true, reason: "manual" })); } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); } }
      if (path === "/admin/restore") {
        const force = new URL(url).searchParams.get("force") === "1";
        try { return json(res, 200, await restoreFromGitHub({ force })); } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      }
      if (path === "/admin/export") {
        const tmp = join(BACKUP_DIR, "export.db");
        await snapshotTo(tmp);
        const buf = gzipSync(readFileSync(tmp)); unlinkSync(tmp);
        res.writeHead(200, { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="xpanel-${Date.now()}.db.gz"`, "Content-Length": buf.length });
        return res.end(buf);
      }
      if (path === "/admin/import") {
        const body = await readBody(req);
        if (!body.length) return json(res, 400, { ok: false, error: "بدنهٔ خالی — فایلِ .db.gz را بفرست" });
        const raw = url.includes("gz=0") ? body : (() => { try { return gunzipSync(body); } catch { return body; } })();
        const tmp = join(BACKUP_DIR, "import.tmp.db");
        writeFileSync(tmp, raw);
        installDbFile(tmp);
        return json(res, 200, { ok: true, rows: rowCount() });
      }
      if (path === "/admin/reload") { await loadWorker(); return json(res, 200, { ok: true, note: "Worker.js دوباره بارگذاری شد" }); }
      // ── کوئریِ مستقیم (جانشینِ کنسولِ D1 کلودفلر) — فقط SELECT/INSERT/UPDATE/DELETE ──
      if (path === "/admin/sql") {
        let body = {};
        try { body = JSON.parse((await readBody(req)).toString() || "{}"); } catch {}
        const sql = String(body.sql || "").trim();
        const params = Array.isArray(body.params) ? body.params.map(san) : [];
        if (!/^(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) return json(res, 400, { ok: false, error: "فقط SELECT/INSERT/UPDATE/DELETE" });
        try {
          const st = db.prepare(sql);
          const out = /^SELECT/i.test(sql) ? st.all(...params) : st.run(...params);
          return json(res, 200, { ok: true, result: out });
        } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      }
      // ── ثبتِ وبهوکِ تلگرام روی همین دامنه (جانشینِ «نصب» روی کلودفلر) ──
      if (path === "/admin/setwebhook") {
        const q = new URL(url);
        const origin = String(q.searchParams.get("url") || process.env.PUBLIC_URL || `https://${req.headers.host}`).replace(/\/+$/, "");
        const botTok = storeGet("cfg:bot_token"), secret = storeGet("cfg:wh_secret");
        if (!botTok) return json(res, 500, { ok: false, error: "cfg:bot_token در دیتابیس نیست" });
        try {
          const r = await fetch(`https://api.telegram.org/bot${botTok}/setWebhook`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: origin + "/webhook", allowed_updates: ["message", "callback_query", "channel_post", "edited_channel_post"], drop_pending_updates: false, ...(secret ? { secret_token: String(secret) } : {}) }),
          });
          const j = await r.json();
          if (j.ok) { storePut("cfg:webhook_url", origin); storePut("cfg:webhook_initialized", "true"); if (secret) storePut("cfg:wh_secret_applied", secret); }
          return json(res, j.ok ? 200 : 500, { ok: !!j.ok, url: origin + "/webhook", secret: secret ? "دارد" : "ندارد", telegram: j.description || "ok" });
        } catch (e) { return json(res, 500, { ok: false, error: String(e.message || e) }); }
      }
      return json(res, 404, { ok: false, error: "admin route?" });
    }

    const body = (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") ? await readBody(req) : undefined;
    const request = new Request(url, { method: req.method, headers: req.headers, body });
    const resp = await worker.fetch(request, env, ctx);
    res.statusCode = resp.status;
    resp.headers.forEach((v, k) => { if (!["content-length", "content-encoding", "transfer-encoding"].includes(k.toLowerCase())) { try { res.setHeader(k, v); } catch {} } });
    const buf = Buffer.from(await resp.arrayBuffer());
    res.end(buf);
  } catch (e) {
    log("server error:", e && e.stack || e);
    if (!res.headersSent) { res.statusCode = 500; res.end("internal error"); }
  }
});

// ── حلقهٔ کرون (هر دقیقه) ───────────────────────────────────────────────────
let lastCron = 0;
async function cronTick() {
  if (process.env.SKIP_CRON) return;
  const now = Date.now();
  if (now - lastCron < 55000) return;
  lastCron = now;
  try { await worker.scheduled({ scheduledTime: now, cron: "*/1 * * * *" }, env, ctx); }
  catch (e) { log("cron error:", (e && e.message) || e); }
}

// ── بکاپِ خودکار ────────────────────────────────────────────────────────────
let lastBackupAt = 0;
async function backupTick() {
  if (process.env.SKIP_BACKUP) return;
  const everyMs = BACKUP_EVERY_H * 3600 * 1000;
  if (Date.now() - lastBackupAt < everyMs) return;
  lastBackupAt = Date.now();
  try { await doBackup({ push: true, reason: "auto" }); } catch (e) { log("backup error:", e.message); }
}

// ── خاموشیِ تمیز: بکاپِ آخر ────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  log(`got ${sig} — بکاپِ آخر…`);
  try { await Promise.race([doBackup({ push: true, reason: "shutdown" }), new Promise((r) => setTimeout(r, 8000))]); } catch {}
  try { db.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── راه‌اندازی ──────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", async () => {
  log(`✅ xpanel on Node — http://0.0.0.0:${PORT} · sqlite=${DB_PATH} · rows=${rowCount()}`);
  if (AUTO_RESTORE && rowCount() === 0) { try { await restoreFromGitHub({ force: true }); } catch (e) { log("auto-restore skipped:", e.message); } }
  if (!process.env.SKIP_CRON) setTimeout(cronTick, 2500);
  setTimeout(backupTick, 20000);
  setInterval(cronTick, 15000);
  setInterval(backupTick, 10 * 60 * 1000);
});
process.on("unhandledRejection", (e) => log("unhandledRejection:", (e && e.message) || e));
