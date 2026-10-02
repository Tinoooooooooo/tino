-- Facilita SDR — schema SQLite
-- Banco mora em dados/sdr.db na VPS. Tudo idempotente (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_clinica TEXT NOT NULL,
  telefone TEXT NOT NULL UNIQUE,        -- E.164 sem +, ex 5531999998888
  cidade TEXT,
  nicho TEXT,
  site TEXT,
  avaliacoes INTEGER,                   -- qtd de reviews no Google (personaliza copy)
  nota REAL,                            -- nota media no Google
  origem_lista TEXT,                    -- nome do CSV/campanha de origem (LGPD: de onde veio o dado)
  status TEXT NOT NULL DEFAULT 'novo',  -- novo|disparado|respondeu|em_conversa|decisor|negociando|reuniao_marcada|compareceu|trial|fechado|perdido|descartado|optout|sem_whatsapp
  nome_contato TEXT,                    -- quem respondeu (mapeamento de conexao)
  eh_responsavel INTEGER DEFAULT 0,     -- 1 = confirmou que e o responsavel
  audio_enviado INTEGER DEFAULT 0,      -- 1 = audio oficial ja foi enviado
  dor TEXT,                             -- dor mapeada pela IA
  num_profissionais TEXT,
  sistema_agenda TEXT,                  -- Feegow/Clinicorp/papel/etc
  melhor_horario TEXT,                  -- quando o responsavel esta (mapeamento de conexao)
  closer TEXT,                          -- matheus|valentino
  motivo_perda TEXT,
  ia_pausada INTEGER DEFAULT 0,         -- 1 = humano assumiu a conversa
  criado_em TEXT DEFAULT (datetime('now')),
  atualizado_em TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campanhas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pausada',  -- ativa|pausada|encerrada
  teto_dia INTEGER DEFAULT 25,             -- max disparos/dia (chip proprio = conservador)
  cadencia_min_seg INTEGER DEFAULT 180,    -- 3 min
  cadencia_max_seg INTEGER DEFAULT 420,    -- 7 min
  janela_inicio TEXT DEFAULT '08:30',
  janela_fim TEXT DEFAULT '18:00',
  dias_semana TEXT DEFAULT '1,2,3,4,5',    -- 1=seg ... 7=dom
  criado_em TEXT DEFAULT (datetime('now'))
);

-- variacoes da mensagem de abertura (sorteadas por disparo)
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campanha_id INTEGER NOT NULL REFERENCES campanhas(id),
  tipo TEXT NOT NULL DEFAULT 'abertura',   -- abertura|followup1|followup2
  texto TEXT NOT NULL                      -- placeholders: {nome_clinica} {cidade}
);

CREATE TABLE IF NOT EXISTS campanha_leads (
  campanha_id INTEGER NOT NULL REFERENCES campanhas(id),
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  disparado_em TEXT,
  template_id INTEGER,
  followup1_em TEXT,
  followup2_em TEXT,
  PRIMARY KEY (campanha_id, lead_id)
);

-- historico completo da conversa (role: user = lead, assistant = IA/closer, sistema = eventos)
CREATE TABLE IF NOT EXISTS mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  role TEXT NOT NULL,                      -- user|assistant|sistema
  texto TEXT,
  tipo TEXT DEFAULT 'texto',               -- texto|audio|imagem|outro
  criado_em TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mensagens_lead ON mensagens(lead_id, criado_em);

CREATE TABLE IF NOT EXISTS reunioes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  closer TEXT NOT NULL,                    -- matheus|valentino
  inicio TEXT NOT NULL,                    -- ISO local SP: 2026-08-12T15:00
  meet_url TEXT,
  status TEXT NOT NULL DEFAULT 'marcada',  -- marcada|remarcada|realizada|no_show|cancelada
  lembrete_d1 INTEGER DEFAULT 0,
  lembrete_1h INTEGER DEFAULT 0,
  criado_em TEXT DEFAULT (datetime('now'))
);
-- anti-overbooking: um closer nao tem 2 reunioes ativas no mesmo horario
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reuniao_slot
  ON reunioes(closer, inicio) WHERE status IN ('marcada','remarcada');

-- quem pediu pra parar NUNCA mais recebe nada. Sagrada.
CREATE TABLE IF NOT EXISTS blocklist (
  telefone TEXT PRIMARY KEY,
  motivo TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);

-- config chave-valor: instancia_token, instancia_status, audio_oficial,
-- slots_matheus, slots_valentino, meet_matheus, meet_valentino,
-- proximo_disparo_em, transparencia etc.
CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

-- log de atividades (auditoria + metricas do funil)
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  tipo TEXT NOT NULL,   -- disparo|resposta|responsavel|audio|reuniao|handoff|descarte|optout|followup|lembrete|erro
  detalhe TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eventos_tipo ON eventos(tipo, criado_em);

-- dedup de webhook (uazapi reenvia se nao receber 200 a tempo)
CREATE TABLE IF NOT EXISTS webhook_eventos (
  message_id TEXT PRIMARY KEY,
  criado_em TEXT DEFAULT (datetime('now'))
);
