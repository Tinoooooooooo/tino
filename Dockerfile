# Facilita SDR / Prospecta — container por cliente (SaaS replicado).
# Cada cliente roda uma copia isolada: banco proprio (volume /dados),
# WhatsApp proprio, chave Anthropic propria (SDR_IA_MODO=api).
FROM node:20-bookworm-slim

# build deps do better-sqlite3 + ca-certs pra https
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev --no-audit --no-fund

# claude CLI (o agente chama `claude -p`; com ANTHROPIC_API_KEY no env usa a API)
RUN npm install -g @anthropic-ai/claude-code

COPY . .

ENV DADOS_DIR=/dados
ENV PORT=8795
ENV BIND_HOST=0.0.0.0
VOLUME /dados
EXPOSE 8795

CMD ["node", "server.js"]
