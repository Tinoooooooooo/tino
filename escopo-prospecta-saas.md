# Prospecta — Escopo pra virar SaaS

> Transformar o Facilita SDR (ferramenta interna) em **Prospecta**, um SaaS multi-cliente
> vendido a R$100/mês, onde cada cliente traz o próprio token da Anthropic.
> Status: ESCOPO FECHADO — aprovado pra construir 11/08/2026.

## ✅ Decisões fechadas (11/08/2026)

- **O Facilita SDR VIRA o Prospecta** — mesmo sistema, ganha camada SaaS + novo nome. NÃO é sistema novo do zero.
- **Base de código:** acelerar copiando as partes de SaaS já prontas do **Facilita AI** (clínicas): multi-tenancy, contas, login, Stripe, multi-instância, isolamento — tudo já testado em produção lá. O miolo de "clínica" é trocado pelo agente SDR de prospecção que o SDR já tem.
- **Preço:** R$100/mês base + **R$20 por WhatsApp adicional**. (⚠️ conferir custo real da instância uazapi antes de lançar — os R$20 têm que cobrir instância + margem.)
- **Trial:** 14 dias grátis.
- **Domínio:** compra depois (por ora sem domínio próprio).
- **Suporte:** Matheus + Valentino.
- **Chip/WhatsApp:** o cliente traz o dele (conecta via QR).
- **Infra — dois mundos separados:**
  - **Interno (Matheus + Valentino):** continua na VPS + `claude -p` do plano, de graça, INTACTO.
  - **SaaS (clientes pagantes):** roda IGUAL o Facilita AI — Vercel + Supabase (Postgres) + **cron na nuvem** (Vercel Cron / pg_cron) pro disparo automático. ZERO VPS pra clientes.
  - IA dos clientes: API da Anthropic com o **token do próprio cliente** (não o plano).
- **Banco:** Postgres/Supabase (não SQLite) — multi-tenant precisa, e dá backup automático.
- **Rotação de disparo:** N WhatsApps conectados = disparos distribuídos round-robin entre eles (30 disparos, 3 números = 10 cada). Protege chip + argumento de venda.
- **Regra de ouro da construção:** o Facilita SDR na VPS está DISPARANDO em produção. Construir o Prospecta SEM tocar nele. Só migrar/desligar quando o Prospecta estiver pronto e testado.
- **Diferenciais de venda (não são o mais caro de fazer):** (1) chat-entrevista que monta o cérebro sozinha conversando; (2) rotação multi-WhatsApp; (3) setup de produto guiado por campos/templates.

**Ordem de construção aprovada:** Fase 1 multi-tenancy → Fase 2 token Anthropic + Stripe → Fase 3 multi-WhatsApp+rotação + chat-entrevista + setup guiado → Fase 4 marca+domínio+admin+LGPD.

## A virada em uma frase

Hoje o Facilita SDR é **single-tenant**: um sistema, um banco, um WhatsApp, o cérebro do
Matheus/Valentino, o plano Claude do Matheus. Pra virar SaaS precisa ser **multi-tenant**:
cada cliente tem a conta dele, o cérebro dele, os WhatsApps dele, o token Anthropic dele,
a cobrança dele, isolados dos outros. Matheus + Valentino continuam num "workspace" próprio,
do mesmo jeito que está (Cloud da VPS), sem pagar nada.

Isso é a mudança mais pesada do projeto até aqui. Não é uma feature, é uma refundação da base.

---

## 1. Multi-tenancy (a fundação — sem isso nada funciona)

Hoje `leads`, `config`, `campanhas`, `mensagens` etc. não têm dono. No SaaS, TUDO ganha um
`conta_id` e toda query filtra por ele. É a mesma lição já vivida no Facilita (clínicas isoladas).

**O que muda:**
- Nova tabela `contas` (id, nome, email, senha_hash, plano, status, criado_em)
- Coluna `conta_id` em TODAS as tabelas de dados + índice
- Toda rota da API valida "essa conta só mexe no que é dela" (igual o `clinicaPermitida` do Facilita)
- O cérebro (treino_geral/pitch/objecoes/exemplo), áudio, slots, links: hoje são chave-valor
  global na tabela `config`; viram por-conta
- **Workspace Matheus+Valentino = só mais uma conta**, marcada como `interna` (não cobra, sem limite)

**Tamanho: GRANDE.** É reescrever a camada de dados inteira. Melhor fazer isso ANTES de ter
cliente pagante (migrar dados de produção depois é dor).

**Decisão de banco:** hoje é SQLite na VPS. Pra multi-tenant com dezenas de contas, cada uma
com WhatsApp e conversa, o SQLite aguenta bem por um tempo (é rápido), mas quando escalar vale
migrar pra Postgres (Supabase, que já usamos). Sugestão: **começar em SQLite** (mais rápido de
construir) e deixar a camada `lib/db.js` pronta pra trocar, como já é no Facilita.

---

## 2. Conta, login e onboarding

- **Cadastro self-service:** página de criar conta (nome, email, senha). Hoje o login é
  email+senha único do Matheus; vira sistema de contas de verdade (PBKDF2, sessão, rate-limit —
  tudo isso já existe no Facilita, dá pra portar).
- **Recuperação de senha** (email) — precisa de um provedor de email (Resend/SendGrid), custo baixo.
- **Onboarding guiado:** ao criar conta, um checklist "primeiros passos": (1) colar token Anthropic,
  (2) conectar WhatsApp, (3) fazer a entrevista do cérebro, (4) subir lista, (5) ativar campanha.

**Tamanho: MÉDIO** (a base de auth já existe no Facilita, é adaptar).

---

## 3. Token da Anthropic por cliente (o modelo de custo)

O pulo do gato do teu modelo: **R$100/mês e o cliente paga os próprios tokens.** Isso te tira
do risco de custo de IA (que no Facilita é tua dor). Cada conta cola a própria chave `sk-ant-...`.

**Como funciona tecnicamente:**
- Campo `anthropic_key` na conta (guardado criptografado, nunca volta pro browser)
- O agente (`lib/agente.js`) hoje usa `claude -p` do PLANO da VPS. No SaaS, pra cliente pagante,
  usa a **API da Anthropic com a chave DELE** (não o plano). Some o `claude -p`, entra chamada HTTP
  direta pra API com o modelo Haiku.
- **Matheus+Valentino continuam no `claude -p` do plano** (conta interna), sem token. O sistema
  escolhe: conta interna → plano da VPS; conta pagante → API com token do cliente.
- **Tutorial embutido:** página/vídeo curto ensinando "vai em console.anthropic.com → API Keys →
  cria chave → cola aqui". Igual já tem tutorial de token do Google Ads no teu ecossistema.
- **Validação:** ao colar, o sistema testa a chave (uma chamada barata) e mostra "✅ válida" ou o erro.
- **Aviso de saldo:** quando a chave falhar por falta de crédito, avisar o cliente (email/painel)
  "sua chave Anthropic está sem saldo, recarregue em console.anthropic.com".

**Tamanho: MÉDIO.** O agente já é modular; é trocar a "fonte de IA" por conta. O tutorial é conteúdo.

**Ponto de atenção honesto:** cliente leigo colando token de API vai gerar suporte ("não sei fazer",
"deu erro", "quanto vou gastar"). Vale um vídeo MUITO bem feito e um medidor de gasto estimado no painel.

---

## 4. Stripe (cobrança recorrente + planos por WhatsApp)

- **Assinatura mensal** R$100 base. Stripe Checkout + webhook (a base já foi montada no Facilita,
  dá pra reaproveitar muito: `lib/stripe.ts` de lá).
- **Planos escalonados por nº de WhatsApp:** cada instância extra encarece. Ex (números a definir):
  - 1 WhatsApp: R$100/mês
  - 2 WhatsApp: R$170/mês
  - 3 WhatsApp: R$240/mês
  - (ou R$100 base + R$70 por WhatsApp adicional)
- **Trava por pagamento:** conta inadimplente → disparos pausam, mas dados não somem (igual clínica
  trial vencido no Facilita). Reativa ao pagar.
- **Trial:** oferecer X dias grátis pra converter (o Facilita já tem essa mecânica de trial).

**Tamanho: MÉDIO.** Stripe já foi feito uma vez; o novo é amarrar plano ↔ nº de WhatsApp permitido.

---

## 5. Múltiplos WhatsApp + rotação de disparo

Hoje é 1 instância (`instancia_token` na config). No SaaS:
- Tabela `instancias` por conta (cada uma seu token uazapi, número, status) — o Facilita já tem
  isso multi-instância, dá pra portar a lógica.
- **Limite pelo plano:** conta com plano de 2 WhatsApp só conecta 2.
- **Rotação de disparo (teu pedido):** o worker distribui os disparos entre os números conectados.
  Ex: 30 disparos/dia com 3 números = ~10 por número. Faz round-robin: dispara pelo número 1,
  próximo pelo 2, próximo pelo 3, volta pro 1. Isso **protege os chips** (espalha carga) e é um
  argumento de venda forte (mais volume sem queimar número).
- **Resposta volta pro número certo:** quando o lead responde, o webhook já sabe por qual instância
  chegou (o Facilita resolve isso), então a conversa continua pelo mesmo número que abriu.
- **Custo uazapi:** cada instância na uazapi tem custo. No teu preço, o plano por WhatsApp precisa
  cobrir a instância uazapi + margem. Conferir o custo real por instância na uazapi antes de fechar preço.

**Tamanho: MÉDIO-GRANDE.** Multi-instância o Facilita já tem; a rotação de disparo é nova e precisa
de cuidado (cadência por número, teto por número, resposta no número certo).

---

## 6. Setup fácil de produto (o "cérebro" mais intuitivo)

Hoje o Cérebro são 4 caixotes de texto livre. Pra cliente não-técnico, isso é intimidante.
Melhorias:
- **Campos guiados em vez de texto solto:** "O que você vende?", "Preço", "Link do site",
  "Como você quer se apresentar?", "3 principais objeções e respostas" — formulário amigável que
  por trás monta o mesmo prompt.
- **Templates por nicho:** "sou clínica", "sou agência", "vendo curso", "sou prestador de serviço" —
  já vem com pitch/objeções pré-preenchidos pra pessoa só ajustar.
- **Preview ao vivo:** ao lado do formulário, um exemplo de como a IA vai falar, atualizando conforme
  digita.

**Tamanho: MÉDIO.** É UX + reorganizar o que já existe.

---

## 7. Aba de chat-entrevista que configura o cérebro sozinha (a joia)

Teu pedido mais interessante: **uma aba de chat onde o cliente conversa (como tu faz comigo) e a IA
vai entrevistando, entendendo o produto/tom/objeções, e escrevendo o cérebro sozinha.**

**Como funcionaria:**
- Uma conversa guiada: a IA pergunta "O que sua empresa vende?", "Pra quem?", "Qual o maior motivo
  de alguém comprar de você?", "Quais as objeções mais comuns?", "Como você gosta de falar — formal
  ou descontraído?", "Tem algum caso de sucesso pra contar?".
- A cada resposta, ela **destila e escreve nos campos do cérebro** (pitch, objeções, tom, exemplo)
  automaticamente, e mostra "✅ atualizei seu pitch com isso".
- No fim, a pessoa revisa e ajusta o que quiser. Sai da entrevista com o cérebro 80% pronto.
- Tecnicamente: é um segundo agente (prompt "você é um entrevistador que configura um SDR"), que a
  cada turno devolve {próxima_pergunta, campos_a_atualizar}. Mesmo padrão de tools que o agente SDR já usa.

**Tamanho: MÉDIO** (a mecânica de agente-com-saída-estruturada já existe; é um novo prompt + uma tela
de chat, que o painel já tem no simulador).

**Por que é forte:** derruba a barreira de "não sei configurar". A pessoa cria conta, conversa 5
minutos, e o robô dela tá pronto. Isso é diferencial de venda de verdade.

---

## 8. Marca / renomear pra Prospecta

- Trocar "Facilita SDR" → **Prospecta** em: título, login, menu, e-mails, apresentação.
- Domínio próprio (ex: prospecta.app / .com.br) em vez do sslip.io — passa credibilidade e é
  necessário pro OAuth do Google e pra cobrança.
- Logo + identidade visual.
- **Cuidado:** o Facilita AI (clínicas) é OUTRO produto. Prospecta é o de prospecção. Não misturar
  marca. (O áudio/apresentação de exemplo que hoje é do Facilita AI vira genérico ou por-cliente.)

**Tamanho: PEQUENO-MÉDIO** (find-replace + domínio + design).

---

## 9. O que mais um SaaS de verdade precisa (não pedido, mas necessário pra vender)

- **Domínio + HTTPS próprio** (sslip.io não serve pra produto pago)
- **Painel admin teu** (ver todas as contas, MRR, quem tá pagando, quem tá em trial) — o Facilita já
  tem um "Visão do Negócio" que serve de base
- **Termos de uso + política de privacidade** (LGPD; prospecção é área sensível)
- **Isolamento de segurança auditado** (uma conta NUNCA vê lead de outra — testar de verdade)
- **Onde roda:** hoje tudo na TUA VPS. Com clientes pagantes, a VPS vira responsabilidade (se cair,
  cliente reclama). Pensar em: VPS maior, ou mover pra infra gerenciada. E o `claude -p` do plano
  NÃO escala pra clientes (por isso cada um traz token) — mas a VPS ainda processa tudo.
- **Suporte:** canal pro cliente (WhatsApp/email) quando travar. Prospecção gera dúvida.
- **Backup do banco** (hoje é um arquivo SQLite; com clientes pagantes, backup automático é obrigatório)

---

## Ordem sugerida de construção (fases)

**Fase 0 — decisões antes de codar:**
- Preço final e planos por WhatsApp (com custo uazapi confirmado)
- Nome/domínio Prospecta
- SQLite ou já migra Postgres

**Fase 1 — a fundação (sem isso não há SaaS):**
- Multi-tenancy (conta_id em tudo) + isolamento
- Contas, login self-service, sessão
- Workspace interno Matheus+Valentino preservado

**Fase 2 — o modelo de negócio:**
- Token Anthropic por conta + tutorial + validação
- Stripe (assinatura + planos + trava de inadimplente + trial)

**Fase 3 — o diferencial:**
- Múltiplos WhatsApp + rotação de disparo
- Chat-entrevista que monta o cérebro
- Setup de produto guiado (campos + templates por nicho)

**Fase 4 — produto de verdade:**
- Marca Prospecta + domínio + logo
- Painel admin (MRR, contas)
- Termos/LGPD, backup, suporte, auditoria de isolamento

---

## Avaliação honesta

- **É viável?** Sim. ~70% da lógica difícil já existe (agente, WhatsApp, cérebro, campanhas, Stripe
  base, multi-instância base — tudo já foi resolvido no Facilita ou no SDR).
- **O trabalho pesado é a Fase 1** (multi-tenancy). Não tem atalho: ou faz certo agora, ou vira
  bomba quando tiver 10 clientes.
- **O maior risco não é técnico, é operacional:** token de API na mão de leigo + suporte + a VPS
  virando infra crítica de clientes pagantes. Vale pensar se R$100/mês cobre esse custo de operação.
- **O diferencial de venda** (chat-entrevista + rotação multi-WhatsApp) é forte e nem é o mais caro
  de fazer. É o que faz o Prospecta não ser "só mais um disparador".

## Perguntas pra você decidir (quando for a hora)

1. Preço por WhatsApp adicional? (preciso do custo real da instância uazapi)
2. Trial grátis de quantos dias?
3. SQLite ou Postgres desde já?
4. Domínio: qual nome? (prospecta.com.br disponível?)
5. Suporte: tu e Valentino aguentam o suporte de N clientes, ou precisa de alguém?
6. O cliente conecta 1 chip por WhatsApp — quem fornece o chip? (ele traz o dele, imagino)
