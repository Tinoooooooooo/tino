#!/bin/bash
# Pausa os DISPAROS de um cliente (inadimplente). Painel continua acessível,
# dados preservados, IA continua respondendo quem já está em conversa.
# Uso: ./pausar-cliente.sh <slug>     |  retomar: ./retomar-cliente.sh <slug>
SLUG=$1
[ -z "$SLUG" ] && { echo "uso: $0 <slug>"; exit 1; }
docker exec "sdr-$SLUG" node -e "import('/app/lib/db.js').then(m => { m.setConfig('conta_pausada','1'); m.setConfig('assinatura_status','inadimplente'); console.log('pausado'); })"
