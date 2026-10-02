# Prospecta

SDR de IA que prospecta no WhatsApp. É o produto que a L.M vende como SaaS, e é
o mesmo código que roda a prospecção interna da agência.

Node + Express + SQLite. Sem framework no painel: é um `index.html` só.

## Como está no ar

Tudo numa VPS (`2.24.86.237`), atrás do Caddy, que resolve o HTTPS sozinho.

| operação | onde roda | IA | endereço |
|---|---|---|---|
| interna (nós) | systemd no host, porta 8795 | `claude -p` do plano, custo zero | `prospectaai.site` |
| cliente | 1 container Docker cada, 880x | API da Anthropic, chave do cliente | `sdr-<slug>...sslip.io` |
| privada | container em `/root/sdr-privado`, 890x | `claude -p` do plano | `crm-<slug>...sslip.io` |

Cada operação tem **banco próprio** (`dados/sdr.db`). Não existe banco
compartilhado nem `cliente_id` em query nenhuma: o isolamento é o container.

## Estrutura

```
server.js        rotas da API + sessão + permissão por papel
worker.js        o laço: dispara, faz follow-up, retoma, cuida da cota do dia
lib/agente.js    monta o prompt, chama a IA, executa as ações que ela devolve
lib/ia-api.js    chamada direta à Messages API (modo cliente). Haiku padrão,
                 Sonnet só quando o lead traz objeção de verdade
lib/db.js        SQLite inteiro: schema, migrações e todas as consultas
lib/uazapi.js    gateway de WhatsApp (conectar, enviar, webhook)
lib/gcal.js      Google Agenda do closer
painel/index.html  o painel todo (CRM, kanban, conversas, campanhas, config)
prompts/         sdr.md = o nosso · sdr-generico.md = o do cliente
deploy/          scripts de provisionar, atualizar, pausar cliente
```

## Rodar na tua máquina

```bash
npm install
cp .env.example .env     # preenche o que precisa
npm start                # http://localhost:8795
```

Sem `UAZAPI_*` ele sobe em modo demo: painel funciona, WhatsApp não.

## Subir mudança pra produção

```bash
# 1. manda o código pra VPS
scp server.js painel/index.html lib/*.js vps-lm:/root/facilita-sdr/...

# 2. operação interna
ssh vps-lm "systemctl restart facilita-sdr"

# 3. clientes: rebuild da imagem + recria os containers
ssh vps-lm "cd /root/facilita-sdr && ./deploy/atualizar-clientes.sh"
```

**Nunca** `docker restart` num container de cliente: ele sobe com a imagem
velha e a mudança não entra. É sempre o `atualizar-clientes.sh`.

## Coisas que já nos morderam

- **`APP_URL` não é só cosmético.** Ele monta a URL do webhook que fica gravada
  lá na uazapi, uma por número. Trocar domínio sem re-registrar o webhook deixa
  a IA muda: o painel abre, mas mensagem nenhuma chega. Use
  `deploy/apontar-dominio.sh`, que faz as duas coisas.
- **A operação interna depende do binário `claude` existir na VPS.** Em 21/09/26
  ele sumiu numa troca de máquina e a IA ficou 9 dias disparando sem responder,
  porque o disparo é template e não passa pela IA.
- **Coluna de entrada de funil de disparo devolve o lead pra fila.** Mover um
  lote pra lá faz a IA abordar todo mundo de novo.
- **Tudo que vem do banco passa por `esc()` antes de virar HTML.** Nome de lead e
  mensagem de WhatsApp são texto de terceiro, trate como hostil.

## Antes de abrir PR

Tem cliente pagando nisso. Roda o subagente `revisor-seguranca` na mudança antes
de subir, e confere se nenhum `.env` ou `dados/` entrou no commit.
