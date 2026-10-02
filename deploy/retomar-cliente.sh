#!/bin/bash
# Retoma os disparos de um cliente que estava pausado (pagou).
SLUG=$1
[ -z "$SLUG" ] && { echo "uso: $0 <slug>"; exit 1; }
docker exec "sdr-$SLUG" node -e "import('/app/lib/db.js').then(m => { m.setConfig('conta_pausada',''); m.setConfig('assinatura_status','ativa'); console.log('retomado'); })"
