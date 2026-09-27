# ─────────────────────────────────────────────────────────────────────────────
#  xpanel-railway — رباتِ xpanel روی Node + SQLite
#  والیومِ ریلوی را روی /data سوار کن (دیتابیس و بکاپ‌ها همان‌جا می‌مانند).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm

WORKDIR /app

# ۱) فقط مانیفست‌ها ⇒ لایهٔ کشِ بهتر
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ۲) کد
COPY Worker.js server.mjs migrate.mjs ./

ENV NODE_ENV=production \
    PORT=8080 \
    SQLITE_PATH=/data/xpanel.db \
    BACKUP_DIR=/data/backups \
    BACKUP_EVERY_H=6 \
    AUTO_RESTORE=1

# ⚠️ خطِ VOLUME را عمداً نداریم: ریلوی «Docker VOLUME» را پشتیبانی نمی‌کند
#    و والیومِ خودش را می‌خواهد (Settings → Volumes → Mount path = /data).
RUN mkdir -p /data/backups
EXPOSE 8080

# ریلوی خودش healthcheckPath را می‌زند؛ این برای اجرای دستی است
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
