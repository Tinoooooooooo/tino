#!/bin/bash
# Aponta um dominio de verdade pra uma instalacao do Prospecta (no lugar do sslip.io).
#
# Por que nao e so mexer no Caddy: o APP_URL do .env alimenta DUAS coisas alem do
# painel — o redirect do OAuth do Google (botao "Conectar agenda") e, pior, a URL
# do webhook que fica GRAVADA na uazapi por instancia. Se so trocar o Caddy e o
# .env, o WhatsApp continua entregando no host ANTIGO. Por isso aqui:
#   - o bloco antigo do sslip.io FICA no Caddy (rede de seguranca, nao quebra nada)
#   - o webhook e re-registrado em toda instancia conectada, apontando pro novo host
#
# Uso: ./apontar-dominio.sh <host.novo.com.br> <interno|slug-do-cliente>
#   ex: ./apontar-dominio.sh app.meudominio.com.br interno
#       ./apontar-dominio.sh veraldo.meudominio.com.br veraldo
set -e

HOST=$1; ALVO=$2
IP_VPS=2.25.138.60
[ -z "$ALVO" ] && { echo "uso: $0 <host> <interno|slug>"; exit 1; }

# ---------- 1. o DNS ja aponta pra ca? ----------
IP_DNS=$(dig +short "$HOST" A | tail -1)
if [ "$IP_DNS" != "$IP_VPS" ]; then
  echo "❌ $HOST resolve pra '${IP_DNS:-nada}', esperado $IP_VPS"
  echo "   Cria o registro A no painel do dominio e roda de novo."
  echo "   (o Let's Encrypt so emite certificado depois que o DNS estiver de pe)"
  exit 1
fi

# ---------- 2. onde mora o alvo ----------
if [ "$ALVO" = "interno" ]; then
  ENV=/root/facilita-sdr/.env; PORT=8795; TIPO=systemd
else
  for B in /root/sdr-clientes/$ALVO /root/sdr-privado/$ALVO; do [ -d "$B" ] && BASE=$B; done
  [ -z "$BASE" ] && { echo "nao achei '$ALVO' em sdr-clientes nem sdr-privado"; exit 1; }
  ENV=$BASE/.env; TIPO=docker
  PORT=$(docker port "sdr-$ALVO" 8795 | cut -d: -f2)
  [ -z "$PORT" ] && { echo "container sdr-$ALVO nao esta no ar"; exit 1; }
fi
ANTIGO=$(grep '^APP_URL=' "$ENV" | cut -d= -f2-)
echo "alvo: $ALVO ($TIPO, porta $PORT) · hoje: $ANTIGO"

# ---------- 3. Caddy (idempotente; o host antigo continua valendo) ----------
if ! grep -q "^$HOST " /etc/caddy/Caddyfile; then
  printf '\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$HOST" "$PORT" >> /etc/caddy/Caddyfile
  systemctl reload caddy
  echo "caddy: bloco criado, esperando certificado..."
  for i in $(seq 1 30); do
    sleep 4
    [ "$(curl -s -o /dev/null -m 8 -w '%{http_code}' "https://$HOST/health")" = "200" ] && break
  done
fi
CODE=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$HOST/health")
[ "$CODE" != "200" ] && { echo "❌ https://$HOST/health devolveu $CODE (certificado nao saiu). Nada foi trocado."; exit 1; }
echo "✅ https://$HOST/health = 200"

# ---------- 4. APP_URL ----------
sed -i "s#^APP_URL=.*#APP_URL=https://$HOST#" "$ENV"
if [ "$TIPO" = docker ]; then docker restart "sdr-$ALVO" >/dev/null; else systemctl restart facilita-sdr; fi
sleep 8

# ---------- 5. re-registra o webhook de cada instancia conectada ----------
# sem isso a uazapi segue entregando no host antigo: o painel abre no dominio novo
# e a IA parece "muda", porque mensagem nenhuma chega.
RE='
const Database = require("better-sqlite3");
const db = new Database(process.env.DADOS_DIR + "/sdr.db");
const insts = db.prepare("SELECT nome, uazapi_token FROM instancias WHERE status = ?").all("conectado");
const url = `${process.env.APP_URL}/webhook?secret=${process.env.WEBHOOK_SECRET}`;
(async () => {
  if (!insts.length) return console.log("nenhuma instancia conectada");
  for (const i of insts) {
    const r = await fetch(`${process.env.UAZAPI_URL}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: i.uazapi_token },
      body: JSON.stringify({ url, enabled: true, events: ["messages"],
        addUrlTypesMedia: ["audio","image","video","document","ptt"], excludeMessages: [] }),
    }).catch(e => ({ ok: false, erro: e.message }));
    console.log(`  webhook ${i.nome}: ${r.ok ? "ok" : "FALHOU " + (r.erro || r.status)}`);
  }
})();'
if [ "$TIPO" = docker ]; then
  docker exec "sdr-$ALVO" node -e "$RE"
else
  (cd /root/facilita-sdr && set -a && . ./.env && set +a && DADOS_DIR=${DADOS_DIR:-/root/facilita-sdr/db} node -e "$RE")
fi

echo "=============================================="
echo "✅ $ALVO agora atende em https://$HOST"
echo "   ($ANTIGO continua funcionando, nao removi)"
echo ""
echo "   FALTA VOCE, no Google Cloud Console (OAuth client do Facilita):"
echo "   cadastrar o redirect  https://$HOST/api/gcal/callback"
echo "   sem isso o botao 'Conectar agenda' quebra nesse dominio."
echo "=============================================="
