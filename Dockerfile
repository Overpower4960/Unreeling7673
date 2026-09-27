FROM node:20-bookworm
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production PORT=8080 SQLITE_PATH=/data/xpanel.db
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server.mjs"]
