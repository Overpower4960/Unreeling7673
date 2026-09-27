// ─────────────────────────────────────────────────────────────────────────────
//  migrate.mjs — انتقالِ داده از D1 کلودفلر به SQLite محلی (ریلوی)
//
//  اجرا (یک‌بار، قبل از روشن‌کردنِ وبهوک به ریلوی):
//    CF_API_TOKEN=... CF_ACCOUNT=... CF_D1=... node migrate.mjs
//
//  • صفحه‌به‌صفحه (۲۰۰۰ ردیف) از D1 می‌خواند و در SQLite می‌نویسد
//  • idempotent است: هر بار اجرا، ردیف‌ها را به‌روزرسانی می‌کند (upsert)
//  • در پایان شمارشِ دو طرف را مقایسه می‌کند
// ─────────────────────────────────────────────────────────────────────────────
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CF = process.env.CF_API_TOKEN;
const ACC = process.env.CF_ACCOUNT || "03ca547457b14a68fc64908ee5ff8fcf";
const D1 = process.env.CF_D1 || "7a5acc79-4157-4485-9f1b-fbe4dce329ba";
const PATH = process.env.SQLITE_PATH || "/data/xpanel.db";
if (!CF) { console.error("❌ CF_API_TOKEN لازم است"); process.exit(1); }

mkdirSync(dirname(PATH), { recursive: true });
const db = new Database(PATH);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");
db.exec("CREATE INDEX IF NOT EXISTS idx_store_exp ON store(expires_at)");

async function d1(sql) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${D1}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CF}`, "Content-Type": "application/json", "User-Agent": "xpanel-railway-migrate" },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors || j).slice(0, 300));
  return j.result[0].results;
}

const upsert = db.prepare("INSERT INTO store(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at");
let last = 0, total = 0;
for (;;) {
  const rows = await d1(`SELECT rowid AS r,key,value,expires_at FROM store WHERE rowid>${last} ORDER BY rowid LIMIT 2000`);
  if (!rows.length) break;
  const tx = db.transaction((rs) => { for (const x of rs) upsert.run(x.key, x.value, x.expires_at); });
  tx(rows);
  total += rows.length; last = rows[rows.length - 1].r;
  console.log(`   … ${total} ردیف`);
}
const local = db.prepare("SELECT count(*) n FROM store").get().n;
const remote = (await d1("SELECT count(*) n FROM store"))[0].n;
console.log(`── کل: محلی=${local} · کلودفلر=${remote} · ${local === remote ? "✅ یکسان" : "⚠️ اختلاف"}`);
db.close();
