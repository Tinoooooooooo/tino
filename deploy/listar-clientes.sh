#!/bin/bash
# Visao rapida de todos os clientes no terminal (o painel Admin mostra o mesmo, bonito).
printf "%-14s %-10s %-8s %-9s %-9s %-8s\n" CLIENTE STATUS LEADS DISPAROS RESPOSTAS REUNIOES
for DIR in /root/sdr-clientes/*/; do
  SLUG=$(basename "$DIR")
  UP=$(docker inspect "sdr-$SLUG" --format '{{.State.Status}}' 2>/dev/null || echo "sem-ctr")
  M=$(docker exec "sdr-$SLUG" node -e "import('/app/lib/db.js').then(m => {
    const c = (t) => m.db.prepare(\"SELECT COUNT(*) c FROM eventos WHERE tipo = ?\").get(t).c;
    const l = m.db.prepare(\"SELECT COUNT(*) c FROM leads WHERE eh_teste = 0\").get().c;
    const p = m.getConfig('conta_pausada','') === '1' ? 'PAUSADO' : 'ok';
    console.log([l, c('disparo'), c('resposta'), c('reuniao'), p].join(' '));
  })" 2>/dev/null || echo "- - - - erro")
  read L D R RE P <<< "$M"
  printf "%-14s %-10s %-8s %-9s %-9s %-8s %s\n" "$SLUG" "$UP" "$L" "$D" "$R" "$RE" "$P"
done
