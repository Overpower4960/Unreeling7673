#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  migrate.mjs — انتقالِ دادهٔ D1 کلودفلر ⇒ SQLite (ریلوی/هرجا)
//
//  استفاده:
//    CF_API_TOKEN=… CF_ACCOUNT=… CF_D1=… SQLITE_PATH=./data/xpanel.db node migrate.mjs
//
//  • خواندنی است (به D1 چیزی نمی‌نویسد) ⇒ سقفِ نوشتنِ کلودفلر را مصرف نمی‌کند.
//  • قابلِ تکرار است (upsert) — اگر نیمه‌کاره ماند، دوباره اجرا کن.
//  • در پایان تعداد ردیف‌های محلی و ریموت را مقایسه می‌کند.
// ─────────────────────────────────────────────────────────────────────────────
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CF = process.env.CF_API_TOKEN, ACC = process.env.CF_ACCOUNT, D1 = process.env.CF_D1;
const DB_PATH = process.env.SQLITE_PATH || "./data/xpanel.db";
if (!CF || !ACC || !D1) { console.error("❌ CF_API_TOKEN / CF_ACCOUNT / CF_D1 لازم است"); process.exit(1); }

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");

async function d1(sql) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${D1}/query`, {
    method: "POST",
    headers: { Authorization: "Bearer " + CF, "Content-Type": "application/json", "User-Agent": "xpanel-migrate" },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors || j).slice(0, 300));
  return j.result[0].results;
}

const up = db.prepare("INSERT INTO store(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at");
const remoteCount = (await d1("SELECT count(*) n FROM store"))[0].n;
console.log(`📡 D1 ریموت: ${remoteCount.toLocaleString("en")} ردیف ⇒ ${DB_PATH}`);

let last = 0, total = 0;
const t0 = Date.now();
for (;;) {
  const rows = await d1(`SELECT rowid AS r,key,value,expires_at FROM store WHERE rowid>${last} ORDER BY rowid LIMIT 200`);
  if (!rows.length) break;
  db.transaction((rs) => { for (const x of rs) up.run(x.key, x.value, x.expires_at); })(rows);
  total += rows.length; last = rows[rows.length - 1].r;
  process.stdout.write(`\r   … ${total.toLocaleString("en")} ردیف`);
}
const local = db.prepare("SELECT count(*) n FROM store").get().n;
console.log(`\n✅ تمام: ${local.toLocaleString("en")} ردیف محلی (از ${total.toLocaleString("en")} ردیفِ خوانده‌شده) در ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(local >= remoteCount ? "   ✔️ محلی کامل است" : `   ⚠️ کم است (${remoteCount - local} ردیف) — دوباره اجرا کن`);
db.close();
