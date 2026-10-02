#!/bin/bash
# Planta as credenciais do Google/Supabase (que ja existem no .env do ia-clinicas)
# no .env do Facilita SDR na VPS. Rodar do Mac: bash scripts/setup-gcal-env.sh
set -e
cd "$(dirname "$0")/../../ia-clinicas"

GID=$(grep '^GOOGLE_CLIENT_ID=' .env | cut -d= -f2-)
GSEC=$(grep '^GOOGLE_CLIENT_SECRET=' .env | cut -d= -f2-)
SURL=$(grep '^SUPABASE_URL=' .env | cut -d= -f2-)
SKEY=$(grep -E '^SUPABASE_(SERVICE|SECRET)' .env | head -1 | cut -d= -f2-)

if [ -z "$GID" ] || [ -z "$SKEY" ]; then
  echo "ERRO: nao achei GOOGLE_CLIENT_ID ou chave do Supabase no .env do ia-clinicas"
  exit 1
fi

ssh vps-fernanda "grep -q '^GOOGLE_CLIENT_ID=' /root/facilita-sdr/.env 2>/dev/null || cat >> /root/facilita-sdr/.env <<EOF
GOOGLE_CLIENT_ID=$GID
GOOGLE_CLIENT_SECRET=$GSEC
FACILITA_SUPABASE_URL=$SURL
FACILITA_SUPABASE_KEY=$SKEY
GCAL_PROF_MATHEUS=bed7d97e-a12d-45ac-afb8-f89cad8c1571
EOF
systemctl restart facilita-sdr"

echo "PRONTO"
