// ─────────────────────────────────────────────────────────────────────────────
//  server.mjs — اجرای همان Worker.js روی Node (ریلوی)
//  • HTTP سرور برای درخواست‌ها (وبهوک تلگرام و …)
//  • حلقهٔ هر دقیقه به‌جای cron کلودفلر
//  • D1 ⇒ SQLite محلی (همان SQL، همان معناشناسی)
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = process.env.WORKER_PATH || join(__dirname, "..", "xpanel", "Worker.js");
const DB_PATH = process.env.SQLITE_PATH || join(__dirname, "data", "xpanel.db");
const PORT = Number(process.env.PORT || 8080);

mkdirSync(dirname(DB_PATH), { recursive: true });
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");

// ── لایهٔ سازگاریِ D1 روی SQLite ─────────────────────────────────────────────
const san = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0)
  : (v !== null && typeof v === "object" && !(v instanceof ArrayBuffer)) ? JSON.stringify(v) : v);

function makeStmt(sql) {
  const direct = (vals) => ({
    async first(colName) { try { const row = sqlite.prepare(sql).get(...vals); return row === undefined ? null : (colName ? row[colName] : row); } catch (e) { throw new Error(String(e.message || e)); } },
    async run() { try { const info = sqlite.prepare(sql).run(...vals); return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), duration: 0 } }; } catch (e) { throw new Error(String(e.message || e)); } },
    async all() { try { return { success: true, results: sqlite.prepare(sql).all(...vals), meta: {} }; } catch (e) { throw new Error(String(e.message || e)); } },
  });
  return {
    ...direct([]),                       // کد جاهایی prepare(sql).run() را بدون bind صدا می‌زند
    bind(...args) {
      const vals = args.map(san);
      return {
        async first(colName) {
          try {
            const row = sqlite.prepare(sql).get(...vals);
            if (row === undefined) return null;
            return colName ? row[colName] : row;
          } catch (e) { throw new Error(String(e.message || e)); }
        },
        async run() {
          try {
            const info = sqlite.prepare(sql).run(...vals);
            return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), duration: 0 } };
          } catch (e) { throw new Error(String(e.message || e)); }
        },
        async all() {
          try {
            return { success: true, results: sqlite.prepare(sql).all(...vals), meta: {} };
          } catch (e) { throw new Error(String(e.message || e)); }
        },
        async raw() {
          const rows = sqlite.prepare(sql).raw().all(...vals);
          return rows;
        },
      };
    },
  };
}
const DB = {
  prepare: (sql) => makeStmt(sql),
  async batch(stmts) { return Promise.all(stmts.map((s) => (s && s.__run ? s.__run() : null))); },
  async exec(sql) { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  dump() { throw new Error("dump not supported"); },
};

// ── KV قلابی (کد فقط وقتی D1 نباشد از آن استفاده می‌کند) ─────────────────────
const mem = new Map();
const KV = {
  async get(k) { const e = mem.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { mem.delete(k); return null; } return e.v; },
  async put(k, v) { mem.set(k, { v }); },
  async delete(k) { mem.delete(k); },
};

// ── محیط (env) دقیقاً مثل بایندینگ‌های کلودفلر ──────────────────────────────
const env = {
  DB, XPanelBot: KV, KV,
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("VAR_")).map(([k, v]) => [k.slice(4), v])),
};

const worker = (await import(WORKER_PATH)).default;
const ctx = { waitUntil: (p) => { try { Promise.resolve(p).catch(() => {}); } catch {} }, passThroughOnException: () => {} };

// ── سرور HTTP ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || "localhost"}${req.url}`;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url, { method: req.method, headers: req.headers, body });
    const resp = await worker.fetch(request, env, ctx);
    res.statusCode = resp.status;
    resp.headers.forEach((v, k) => { try { res.setHeader(k, v); } catch {} });
    const buf = Buffer.from(await resp.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error("server error:", e && e.stack || e);
    res.statusCode = 500; res.end("internal error");
  }
});

// ── حلقهٔ کرون: هر دقیقه، مثل `*/1 * * * *` کلودفلر ─────────────────────────
let lastCron = 0;
async function cronTick() {
  const now = Date.now();
  if (now - lastCron < 55000) return;
  lastCron = now;
  try { await worker.scheduled({ scheduledTime: now, cron: "*/1 * * * *" }, env, ctx); }
  catch (e) { console.error("cron error:", (e && e.message) || e); }
}
if (!process.env.SKIP_CRON) setInterval(cronTick, 15000);   // در تست‌ها خاموش می‌شود

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ xpanel on Node — http://0.0.0.0:${PORT} · sqlite=${DB_PATH}`);
  setTimeout(cronTick, 3000);
});
