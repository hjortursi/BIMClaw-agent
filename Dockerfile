FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    docker.io \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/container ./container
COPY --from=builder /app/groups ./groups
COPY --from=builder /app/config-examples ./config-examples
COPY --from=builder /app/.env.example ./.env.example
COPY docker/entrypoint.sh /usr/local/bin/bimclaw-entrypoint

RUN chmod +x /usr/local/bin/bimclaw-entrypoint \
    && mkdir -p store data logs

ENV NODE_ENV=production
ENV BIMCLAW_API_ENABLED=true
ENV BIMCLAW_API_HOST=0.0.0.0
ENV BIMCLAW_API_PORT=8787

EXPOSE 8787

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bimclaw-entrypoint"]
