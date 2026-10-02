#!/bin/bash
# Atualiza o produto em TODOS os containers de cliente (SaaS replicado).
# Uso (na VPS, depois do rsync do código novo): ./atualizar-clientes.sh
set -e
echo "== rebuild da imagem =="
docker build -t facilita-sdr:latest /root/facilita-sdr
echo "== recriando containers (clientes + operacoes proprias) =="
# /root/sdr-privado = operacoes do proprio dono (outro nicho/marca), fora da
# lista de clientes mas precisando das mesmas atualizacoes de codigo
for DIR in /root/sdr-clientes/*/ /root/sdr-privado/*/; do
  [ -d "$DIR" ] || continue
  SLUG=$(basename "$DIR")
  [ -f "$DIR/.env" ] || continue
  PORT=$(docker inspect "sdr-$SLUG" --format '{{(index (index .NetworkSettings.Ports "8795/tcp") 0).HostPort}}' 2>/dev/null || echo "")
  [ -z "$PORT" ] && { echo "  pulando $SLUG (container não existe)"; continue; }
  docker rm -f "sdr-$SLUG" >/dev/null
  docker run -d --name "sdr-$SLUG" --restart unless-stopped \
    -p 127.0.0.1:$PORT:8795 --env-file "$DIR/.env" \
    -v "$DIR/dados":/dados --memory=300m facilita-sdr:latest >/dev/null
  echo "  ✅ $SLUG atualizado (porta $PORT)"
done
echo "pronto."
