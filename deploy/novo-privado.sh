#!/bin/bash
# Provisiona uma operacao PROPRIA do dono (outro nicho / outra marca) — NAO e cliente.
#
# Diferencas pro novo-cliente.sh:
#   - mora em /root/sdr-privado: a aba Admin do painel varre so /root/sdr-clientes,
#     entao esta operacao NAO aparece na lista de clientes
#   - roda no PLANO da VPS (claude -p), nao na API paga: custo zero de token
#   - nao herda o Telegram da operacao principal (nao manda alerta pro chat de la)
#   - prompt generico/neutro, nao o da Facilita
#
# Uso: ./novo-privado.sh <slug> <email> <senha> "<Nome da operação>" [subdominio]
set -e

SLUG=$1; EMAIL=$2; SENHA=$3; NOME=${4:-$SLUG}; SUB=${5:-crm-$SLUG}
[ -z "$SENHA" ] && { echo "uso: $0 <slug> <email> <senha> \"<Nome>\" [subdominio]"; exit 1; }
[[ "$SLUG" =~ ^[a-z0-9-]+$ ]] || { echo "slug so minusculas/numeros/hifen"; exit 1; }

BASE=/root/sdr-privado/$SLUG
[ -d "$BASE" ] && { echo "'$SLUG' ja existe em $BASE"; exit 1; }

# faixa de porta propria (clientes usam 8801+)
PORT=8901
while ss -tln | grep -q ":$PORT "; do PORT=$((PORT+1)); done

PRINC=/root/facilita-sdr/.env
UAZ_URL=$(grep '^UAZAPI_URL=' $PRINC | cut -d= -f2)
UAZ_ADMIN=$(grep '^UAZAPI_ADMIN_TOKEN=' $PRINC | cut -d= -f2)
OAUTH=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' $PRINC | cut -d= -f2)
# credenciais do Google (mesmo OAuth client do Facilita) — sem isso o botao
# "Conectar agenda" nao funciona
G_ID=$(grep '^GOOGLE_CLIENT_ID=' $PRINC | cut -d= -f2)
G_SECRET=$(grep '^GOOGLE_CLIENT_SECRET=' $PRINC | cut -d= -f2)
TRANSCR=$(grep '^TRANSCRICAO_URL=' $PRINC | cut -d= -f2 || true)
[ -z "$OAUTH" ] && { echo "CLAUDE_CODE_OAUTH_TOKEN nao encontrado no .env principal"; exit 1; }

DOMINIO="$SUB.2-25-138-60.sslip.io"
PAINEL_TOKEN=$(openssl rand -hex 12)
WEBHOOK_SECRET=$(openssl rand -hex 16)
SENHA_HASH=$(printf %s "$SENHA" | sha256sum | cut -d' ' -f1)

mkdir -p "$BASE/dados"
cat > "$BASE/.env" <<EOF
PORT=8795
APP_URL=https://$DOMINIO
PAINEL_SENHA=$PAINEL_TOKEN
PAINEL_EMAIL=$EMAIL
PAINEL_SENHA_LOGIN_HASH=$SENHA_HASH
WEBHOOK_SECRET=$WEBHOOK_SECRET
UAZAPI_URL=$UAZ_URL
UAZAPI_ADMIN_TOKEN=$UAZ_ADMIN
CLAUDE_CODE_OAUTH_TOKEN=$OAUTH
GOOGLE_CLIENT_ID=$G_ID
GOOGLE_CLIENT_SECRET=$G_SECRET
SDR_PROMPT=sdr-generico.md
DELAY_MIN=26
DELAY_MAX=34
DADOS_DIR=/dados
CLIENTE_NOME=$NOME
SDR_MARCA=$NOME
BIND_HOST=0.0.0.0
TRANSCRICAO_URL=$TRANSCR
EOF
chmod 600 "$BASE/.env"

docker run -d --name "sdr-$SLUG" --restart unless-stopped \
  -p 127.0.0.1:$PORT:8795 \
  --env-file "$BASE/.env" \
  -v "$BASE/dados":/dados \
  --memory=300m \
  facilita-sdr:latest >/dev/null

# subdominio no Caddy (idempotente)
if ! grep -q "$DOMINIO" /etc/caddy/Caddyfile; then
  printf '\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMINIO" "$PORT" >> /etc/caddy/Caddyfile
  systemctl reload caddy
fi

sleep 6
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" || echo erro)

echo "=============================================="
echo "✅ Operação '$NOME' no ar (health: $STATUS)"
echo ""
echo "  Painel:  https://facilita-sdr.vercel.app"
echo "  API (campo 'avançado' no 1º login): https://$DOMINIO"
echo "  Email:   $EMAIL"
echo "  Senha:   $SENHA"
echo ""
echo "  IA: plano da VPS (claude -p) — custo ZERO de token"
echo "  Não aparece na aba Admin do painel principal"
echo "  Sem Telegram: pra receber alerta, cadastre um bot próprio no painel"
echo ""
echo "  interno: container sdr-$SLUG · porta $PORT · dados em $BASE"
echo "  se for conectar agenda, cadastre no Google Console:"
echo "     https://$DOMINIO/api/gcal/callback"
echo "=============================================="
