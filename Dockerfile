FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/data/tournament.db COOKIE_SECURE=1 TRUST_PROXY=1
RUN mkdir -p /data
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
