// Facilita SDR — camada de dados (SQLite via better-sqlite3).
// Banco em DADOS_DIR/sdr.db (default ./dados). Schema aplicado no boot (idempotente).
import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DADOS_DIR = process.env.DADOS_DIR || join(__dirname, "..", "dados");
mkdirSync(DADOS_DIR, { recursive: true });

export const db = new Database(join(DADOS_DIR, "sdr.db"));
db.pragma("journal_mode = WAL");
db.exec(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
try { db.exec("ALTER TABLE reunioes ADD COLUMN gcal_event_id TEXT"); } catch { /* ja existe */ }
try { db.exec("ALTER TABLE leads ADD COLUMN followup_em TEXT"); } catch { /* ja existe */ }
try { db.exec("ALTER TABLE leads ADD COLUMN followup_msg TEXT"); } catch { /* ja existe */ }
try { db.exec("ALTER TABLE leads ADD COLUMN eh_teste INTEGER DEFAULT 0"); } catch { /* ja existe */ }
try { db.exec("ALTER TABLE leads ADD COLUMN telefone_decisor TEXT"); } catch { /* ja existe */ }
try { db.exec("ALTER TABLE leads ADD COLUMN reengajado_em TEXT"); } catch { /* ja existe */ }
// % do teto diario reservado pra reengajamento (resto = contatos novos; sobra vira novos)
try { db.exec("ALTER TABLE campanhas ADD COLUMN pct_reengajar INTEGER DEFAULT 30"); } catch { /* ja existe */ }
// follow-ups POR ETAPA, decididos na campanha: {"respondeu":2,"em_conversa":2,"decisor":3,"negociando":3}
try { db.exec("ALTER TABLE campanhas ADD COLUMN followups_json TEXT"); } catch { /* ja existe */ }
// a que etapa o contador follows_feitos do lead se refere (muda de etapa = zera)
try { db.exec("ALTER TABLE leads ADD COLUMN follows_etapa TEXT"); } catch { /* ja existe */ }
// retomada pedida sob demanda (a IA volta a falar com contexto proprio)
for (const sql of ["ALTER TABLE leads ADD COLUMN retomar_em TEXT",
                   "ALTER TABLE leads ADD COLUMN retomar_motivo TEXT",
                   "ALTER TABLE leads ADD COLUMN retomar_thread INTEGER"])
  try { db.exec(sql); } catch { /* ja existe */ }
// resumo da conversa (IA, cacheado): so regenera se a conversa andou depois do cache
try { db.exec("ALTER TABLE leads ADD COLUMN resumo TEXT"); } catch { /* ja existe */ }
try { db.exec("ALTER TABLE leads ADD COLUMN resumo_em TEXT"); } catch { /* ja existe */ }
// quantas vezes a IA ja pediu pra falar com humano (2 sem sucesso = perde: só há bot do outro lado)
try { db.exec("ALTER TABLE leads ADD COLUMN pedidos_humano INTEGER DEFAULT 0"); } catch { /* ja existe */ }

// MULTI-WHATSAPP (rotacao): cada numero e uma linha; disparos_hoje alimenta o round-robin
db.exec(`CREATE TABLE IF NOT EXISTS instancias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT,
  uazapi_token TEXT,
  numero TEXT,
  status TEXT DEFAULT 'desconectado',
  disparos_hoje INTEGER DEFAULT 0,
  cota_dia INTEGER DEFAULT 0,        -- split manual: max disparos/dia deste numero (0 = sem limite proprio)
  criado_em TEXT DEFAULT (datetime('now'))
)`);
try { db.exec("ALTER TABLE instancias ADD COLUMN cota_dia INTEGER DEFAULT 0"); } catch { /* ja existe */ }

// NOTAS manuais por lead (follow-up de ligacao, observacoes do vendedor)
db.exec(`CREATE TABLE IF NOT EXISTS notas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  texto TEXT NOT NULL,
  criado_em TEXT DEFAULT (datetime('now'))
)`);

// TAREFAS manuais por lead (o que EU tenho que fazer, fora da IA: ligar pro
// decisor, mandar proposta). Nada disso e disparado automaticamente — e um
// lembrete que aparece no card do pipeline e no topo da conversa.
db.exec(`CREATE TABLE IF NOT EXISTS tarefas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  texto TEXT NOT NULL,
  quando TEXT,
  feita INTEGER DEFAULT 0,
  criado_em TEXT DEFAULT (datetime('now'))
)`);
// ============================================================
// CRM v2 — usuarios, pipelines, telefones, threads
// Tudo idempotente: roda no boot, nunca apaga dado existente.
// ============================================================

// USUARIOS: quem opera o CRM. papel define o que pode fazer.
//   admin     = dono da conta (eu e o Valentino): tudo, inclusive criar usuario
//   gestor    = ve tudo da conta, edita pipeline/campanha, nao mexe em cobranca
//   operador  = trabalha os leads (SDR): ve e move card, fala com lead, cria tarefa
//   leitor    = so ve (relatorio/auditoria)
db.exec(`CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL DEFAULT 'operador',
  ativo INTEGER DEFAULT 1,
  ultimo_acesso TEXT,
  gcal_email TEXT,                   -- agenda conectada deste usuario (aba Reunioes)
  criado_em TEXT DEFAULT (datetime('now'))
)`);

// PIPELINES: funis configuraveis. tipo = 'disparo' (WhatsApp automatico) ou
// 'ligacao' (prospeccao manual por telefone). instancia_id amarra a pipeline de
// disparo a UM WhatsApp — 3 funcionarios com 3 chips = 3 pipelines.
db.exec(`CREATE TABLE IF NOT EXISTS pipelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'disparo',
  instancia_id INTEGER,              -- WhatsApp vinculado (so pipeline de disparo)
  usuario_id INTEGER,                -- dono/responsavel padrao dos leads dela
  cor TEXT DEFAULT '#0b8a5b',
  ordem INTEGER DEFAULT 0,
  arquivada INTEGER DEFAULT 0,
  criado_em TEXT DEFAULT (datetime('now'))
)`);

// ETAPAS: as colunas do Kanban de cada pipeline.
//   chave = identificador estavel usado pelo motor (novo/disparado/...);
//   e_entrada = coluna onde cai lead novo (a "Novos" do disparo alimenta a fila)
//   e_ganho / e_perdido = fecham o card (entram na somatoria de vendido)
db.exec(`CREATE TABLE IF NOT EXISTS etapas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL,
  nome TEXT NOT NULL,
  chave TEXT,
  ordem INTEGER DEFAULT 0,
  cor TEXT,
  e_entrada INTEGER DEFAULT 0,
  e_ganho INTEGER DEFAULT 0,
  e_perdido INTEGER DEFAULT 0
)`);

// TELEFONES do lead: a empresa pode ter varios numeros + o do decisor.
// tipo = empresa | decisor | outro. principal = o que a IA usa por padrao.
db.exec(`CREATE TABLE IF NOT EXISTS telefones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  numero TEXT NOT NULL,
  rotulo TEXT,
  tipo TEXT DEFAULT 'empresa',
  principal INTEGER DEFAULT 0,
  tem_whatsapp INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
)`);

// THREADS: conversas paralelas DENTRO do mesmo lead (empresa x decisor).
// O card do Kanban continua UM so — a thread nao cria lead novo.
db.exec(`CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  telefone TEXT NOT NULL,
  rotulo TEXT,
  instancia_id INTEGER,              -- de qual WhatsApp essa conversa sai
  ia_pausada INTEGER DEFAULT 0,
  nao_lida INTEGER DEFAULT 0,
  criado_em TEXT DEFAULT (datetime('now'))
)`);

// colunas novas em LEADS pro CRM (pipeline, dono, valor, tag de importacao)
for (const sql of [
  "ALTER TABLE leads ADD COLUMN pipeline_id INTEGER",
  "ALTER TABLE leads ADD COLUMN etapa_id INTEGER",
  "ALTER TABLE leads ADD COLUMN usuario_id INTEGER",
  "ALTER TABLE leads ADD COLUMN valor_venda REAL DEFAULT 0",
  "ALTER TABLE leads ADD COLUMN tag_importacao TEXT",
  "ALTER TABLE leads ADD COLUMN google_negocio TEXT",
  "ALTER TABLE leads ADD COLUMN nome_atendente TEXT",
  "ALTER TABLE leads ADD COLUMN nome_decisor TEXT",
  "ALTER TABLE leads ADD COLUMN aguardando_humano INTEGER DEFAULT 0",
  // tarefas viram ricas: responsavel, hora, tipo (followup|reuniao|ligacao)
  "ALTER TABLE tarefas ADD COLUMN usuario_id INTEGER",
  "ALTER TABLE tarefas ADD COLUMN hora TEXT",
  "ALTER TABLE tarefas ADD COLUMN tipo TEXT DEFAULT 'followup'",
  "ALTER TABLE tarefas ADD COLUMN gcal_event_id TEXT",
  "ALTER TABLE notas ADD COLUMN usuario_id INTEGER",
  "ALTER TABLE mensagens ADD COLUMN thread_id INTEGER",
  "ALTER TABLE campanhas ADD COLUMN pipeline_id INTEGER",
  "ALTER TABLE campanhas ADD COLUMN tipo TEXT DEFAULT 'disparo'",
  "ALTER TABLE leads ADD COLUMN instancia_id INTEGER",
  "ALTER TABLE instancias ADD COLUMN pipeline_id INTEGER",
  "ALTER TABLE instancias ADD COLUMN usuario_id INTEGER",
  "ALTER TABLE notas ADD COLUMN anexo TEXT",
  "ALTER TABLE leads ADD COLUMN follows_feitos INTEGER DEFAULT 0",
  "ALTER TABLE leads ADD COLUMN ultimo_follow_em TEXT",
  "ALTER TABLE threads ADD COLUMN follows_feitos INTEGER DEFAULT 0",
  "ALTER TABLE threads ADD COLUMN ultimo_follow_em TEXT",
  // mapa clique-da-ligacao -> etapa (JSON {"nao_atendeu": etapaId, ...}); configuravel por pipeline
  "ALTER TABLE pipelines ADD COLUMN mapa_ligacao TEXT",
  // preferencias de tela por usuario (layout do lead, cartao do kanban...) em JSON
  "ALTER TABLE usuarios ADD COLUMN prefs TEXT",
  // foto do Google Meu Negocio: NULL = nao buscada, 'ok' = salva em disco, 'sem' = nao achou
  "ALTER TABLE leads ADD COLUMN foto_status TEXT",
  // arquivo de midia salvo junto da mensagem (audio que o painel mandou)
  "ALTER TABLE mensagens ADD COLUMN midia TEXT",
]) { try { db.exec(sql); } catch { /* ja existe */ } }

// AJUSTE MANUAL DE METRICA: o dashboard deixa somar/subtrair um numero num dia
// (ligacao feita fora do sistema, disparo que nao contou). Fica separado dos
// eventos pra nunca misturar o que aconteceu com o que foi corrigido na mao.
// usuario_id NULL = ajuste da equipe toda; preenchido = ajuste no numero da pessoa.
db.exec(`CREATE TABLE IF NOT EXISTS ajustes_metrica (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dia TEXT NOT NULL,
  metrica TEXT NOT NULL,
  usuario_id INTEGER,
  delta INTEGER NOT NULL,
  autor_id INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_ajustes_dia ON ajustes_metrica(metrica, dia)");

// MOVIMENTACOES do kanban: de qual etapa pra qual, quem moveu e quando.
// Alimenta o "Movimentações do dia" do CRM.
db.exec(`CREATE TABLE IF NOT EXISTS movimentacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  de_etapa_id INTEGER,
  para_etapa_id INTEGER,
  usuario_id INTEGER,
  usuario_nome TEXT,
  origem TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_mov_data ON movimentacoes(criado_em)");
export function registrarMovimento(leadId, deEtapaId, paraEtapaId, usuario, origem = "kanban") {
  if (!leadId || deEtapaId === paraEtapaId) return;
  db.prepare(`INSERT INTO movimentacoes (lead_id, de_etapa_id, para_etapa_id, usuario_id, usuario_nome, origem)
    VALUES (?,?,?,?,?,?)`).run(leadId, deEtapaId || null, paraEtapaId || null, usuario?.id || null, usuario?.nome || null, origem);
}

// AUDIOS PRONTOS: gravacoes que a pessoa manda num clique pela conversa
// ("Audio 1 · apresentacao", "Audio 2 · objecao de preco"...). Cada um tem nome
// e uma descricao de quando usar. usuario_id NULL = da empresa (todo mundo ve).
db.exec(`CREATE TABLE IF NOT EXISTS audios_prontos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT,
  arquivo TEXT NOT NULL,
  mime TEXT,
  duracao INTEGER,
  usuario_id INTEGER,
  criado_em TEXT DEFAULT (datetime('now'))
)`);

// migracao: instalacao antiga com WhatsApp unico na config vira a instancia "Principal"
try {
  const temInst = db.prepare("SELECT COUNT(*) c FROM instancias").get().c;
  const tokenAntigo = db.prepare("SELECT valor FROM config WHERE chave = 'instancia_token'").get()?.valor;
  if (!temInst && tokenAntigo) {
    const stAntigo = db.prepare("SELECT valor FROM config WHERE chave = 'instancia_status'").get()?.valor;
    db.prepare("INSERT INTO instancias (nome, uazapi_token, status) VALUES ('Principal', ?, ?)")
      .run(tokenAntigo, stAntigo === "conectado" ? "conectado" : "desconectado");
  }
} catch { /* nunca trava o boot */ }

// ============================================================
// SEED + MIGRACAO v2 (idempotente, roda uma vez)
// Cria a pipeline "Disparo" com as etapas de hoje, joga TODOS os leads
// existentes nela mantendo a etapa atual, e explode telefone/decisor em
// linhas na tabela telefones. Nada e apagado.
// ============================================================

// as etapas historicas do sistema, na ordem do funil
export const ETAPAS_DISPARO = [
  { chave: "novo", nome: "Novos", entrada: 1 },
  { chave: "disparado", nome: "Disparado" },
  { chave: "respondeu", nome: "Respondeu" },
  { chave: "em_conversa", nome: "Em conversa" },
  { chave: "decisor", nome: "Contato c/ decisor" },
  { chave: "negociando", nome: "Negociando" },
  { chave: "reuniao", nome: "Reunião marcada" },
  { chave: "ganho", nome: "Ganhou", ganho: 1 },
  { chave: "perdido", nome: "Perdido", perdido: 1 },
  { chave: "sem_whatsapp", nome: "Sem WhatsApp", perdido: 1 }, // numero sem zap (nao e recusa)
];
// pipeline de LIGACAO segue o mapeamento de conexao (atendente -> decisor -> reuniao)
export const ETAPAS_LIGACAO = [
  { chave: "novo", nome: "Novos", entrada: 1 },
  { chave: "tentativa", nome: "Tentando contato" },
  { chave: "conectou", nome: "Conectou" },
  { chave: "decisor", nome: "Falou c/ decisor" },
  { chave: "reuniao", nome: "Reunião marcada" },
  { chave: "ganho", nome: "Ganhou", ganho: 1 },
  { chave: "perdido", nome: "Perdido", perdido: 1 },
];

// pipeline de CLOSER: comeca onde o SDR termina (reuniao ja marcada pela IA)
export const ETAPAS_CLOSER = [
  { chave: "reuniao", nome: "Reunião marcada", entrada: 1 },
  { chave: "confirmada", nome: "Confirmada" },
  { chave: "compareceu", nome: "Compareceu" },
  { chave: "proposta", nome: "Proposta enviada" },
  { chave: "negociando", nome: "Negociação" },
  { chave: "ganho", nome: "Fechou", ganho: 1 },
  { chave: "no_show", nome: "No-show", perdido: 1 },
  { chave: "perdido", nome: "Perdido", perdido: 1 },
];

export function criarPipeline({ nome, tipo = "disparo", instancia_id = null, usuario_id = null, etapas = null }) {
  const ordem = db.prepare("SELECT COALESCE(MAX(ordem), 0) + 1 o FROM pipelines").get().o;
  const id = db.prepare("INSERT INTO pipelines (nome, tipo, instancia_id, usuario_id, ordem) VALUES (?,?,?,?,?)")
    .run(nome, tipo, instancia_id, usuario_id, ordem).lastInsertRowid;
  const base = etapas || (tipo === "closer" ? ETAPAS_CLOSER : tipo === "ligacao" ? ETAPAS_LIGACAO : ETAPAS_DISPARO);
  const ins = db.prepare("INSERT INTO etapas (pipeline_id, nome, chave, ordem, e_entrada, e_ganho, e_perdido) VALUES (?,?,?,?,?,?,?)");
  base.forEach((e, i) => ins.run(id, e.nome, e.chave || null, i, e.entrada || 0, e.ganho || 0, e.perdido || 0));
  return id;
}

// MIGRACAO: lead com conversa em andamento fica COLADO no chip original (o
// primeiro da casa) — sem isso, com 2+ chips a conversa trocava de numero.
try {
  db.exec(`UPDATE leads SET instancia_id = (SELECT MIN(id) FROM instancias)
    WHERE instancia_id IS NULL AND EXISTS (SELECT 1 FROM mensagens WHERE mensagens.lead_id = leads.id)`);
} catch { /* nunca trava o boot */ }

// PERMISSOES por papel (padrao de mercado). O servidor checa `pode(user, acao)`.
export const PERMISSOES = {
  admin:    ["ver", "editar_lead", "mover_card", "conversar", "criar_tarefa", "importar", "editar_pipeline", "editar_campanha", "conectar_whatsapp", "ver_dashboard", "gerir_usuarios", "cobranca", "excluir"],
  gestor:   ["ver", "editar_lead", "mover_card", "conversar", "criar_tarefa", "importar", "editar_pipeline", "editar_campanha", "conectar_whatsapp", "ver_dashboard", "excluir"],
  operador: ["ver", "editar_lead", "mover_card", "conversar", "criar_tarefa", "importar", "ver_dashboard"],
  // SDR: trabalha a prospeccao (funis de disparo/ligacao). CLOSER: so recebe quem
  // ja tem reuniao marcada (funil de closer). Os dois so ENXERGAM o funil deles.
  sdr:      ["ver", "editar_lead", "mover_card", "conversar", "criar_tarefa", "importar", "ver_dashboard"],
  closer:   ["ver", "editar_lead", "mover_card", "conversar", "criar_tarefa", "ver_dashboard"],
  leitor:   ["ver", "ver_dashboard"],
};
// que TIPO de funil cada papel enxerga (admin/gestor veem tudo)
export const TIPOS_VISIVEIS = { sdr: ["disparo", "ligacao"], closer: ["closer"] };
export const funilVisivel = (usuario, tipo) => {
  const t = TIPOS_VISIVEIS[usuario?.papel];
  return !t || t.includes(tipo);
};
export const pode = (usuario, acao) =>
  !!usuario && (PERMISSOES[usuario.papel] || []).includes(acao);

// LIMPEZA: threads orfas (lead apagado sem cascata). Roda a cada boot, e barato.
try {
  const r = db.prepare("DELETE FROM threads WHERE lead_id NOT IN (SELECT id FROM leads)").run();
  if (r.changes) console.log(`[db] ${r.changes} thread(s) orfa(s) removida(s)`);
} catch (e) { console.error("[db] limpeza de threads orfas falhou:", e.message); }

// seed do usuario admin: reaproveita o login que ja existe hoje (config
// painel_email/painel_senha_hash) pra ninguem perder acesso na atualizacao.
try {
  const temUsuario = db.prepare("SELECT COUNT(*) c FROM usuarios").get().c;
  if (!temUsuario) {
    const email = db.prepare("SELECT valor FROM config WHERE chave = 'painel_email'").get()?.valor
      || String(process.env.PAINEL_EMAIL || "").trim().toLowerCase();
    // container de cliente grava PAINEL_SENHA_LOGIN_HASH (novo-cliente.sh); sem esse
    // alias o seed nunca rodava e o cliente ficava sem usuario (id 0, audio/whats sem dono)
    const hash = db.prepare("SELECT valor FROM config WHERE chave = 'painel_senha_hash'").get()?.valor
      || process.env.PAINEL_SENHA_HASH || process.env.PAINEL_SENHA_LOGIN_HASH || "";
    if (email && hash) {
      const nome = String(process.env.CLIENTE_NOME || "").trim() || "Administrador";
      db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES (?,?,?,'admin')")
        .run(nome, email, hash);
      console.log(`[db] usuario admin criado a partir do login atual (${email})`);
    }
  }
} catch (e) { console.error("[db] seed de usuario falhou:", e.message); }

try {
  const jaTem = db.prepare("SELECT COUNT(*) c FROM pipelines").get().c;
  if (!jaTem) {
    // 1) pipeline padrao de disparo, herdando o WhatsApp ja conectado
    const inst = db.prepare("SELECT id FROM instancias ORDER BY id LIMIT 1").get();
    const pid = criarPipeline({ nome: "Disparo", tipo: "disparo", instancia_id: inst?.id || null });
    if (inst) db.prepare("UPDATE instancias SET pipeline_id = ? WHERE id = ?").run(pid, inst.id);
    db.prepare("UPDATE campanhas SET pipeline_id = ?, tipo = 'disparo' WHERE pipeline_id IS NULL").run(pid);

    // 2) todo lead existente entra nessa pipeline, na etapa equivalente ao status
    const etapas = db.prepare("SELECT id, chave FROM etapas WHERE pipeline_id = ?").all(pid);
    const porChave = Object.fromEntries(etapas.map((e) => [e.chave, e.id]));
    // status que nao viraram coluna caem em Perdido (optout/descartado/sem_whatsapp)
    const mapa = { optout: "perdido", descartado: "perdido", sem_whatsapp: "perdido" };
    for (const l of db.prepare("SELECT id, status FROM leads").all()) {
      const chave = porChave[l.status] ? l.status : (mapa[l.status] || "novo");
      db.prepare("UPDATE leads SET pipeline_id = ?, etapa_id = ? WHERE id = ?").run(pid, porChave[chave], l.id);
    }

    // 3) telefone do lead + telefone do decisor viram linhas em `telefones`.
    //    O do decisor vem como o lead digitou (as vezes sem DDI/DDD) — completa
    //    usando o telefone da empresa como referencia, senao nao disca nem abre wa.me.
    const insTel = db.prepare("INSERT INTO telefones (lead_id, numero, tipo, principal, rotulo) VALUES (?,?,?,?,?)");
    for (const l of db.prepare("SELECT id, telefone, telefone_decisor, nome_contato FROM leads").all()) {
      if (l.telefone) insTel.run(l.id, l.telefone, "empresa", 1, "Empresa");
      if (l.telefone_decisor) {
        const dec = normalizarTelefone(l.telefone_decisor, l.telefone);
        insTel.run(l.id, dec, "decisor", 0, l.nome_contato || "Decisor");
        if (dec !== l.telefone_decisor)
          db.prepare("UPDATE leads SET telefone_decisor = ? WHERE id = ?").run(dec, l.id);
      }
    }

    // 4) cada lead ganha a thread da conversa que JA existe (a do numero principal),
    //    e as mensagens antigas passam a apontar pra ela
    const insThread = db.prepare("INSERT INTO threads (lead_id, telefone, rotulo, instancia_id) VALUES (?,?,?,?)");
    const ligaMsgs = db.prepare("UPDATE mensagens SET thread_id = ? WHERE lead_id = ? AND thread_id IS NULL");
    for (const l of db.prepare("SELECT id, telefone FROM leads WHERE telefone IS NOT NULL").all()) {
      const tid = insThread.run(l.id, l.telefone, "Empresa", inst?.id || null).lastInsertRowid;
      ligaMsgs.run(tid, l.id);
    }
    console.log(`[db] migracao v2: pipeline "Disparo" criada, leads/telefones/threads migrados`);
  }
} catch (e) { console.error("[db] migracao v2 falhou (segue sem quebrar):", e.message); }

// ---------- helpers ----------
const now = () => new Date().toISOString();

// hora "de parede" em Sao Paulo (a VPS roda em UTC)
export function agoraSP() {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const diaSemana = { mån: 1, tis: 2, ons: 3, tors: 4, fre: 5, lör: 6, sön: 7 }[parts.weekday] ??
    ((new Date().getUTCDay() + 6) % 7) + 1; // fallback
  return {
    data: `${parts.year}-${parts.month}-${parts.day}`,
    hora: `${parts.hour}:${parts.minute}`,
    diaSemana, // 1=seg ... 7=dom
    iso: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
  };
}

// ---------- config ----------
export const getConfig = (chave, def = null) =>
  db.prepare("SELECT valor FROM config WHERE chave = ?").get(chave)?.valor ?? def;
export const setConfig = (chave, valor) =>
  db.prepare("INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(chave, String(valor ?? ""));

// ---------- leads ----------
export function upsertLead(l) {
  const tel = String(l.telefone || "").replace(/\D/g, "");
  if (!tel) return null;
  for (const v of variantesTelefone(tel)) {
    const existe = db.prepare("SELECT id FROM leads WHERE telefone = ?").get(v);
    if (existe) return existe.id; // dedup por telefone (com/sem nono digito): nunca dispara 2x
  }
  const r = db.prepare(`INSERT INTO leads (nome_clinica, telefone, cidade, nicho, site, avaliacoes, nota, origem_lista)
    VALUES (@nome_clinica, @telefone, @cidade, @nicho, @site, @avaliacoes, @nota, @origem_lista)`).run({
    nome_clinica: l.nome_clinica || "Clínica",
    telefone: tel,
    cidade: l.cidade || null,
    nicho: l.nicho || null,
    site: l.site || null,
    avaliacoes: l.avaliacoes != null ? Number(l.avaliacoes) : null,
    nota: l.nota != null ? Number(l.nota) : null,
    origem_lista: l.origem_lista || null,
  });
  return r.lastInsertRowid;
}

export const getLead = (id) => db.prepare("SELECT * FROM leads WHERE id = ?").get(id);

// Nono digito BR: o WhatsApp entrega "5547992056022" como "554792056022" (sem o 9).
// Toda busca por telefone casa as DUAS formas, senao resposta de lead some no vacuo.
export function variantesTelefone(tel) {
  const t = String(tel).replace(/\D/g, "");
  const v = new Set([t]);
  if (/^55\d{10}$/.test(t)) v.add(t.slice(0, 4) + "9" + t.slice(4)); // sem 9 -> com 9
  if (/^55\d{2}9\d{8}$/.test(t)) v.add(t.slice(0, 4) + t.slice(5)); // com 9 -> sem 9
  return [...v];
}
export function getLeadPorTelefone(tel) {
  for (const v of variantesTelefone(tel)) {
    const r = db.prepare("SELECT * FROM leads WHERE telefone = ?").get(v);
    if (r) return r;
  }
  return null;
}

export function atualizarLead(id, campos) {
  // so grava o que veio !== undefined (licao do Facilita: save parcial nunca apaga)
  const permitidos = ["status", "nome_contato", "eh_responsavel", "audio_enviado", "dor",
    "num_profissionais", "sistema_agenda", "melhor_horario", "closer", "motivo_perda",
    "ia_pausada", "nome_clinica", "cidade", "nicho", "eh_teste", "telefone_decisor",
    "pedidos_humano", "reengajado_em",
    // CRM v2
    "valor_venda", "tag_importacao", "google_negocio", "nome_atendente", "nome_decisor",
    "usuario_id", "site", "aguardando_humano"];
  const sets = [], vals = [];
  for (const k of permitidos) {
    if (campos[k] !== undefined) { sets.push(`${k} = ?`); vals.push(campos[k]); }
  }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE leads SET ${sets.join(", ")}, atualizado_em = datetime('now') WHERE id = ?`).run(...vals);
  // o card acompanha o status: perdido vai pra Perdido, sem_whatsapp pra Sem WhatsApp...
  if (campos.status !== undefined) sincronizarEtapa(id, campos.status);
}

// ---------- mensagens ----------
export const salvarMensagem = (leadId, role, texto, tipo = "texto", midia = null) =>
  db.prepare("INSERT INTO mensagens (lead_id, role, texto, tipo, midia) VALUES (?, ?, ?, ?, ?)").run(leadId, role, texto, tipo, midia);
export const historicoLead = (leadId, limite = 40) =>
  db.prepare("SELECT id, role, texto, tipo, thread_id, midia, criado_em FROM mensagens WHERE lead_id = ? ORDER BY id DESC LIMIT ?")
    .all(leadId, limite).reverse();
export const ultimaMensagemUsuario = (leadId) =>
  db.prepare("SELECT id FROM mensagens WHERE lead_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(leadId)?.id;

// ---------- blocklist ----------
export const naBlocklist = (tel) =>
  variantesTelefone(tel).some((v) => db.prepare("SELECT 1 FROM blocklist WHERE telefone = ?").get(v));
export function bloquear(tel, motivo) {
  db.prepare("INSERT OR IGNORE INTO blocklist (telefone, motivo) VALUES (?, ?)")
    .run(String(tel).replace(/\D/g, ""), motivo || "pediu pra parar");
}

// ---------- follow-up agendado pela IA (intermediario, "me chama amanha") ----------
export const agendarFollowupLead = (leadId, horas, msg) =>
  db.prepare("UPDATE leads SET followup_em = datetime('now', '+' || ? || ' hours'), followup_msg = ? WHERE id = ?")
    .run(Math.min(Math.max(Number(horas) || 5, 1), 96), msg || null, leadId);
export const followupsVencidos = () =>
  db.prepare(`SELECT * FROM leads WHERE followup_em IS NOT NULL AND followup_em <= datetime('now')
    AND ia_pausada = 0 AND status NOT IN ('optout','descartado','perdido','fechado') LIMIT 3`).all();
// IA pausada e esquecida: humano assumiu e nunca devolveu. Sem isso o lead
// congela (nao recebe resposta nem follow-up). Analise 04/09/26: 19 leads
// parados ha mais de 7 dias, alguns com o decisor esperando.
// RETOMADA SOB DEMANDA: alguem (ou uma analise) pede que a IA volte a falar com
// este lead, com um contexto especifico. Entra na fila do worker e sai no ritmo
// da cota do dia, como qualquer outra abordagem.
export const pedirRetomada = (leadId, motivo, canal = "empresa", threadId = null) =>
  db.prepare(`UPDATE leads SET retomar_em = datetime('now'), retomar_motivo = ?, retomar_thread = ? WHERE id = ?`)
    .run(String(motivo || "").slice(0, 600), canal === "decisor" ? threadId : null, leadId);
export const retomadasPendentes = () =>
  db.prepare(`SELECT * FROM leads WHERE retomar_em IS NOT NULL AND retomar_em <= datetime('now')
    AND ia_pausada = 0 AND status NOT IN ('optout','descartado','perdido','fechado','sem_whatsapp')
    ORDER BY retomar_em LIMIT 10`).all();
export const limparRetomada = (leadId) =>
  db.prepare("UPDATE leads SET retomar_em = NULL, retomar_motivo = NULL, retomar_thread = NULL WHERE id = ?").run(leadId);

export const pausadosEsquecidos = (dias = 3) =>
  db.prepare(`SELECT l.*,
      (SELECT criado_em FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) ultima_msg,
      (SELECT role FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) ultima_role
    FROM leads l
    WHERE l.eh_teste = 0 AND l.ia_pausada = 1
      AND l.status NOT IN ('optout','descartado','perdido','fechado','sem_whatsapp','novo')
      AND (SELECT criado_em FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) <= datetime('now', '-' || ? || ' days')
    ORDER BY (SELECT criado_em FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1)`).all(dias);

export const limparFollowup = (leadId) =>
  db.prepare("UPDATE leads SET followup_em = NULL, followup_msg = NULL WHERE id = ?").run(leadId);

// ---------- notas manuais do lead ----------
export const notasDoLead = (leadId) =>
  db.prepare("SELECT * FROM notas WHERE lead_id = ? ORDER BY id DESC").all(leadId);
export const addNota = (leadId, texto) =>
  db.prepare("INSERT INTO notas (lead_id, texto) VALUES (?, ?)").run(leadId, texto).lastInsertRowid;
export const removerNota = (id) => db.prepare("DELETE FROM notas WHERE id = ?").run(id);

// ÁUDIO DA PESSOA CERTA: quem "fala" com esse lead é o dono dele (ou o dono da
// pipeline). Sem áudio próprio, cai no áudio geral da empresa.
export function donoDoLead(lead) {
  if (!lead) return null;
  if (lead.usuario_id) return lead.usuario_id;
  if (lead.pipeline_id) return getPipeline(lead.pipeline_id)?.usuario_id || null;
  return null;
}
export function audioDoLead(lead) {
  const uid = donoDoLead(lead);
  return (uid ? getConfig(`audio_oficial_u${uid}`, "") : "") || getConfig("audio_oficial", "");
}

// ---------- usuarios ----------
export const listarUsuarios = () =>
  db.prepare("SELECT id, nome, email, papel, ativo, ultimo_acesso, gcal_email FROM usuarios ORDER BY id").all();
export const getUsuario = (id) => db.prepare("SELECT * FROM usuarios WHERE id = ?").get(id);
export const getUsuarioPorEmail = (email) =>
  db.prepare("SELECT * FROM usuarios WHERE lower(email) = lower(?) AND ativo = 1").get(String(email || "").trim());
export const criarUsuario = ({ nome, email, senha_hash, papel = "operador" }) =>
  db.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel) VALUES (?,?,?,?)")
    .run(nome, String(email).trim().toLowerCase(), senha_hash, papel).lastInsertRowid;
export function atualizarUsuario(id, campos) {
  const ok = ["nome", "email", "papel", "ativo", "senha_hash", "gcal_email"];
  const sets = Object.keys(campos).filter((k) => ok.includes(k));
  if (!sets.length) return;
  db.prepare(`UPDATE usuarios SET ${sets.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...campos, id });
}
export const marcarAcesso = (id) =>
  db.prepare("UPDATE usuarios SET ultimo_acesso = datetime('now') WHERE id = ?").run(id);

// ---------- pipelines / etapas ----------
export const listarPipelines = () =>
  db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM leads l WHERE l.pipeline_id = p.id) leads,
    (SELECT nome FROM instancias i WHERE i.id = p.instancia_id) whatsapp_nome
    FROM pipelines p WHERE arquivada = 0 ORDER BY ordem, id`).all();
export const getPipeline = (id) => db.prepare("SELECT * FROM pipelines WHERE id = ?").get(id);
export const etapasDaPipeline = (pipelineId) =>
  db.prepare("SELECT * FROM etapas WHERE pipeline_id = ? ORDER BY ordem, id").all(pipelineId);
export function atualizarPipeline(id, campos) {
  const ok = ["nome", "tipo", "instancia_id", "usuario_id", "cor", "ordem", "arquivada", "mapa_ligacao"];
  const sets = Object.keys(campos).filter((k) => ok.includes(k));
  if (!sets.length) return;
  db.prepare(`UPDATE pipelines SET ${sets.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...campos, id });
}
export const removerPipeline = (id) => {
  db.prepare("UPDATE pipelines SET arquivada = 1 WHERE id = ?").run(id); // nunca apaga: arquiva
};
export const addEtapa = (pipelineId, nome, ordem) =>
  db.prepare("INSERT INTO etapas (pipeline_id, nome, ordem) VALUES (?,?,?)").run(pipelineId, nome, ordem ?? 99).lastInsertRowid;
export function atualizarEtapa(id, campos) {
  const ok = ["nome", "ordem", "cor", "e_entrada", "e_ganho", "e_perdido"];
  const sets = Object.keys(campos).filter((k) => ok.includes(k));
  if (!sets.length) return;
  db.prepare(`UPDATE etapas SET ${sets.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...campos, id });
}
export const removerEtapa = (id) => db.prepare("DELETE FROM etapas WHERE id = ?").run(id);
export const etapaDeEntrada = (pipelineId) =>
  db.prepare("SELECT * FROM etapas WHERE pipeline_id = ? AND e_entrada = 1 ORDER BY ordem LIMIT 1").get(pipelineId)
  || db.prepare("SELECT * FROM etapas WHERE pipeline_id = ? ORDER BY ordem LIMIT 1").get(pipelineId);

// STATUS -> COLUNA: acha a etapa da pipeline do lead que corresponde ao status
// e move o card. Sem etapa equivalente: optout/descartado caem em Perdido;
// sem_whatsapp cai em Sem WhatsApp (ou Perdido se a coluna nao existir no funil).
export function sincronizarEtapa(leadId, status) {
  const l = db.prepare("SELECT pipeline_id FROM leads WHERE id = ?").get(leadId);
  if (!l?.pipeline_id) return;
  const chave = { reuniao_marcada: "reuniao", fechado: "ganho", optout: "perdido", descartado: "perdido" }[status] || status;
  let etapa = db.prepare("SELECT id FROM etapas WHERE pipeline_id = ? AND chave = ?").get(l.pipeline_id, chave);
  if (!etapa && chave === "sem_whatsapp")
    etapa = db.prepare("SELECT id FROM etapas WHERE pipeline_id = ? AND e_perdido = 1 ORDER BY ordem LIMIT 1").get(l.pipeline_id);
  if (etapa) db.prepare("UPDATE leads SET etapa_id = ? WHERE id = ?").run(etapa.id, leadId);
}

// MOVER card: entre etapas e ENTRE pipelines. Mover pra etapa de entrada de uma
// pipeline de DISPARO recoloca o lead na fila de envio (status volta pra 'novo'),
// que e exatamente o "liguei, nao atendeu -> joga pro disparo" que o Matheus pediu.
export function moverLead(leadId, etapaId) {
  const etapa = db.prepare("SELECT * FROM etapas WHERE id = ?").get(etapaId);
  if (!etapa) return null;
  const pipe = getPipeline(etapa.pipeline_id);
  const campos = { pipeline_id: etapa.pipeline_id, etapa_id: etapa.id };
  if (etapa.chave) campos.status = etapa.chave;
  else if (etapa.e_ganho) campos.status = "ganho";
  else if (etapa.e_perdido) campos.status = "perdido";
  db.prepare("UPDATE leads SET pipeline_id = @pipeline_id, etapa_id = @etapa_id, atualizado_em = datetime('now') WHERE id = @id")
    .run({ ...campos, id: leadId });
  if (campos.status) db.prepare("UPDATE leads SET status = ? WHERE id = ?").run(campos.status, leadId);

  // entrou na coluna de entrada de uma pipeline de disparo => volta pra fila
  if (pipe?.tipo === "disparo" && etapa.e_entrada) {
    const camp = db.prepare("SELECT id FROM campanhas WHERE pipeline_id = ? AND status = 'ativa' ORDER BY id LIMIT 1").get(pipe.id);
    if (camp) {
      const existe = db.prepare("SELECT 1 FROM campanha_leads WHERE campanha_id = ? AND lead_id = ?").get(camp.id, leadId);
      if (existe) db.prepare("UPDATE campanha_leads SET disparado_em = NULL WHERE campanha_id = ? AND lead_id = ?").run(camp.id, leadId);
      else db.prepare("INSERT INTO campanha_leads (campanha_id, lead_id) VALUES (?,?)").run(camp.id, leadId);
      db.prepare("UPDATE leads SET status = 'novo' WHERE id = ?").run(leadId);
    }
  }
  return getLead(leadId);
}

// ENTREGA PRO CLOSER: quando a IA marca reuniao, o lead sai do funil do SDR e
// entra no funil de closer, na coluna de entrada. Com varios closers, reveza
// (round-robin) pelo ultimo que recebeu — assim ninguem fica sobrecarregado.
export function entregarPraCloser(leadId) {
  const funis = db.prepare("SELECT * FROM pipelines WHERE tipo = 'closer' AND arquivada = 0 ORDER BY ordem, id").all();
  if (!funis.length) return null; // sem funil de closer: fluxo antigo segue valendo

  let alvo;
  if (funis.length === 1) alvo = funis[0];
  else {
    // reveza: pega o funil que recebeu ha mais tempo (ou nunca recebeu)
    const ultimo = Number(getConfig("closer_ultimo_funil", "0"));
    const i = funis.findIndex((f) => f.id === ultimo);
    alvo = funis[(i + 1) % funis.length];
  }
  setConfig("closer_ultimo_funil", String(alvo.id));

  const entrada = db.prepare("SELECT id FROM etapas WHERE pipeline_id = ? AND e_entrada = 1 ORDER BY ordem LIMIT 1").get(alvo.id)
    || db.prepare("SELECT id FROM etapas WHERE pipeline_id = ? ORDER BY ordem LIMIT 1").get(alvo.id);
  if (!entrada) return null;

  db.prepare(`UPDATE leads SET pipeline_id = ?, etapa_id = ?, usuario_id = COALESCE(?, usuario_id),
    atualizado_em = datetime('now') WHERE id = ?`).run(alvo.id, entrada.id, alvo.usuario_id || null, leadId);
  return { pipeline_id: alvo.id, pipeline_nome: alvo.nome, usuario_id: alvo.usuario_id || null };
}

// KANBAN: leads de uma pipeline agrupados por etapa, com valor somado por coluna
export function kanbanDaPipeline(pipelineId, filtros = {}) {
  const etapas = etapasDaPipeline(pipelineId);
  let sql = "SELECT * FROM leads WHERE pipeline_id = ? AND eh_teste = 0";
  const vals = [pipelineId];
  if (filtros.nicho) { sql += " AND nicho = ?"; vals.push(filtros.nicho); }
  if (filtros.tag) { sql += " AND tag_importacao = ?"; vals.push(filtros.tag); }
  if (filtros.usuario_id) { sql += " AND usuario_id = ?"; vals.push(filtros.usuario_id); }
  if (filtros.busca) { sql += " AND (nome_clinica LIKE ? OR telefone LIKE ?)"; vals.push(`%${filtros.busca}%`, `%${filtros.busca}%`); }
  // MOVIMENTACAO NO PERIODO: leads que tiveram evento (disparo, ligacao, moveu,
  // nota, reuniao...) OU mensagem entre as datas. criado_em e UTC -> converte pra SP.
  if (filtros.desde && filtros.ate) {
    sql += ` AND id IN (
      SELECT lead_id FROM eventos WHERE date(criado_em, '-3 hours') BETWEEN ? AND ?
      UNION SELECT lead_id FROM mensagens WHERE date(criado_em, '-3 hours') BETWEEN ? AND ?)`;
    vals.push(filtros.desde, filtros.ate, filtros.desde, filtros.ate);
  }
  sql += " ORDER BY atualizado_em DESC LIMIT 2000";
  let leads = db.prepare(sql).all(...vals);

  // tarefa aberta mais urgente de cada lead (pro card vermelho de atrasada)
  const tAberta = db.prepare(`SELECT id, texto, quando, hora, tipo FROM tarefas
    WHERE lead_id = ? AND feita = 0 ORDER BY COALESCE(quando,'9999') ASC, id ASC LIMIT 1`);
  const agora = agoraSP();
  const hoje = agora.data;
  for (const l of leads) {
    const t = tAberta.get(l.id);
    l.tarefa = t || null;
    l.tarefa_atrasada = tarefaVenceu(t, hoje, agora.hora);
  }
  if (filtros.atrasadas) leads = leads.filter((l) => l.tarefa_atrasada);

  return etapas.map((e) => {
    const doGrupo = leads.filter((l) => l.etapa_id === e.id);
    return {
      ...e,
      leads: doGrupo,
      total: doGrupo.length,
      valor_total: doGrupo.reduce((s, l) => s + (Number(l.valor_venda) || 0), 0),
    };
  });
}

// ---------- telefones do lead ----------
// A IA captura o numero do decisor como o lead DIGITOU ("3196501415", "34574424").
// Sem DDI/DDD o link de discagem e o wa.me nao funcionam. Aqui completamos o que
// falta usando o telefone da empresa como referencia (mesma cidade, mesmo pais).
export function normalizarTelefone(numero, referencia = null) {
  let t = String(numero || "").replace(/\D/g, "");
  if (!t) return "";
  const ref = String(referencia || "").replace(/\D/g, "");
  if (t.startsWith("55") && (t.length === 12 || t.length === 13)) return t; // ja completo
  if (ref.startsWith("55")) {
    const ddd = ref.slice(2, 4);
    if (t.length === 10 || t.length === 11) return "55" + t;        // faltava so o 55
    if (t.length === 8 || t.length === 9) return "55" + ddd + t;    // faltava 55 + DDD
  }
  if (t.length === 10 || t.length === 11) return "55" + t;          // sem referencia: assume BR
  return t;
}
export const telefonesDoLead = (leadId) =>
  db.prepare("SELECT * FROM telefones WHERE lead_id = ? ORDER BY principal DESC, id").all(leadId);
export function addTelefone(leadId, numero, tipo = "empresa", rotulo = null) {
  const lead = getLead(leadId);
  const tel = normalizarTelefone(numero, lead?.telefone);
  if (!tel) return null;
  const existe = db.prepare("SELECT id FROM telefones WHERE lead_id = ? AND numero = ?").get(leadId, tel);
  if (existe) return existe.id;
  const primeiro = !db.prepare("SELECT 1 FROM telefones WHERE lead_id = ?").get(leadId);
  return db.prepare("INSERT INTO telefones (lead_id, numero, tipo, rotulo, principal) VALUES (?,?,?,?,?)")
    .run(leadId, tel, tipo, rotulo, primeiro ? 1 : 0).lastInsertRowid;
}
export const removerTelefone = (id) => db.prepare("DELETE FROM telefones WHERE id = ?").run(id);
// EDITAR numero (digitou errado): corrige na linha, no lead (se for o decisor ou o
// principal) e nas threads que apontavam pro numero antigo — a conversa segue no card
export function editarTelefone(id, numeroNovo) {
  const t = db.prepare("SELECT * FROM telefones WHERE id = ?").get(id);
  if (!t) return { erro: "telefone nao existe" };
  const lead = getLead(t.lead_id);
  const novo = normalizarTelefone(numeroNovo, lead?.telefone);
  if (!novo) return { erro: "numero invalido" };
  db.prepare("UPDATE telefones SET numero = ? WHERE id = ?").run(novo, id);
  if (t.tipo === "decisor" && lead?.telefone_decisor === t.numero)
    db.prepare("UPDATE leads SET telefone_decisor = ? WHERE id = ?").run(novo, lead.id);
  if (t.principal && lead?.telefone === t.numero)
    db.prepare("UPDATE leads SET telefone = ? WHERE id = ?").run(novo, lead.id);
  for (const v of variantesTelefone(t.numero))
    db.prepare("UPDATE threads SET telefone = ? WHERE lead_id = ? AND telefone = ?").run(novo, t.lead_id, v);
  return { ok: true, numero: novo };
}

// ---------- threads (conversas paralelas do mesmo lead) ----------
export const threadsDoLead = (leadId) =>
  db.prepare("SELECT * FROM threads WHERE lead_id = ? ORDER BY id").all(leadId);
export const getThread = (id) => db.prepare("SELECT * FROM threads WHERE id = ?").get(id);
export function threadPorTelefone(telefone, instanciaId = null) {
  // So thread cujo LEAD AINDA EXISTE (apagar lead deixava a thread orfa, e ela
  // "roubava" a busca: o decisor respondia e a mensagem era descartada). Entre
  // varias, a mais recente vence.
  const VIVA = "SELECT t.* FROM threads t JOIN leads l ON l.id = t.lead_id WHERE t.telefone = ?";
  for (const v of variantesTelefone(telefone)) {
    // com 2 threads do mesmo numero (chips diferentes), a da instancia que
    // recebeu a mensagem vence — cada conversa segue no proprio numero
    if (instanciaId) {
      const tInst = db.prepare(`${VIVA} AND t.instancia_id = ? ORDER BY t.id DESC`).get(v, instanciaId);
      if (tInst) return tInst;
    }
    const t = db.prepare(`${VIVA} ORDER BY t.id DESC`).get(v);
    if (t) return t;
  }
  return null;
}
// abre (ou reusa) a conversa paralela com um numero do MESMO lead — nunca cria lead novo
export function abrirThread(leadId, telefone, rotulo = null, instanciaId = null, opts = {}) {
  const tel = String(telefone).replace(/\D/g, "");
  // dedup por telefone + CHIP: o mesmo numero da empresa pode ter duas conversas
  // (uma no chip do Matheus, outra no do Valentino) — cada uma e uma thread
  // estrita = so reusa thread do MESMO chip (fluxo "conversar pelo meu numero":
  // sem isso, o fallback de instancia NULL devolvia a conversa PADRAO antiga e o
  // clique caia na thread errada em vez de abrir a do chip da pessoa)
  const existe = instanciaId
    ? db.prepare("SELECT * FROM threads WHERE lead_id = ? AND telefone = ? AND COALESCE(instancia_id,0) = ?").get(leadId, tel, instanciaId)
      || (opts.estrita ? null : db.prepare("SELECT * FROM threads WHERE lead_id = ? AND telefone = ? AND instancia_id IS NULL").get(leadId, tel))
    : db.prepare("SELECT * FROM threads WHERE lead_id = ? AND telefone = ?").get(leadId, tel);
  if (existe) {
    // thread antiga com rotulo generico ganha o nome certo ("Contato" -> "Decisor"/"Empresa")
    if (rotulo && (!existe.rotulo || existe.rotulo === "Contato")) {
      db.prepare("UPDATE threads SET rotulo = ? WHERE id = ?").run(rotulo, existe.id);
      existe.rotulo = rotulo;
    }
    return existe;
  }
  const id = db.prepare("INSERT INTO threads (lead_id, telefone, rotulo, instancia_id, ia_pausada) VALUES (?,?,?,?,?)")
    .run(leadId, tel, rotulo, instanciaId, opts.iaPausada ? 1 : 0).lastInsertRowid;
  return getThread(id);
}

// QUAL CHIP atende esse lead: o da thread > o amarrado a pipeline dele >
// o do dono da pipeline > o primeiro conectado. Mantem a conversa sempre
// no MESMO numero (responder por outro chip abriria conversa nova no lead).
export function instanciaDoLead(lead, threadInstanciaId = null) {
  // ordem DETERMINISTICA (id) — nunca a de rotacao, senao a conversa troca de chip
  const insts = db.prepare("SELECT * FROM instancias WHERE status = 'conectado' ORDER BY id").all();
  if (!insts.length) return null;
  if (threadInstanciaId) {
    const t = insts.find((i) => i.id === threadInstanciaId);
    if (t) return t;
  }
  // o chip GRAVADO do lead e a fonte da verdade: a conversa vive naquele numero
  if (lead?.instancia_id) {
    const fixo = insts.find((i) => i.id === lead.instancia_id);
    if (fixo) return fixo;
  }
  if (lead?.pipeline_id) {
    const amarrada = insts.find((i) => i.pipeline_id === lead.pipeline_id);
    if (amarrada) return amarrada;
    const dono = getPipeline(lead.pipeline_id)?.usuario_id;
    if (dono) {
      const doDono = insts.find((i) => i.usuario_id === dono);
      if (doDono) return doDono;
      // FUNIL TEM DONO mas o chip dele esta fora: NAO envia pelo chip de outra
      // pessoa. Antes caia em insts[0] e o numero do Valentino falava com os
      // decisores do Matheus (26/08). Sem chip do dono = envio segurado.
      return null;
    }
  }
  // lead sem funil/dono definido: chip "da casa" (sem dono) e o unico aceitavel
  return insts.find((i) => !i.usuario_id) || null;
}
// cola o lead no chip (1a vez): dali em diante a conversa NUNCA muda de numero
export const fixarChipDoLead = (leadId, instanciaId) =>
  db.prepare("UPDATE leads SET instancia_id = ? WHERE id = ? AND (instancia_id IS NULL OR instancia_id <> ?)")
    .run(instanciaId, leadId, instanciaId);

// ---------- tarefas manuais do lead (minhas, nao da IA) ----------
export const tarefasDoLead = (leadId) =>
  db.prepare(`SELECT t.*, u.nome usuario_nome FROM tarefas t LEFT JOIN usuarios u ON u.id = t.usuario_id
    WHERE t.lead_id = ? ORDER BY t.feita ASC, COALESCE(t.quando,'9999') ASC, t.id DESC`).all(leadId);
export const addTarefa = (leadId, texto, quando, extra = {}) =>
  db.prepare("INSERT INTO tarefas (lead_id, texto, quando, hora, tipo, usuario_id) VALUES (?,?,?,?,?,?)")
    .run(leadId, texto, quando || null, extra.hora || null, extra.tipo || "followup", extra.usuario_id || null).lastInsertRowid;
export const setTarefaGcal = (id, eventId) =>
  db.prepare("UPDATE tarefas SET gcal_event_id = ? WHERE id = ?").run(eventId, id);
// TAREFAS ATRASADAS (pro card vermelho e o filtro do Kanban)
// VENCEU? dia anterior sempre; HOJE so depois da hora marcada (tarefa das 13h
// vira atrasada as 13h01, nao so amanha). Sem hora, vence no fim do dia.
export function tarefaVenceu(t, hoje = agoraSP().data, horaAgora = agoraSP().hora) {
  if (!t?.quando || t.feita) return false;
  if (t.quando < hoje) return true;
  if (t.quando > hoje) return false;
  return !!(t.hora && t.hora < horaAgora);
}
export const tarefasAtrasadas = () => {
  const { data, hora } = agoraSP();
  return db.prepare(`SELECT t.*, l.nome_clinica, l.pipeline_id FROM tarefas t JOIN leads l ON l.id = t.lead_id
    WHERE t.feita = 0 AND t.quando IS NOT NULL AND t.quando <= ? ORDER BY t.quando`).all(data)
    .filter((t) => tarefaVenceu(t, data, hora));
};
export const marcarTarefa = (id, feita) =>
  db.prepare("UPDATE tarefas SET feita = ? WHERE id = ?").run(feita ? 1 : 0, id);
// editar tarefa existente (texto/data/hora/tipo/responsavel) — pro modal de edicao do painel
export function atualizarTarefa(id, campos) {
  const permitidos = ["texto", "quando", "hora", "tipo", "usuario_id", "feita"];
  const sets = [], vals = [];
  for (const c of permitidos) if (c in campos) { sets.push(`${c} = ?`); vals.push(campos[c] ?? null); }
  if (!sets.length) return;
  db.prepare(`UPDATE tarefas SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}
export const removerTarefa = (id) => db.prepare("DELETE FROM tarefas WHERE id = ?").run(id);

// REENGAJAMENTO: leads que ENGAJARAM (respondeu/em conversa/decisor/negociando) e
// PARARAM de responder — a ultima mensagem foi NOSSA ha mais de `horas`. A IA cobra
// sozinha 1x (marca reengajado_em pra nao insistir). So em horario comercial (worker).
// REGUA DE FOLLOW-UP (cadencia diaria, 1 por dia por lead):
//   EM CONVERSA (empresa, sem contato do decisor): ate 2 follows -> depois PERDIDO
//   CONTATO C/ DECISOR (thread do decisor): ate 3 follows -> depois PERDIDO
// Espera `horas` desde a ultima mensagem NOSSA e so 1 follow por dia civil SP.
export const MAX_FOLLOWS_CONVERSA = 2;
export const MAX_FOLLOWS_DECISOR = 3;

// FOLLOW-UPS POR ETAPA: a campanha decide quantos follows cada etapa recebe.
// Sem config, valem os antigos (2 na empresa, 3 no decisor).
export function followupsDaCampanha(camp) {
  const base = { respondeu: MAX_FOLLOWS_CONVERSA, em_conversa: MAX_FOLLOWS_CONVERSA, negociando: MAX_FOLLOWS_CONVERSA, decisor: MAX_FOLLOWS_DECISOR };
  try {
    const j = camp?.followups_json ? JSON.parse(camp.followups_json) : null;
    if (j && typeof j === "object") for (const k of Object.keys(base)) if (j[k] !== undefined && j[k] !== null && j[k] !== "") base[k] = Math.max(0, Math.min(10, Number(j[k]) || 0));
  } catch { /* json invalido: fica o padrao */ }
  return base;
}
export const limiteFollow = (camp, etapa) => followupsDaCampanha(camp)[etapa] ?? MAX_FOLLOWS_CONVERSA;
// follows ja feitos NA ETAPA ATUAL do lead (mudou de etapa, a contagem recomeça)
export const followsNaEtapa = (lead) =>
  (!lead.follows_etapa || lead.follows_etapa === lead.status) ? (lead.follows_feitos || 0) : 0;

// Candidatos a follow-up. Inclui DOIS casos (o segundo era o buraco da regua,
// achado na analise de 04/09/26):
//   a) a IA falou por ultimo e o lead sumiu -> cobra
//   b) o LEAD falou por ultimo e ficou sem resposta -> RETOMA (a IA devolveu
//      acoes vazias e o lead virava orfao: nunca cobrado, nunca perdido)
// A coluna `retomada` diz qual dos dois, pro worker montar a instrucao certa.
export const leadsPraReengajar = (horas = 20) =>
  db.prepare(`SELECT l.*,
      ((SELECT role FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) = 'user') AS retomada
    FROM leads l
    WHERE l.eh_teste = 0 AND l.ia_pausada = 0
      AND COALESCE(l.follows_feitos,0) < 10
      AND l.status IN ('respondeu','em_conversa','negociando')
      AND (l.telefone_decisor IS NULL OR l.telefone_decisor = '')
      AND l.telefone NOT IN (SELECT telefone FROM blocklist)
      AND (SELECT criado_em FROM mensagens WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) <= datetime('now', '-' || ? || ' hours')
      AND (l.ultimo_follow_em IS NULL OR date(l.ultimo_follow_em,'-3 hours') < date('now','-3 hours'))
    LIMIT 40`).all(horas);

// THREADS do decisor paradas: a IA falou por ultimo e o decisor sumiu
export const threadsPraReengajar = (horas = 20) =>
  db.prepare(`SELECT t.*, l.nome_clinica, l.nome_decisor, l.pipeline_id, l.instancia_id lead_instancia,
      ((SELECT role FROM mensagens WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) = 'user') AS retomada
    FROM threads t JOIN leads l ON l.id = t.lead_id
    WHERE l.eh_teste = 0 AND l.ia_pausada = 0 AND t.ia_pausada = 0
      AND COALESCE(t.follows_feitos,0) < 10
      AND l.status NOT IN ('optout','descartado','perdido','fechado','reuniao_marcada')
      AND t.telefone <> l.telefone
      AND t.telefone NOT IN (SELECT telefone FROM blocklist)
      AND (SELECT criado_em FROM mensagens WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) <= datetime('now', '-' || ? || ' hours')
      AND (t.ultimo_follow_em IS NULL OR date(t.ultimo_follow_em,'-3 hours') < date('now','-3 hours'))
    LIMIT 40`).all(horas);

// registra o follow (contador + data) e devolve quantos ja foram
export function marcarReengajado(leadId) {
  const l = db.prepare("SELECT status, follows_etapa FROM leads WHERE id = ?").get(leadId);
  const mesmaEtapa = !l?.follows_etapa || l.follows_etapa === l.status;
  db.prepare(`UPDATE leads SET reengajado_em = datetime('now'), ultimo_follow_em = datetime('now'),
    follows_feitos = ${mesmaEtapa ? "COALESCE(follows_feitos,0) + 1" : "1"}, follows_etapa = status WHERE id = ?`).run(leadId);
  return db.prepare("SELECT follows_feitos f FROM leads WHERE id = ?").get(leadId)?.f || 0;
}
export function marcarReengajadoThread(threadId) {
  db.prepare(`UPDATE threads SET ultimo_follow_em = datetime('now'),
    follows_feitos = COALESCE(follows_feitos,0) + 1 WHERE id = ?`).run(threadId);
  return db.prepare("SELECT follows_feitos f FROM threads WHERE id = ?").get(threadId)?.f || 0;
}

// leads com follow-up agendado pela IA (mostra "tarefa" no card)
export const leadsComTarefa = () =>
  db.prepare(`SELECT id, nome_clinica, followup_em, followup_msg FROM leads
    WHERE followup_em IS NOT NULL AND ia_pausada = 0
      AND status NOT IN ('optout','descartado','perdido','fechado','sem_whatsapp')`).all();

// ---------- eventos ----------
export const registrarEvento = (leadId, tipo, detalhe = "") =>
  db.prepare("INSERT INTO eventos (lead_id, tipo, detalhe) VALUES (?, ?, ?)").run(leadId, tipo, detalhe);

// ---------- dedup webhook ----------
export function webhookJaVisto(messageId) {
  if (!messageId) return false;
  try {
    db.prepare("INSERT INTO webhook_eventos (message_id) VALUES (?)").run(messageId);
    return false;
  } catch { return true; } // PK violada = ja processado
}

// ---------- instancias (multi-WhatsApp + rotacao) ----------
export const listarInstancias = () =>
  db.prepare("SELECT * FROM instancias ORDER BY id").all();
export const getInstancia = (id) =>
  db.prepare("SELECT * FROM instancias WHERE id = ?").get(id);
export const getInstanciaPorToken = (token) =>
  token ? db.prepare("SELECT * FROM instancias WHERE uazapi_token = ?").get(token) : null;
export const criarInstanciaDB = (nome) =>
  db.prepare("INSERT INTO instancias (nome) VALUES (?)").run(nome).lastInsertRowid;
export const atualizarInstancia = (id, campos) => {
  const permitidos = ["nome", "uazapi_token", "numero", "status", "disparos_hoje", "cota_dia", "pipeline_id", "usuario_id"];
  const sets = [], vals = [];
  for (const k of permitidos) if (campos[k] !== undefined) { sets.push(`${k} = ?`); vals.push(campos[k]); }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE instancias SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
};
export const removerInstancia = (id) => db.prepare("DELETE FROM instancias WHERE id = ?").run(id);
// ROTACAO: conectadas, a com MENOS disparos hoje primeiro (round-robin).
export const instanciasConectadas = () =>
  db.prepare("SELECT * FROM instancias WHERE status = 'conectado' ORDER BY disparos_hoje ASC, id ASC").all();
// SPLIT MANUAL: conectada disponivel = cota_dia 0 (sem limite) OU ainda nao bateu a cota.
// Entre as disponiveis, prioriza quem esta MAIS LONGE de bater a cota (proporcao),
// pra respeitar o split (ex: 50/15/20 esvazia proporcional, nao 1-a-1).
// Escolhe o WhatsApp do disparo. Com `pipelineId`, respeita a dona: usa o número
// amarrado naquela pipeline, ou os números da pessoa dona dela. Sem nada amarrado,
// cai no rodízio geral (comportamento de sempre).
export const proximaInstanciaDisparo = (pipelineId = null) => {
  let insts = db.prepare("SELECT * FROM instancias WHERE status = 'conectado'").all()
    .filter((i) => !i.cota_dia || i.disparos_hoje < i.cota_dia);
  if (!insts.length) return null;
  if (pipelineId) {
    const pipe = getPipeline(pipelineId);
    const amarrado = insts.filter((i) => i.pipeline_id === pipelineId);
    if (amarrado.length) insts = amarrado;
    else if (pipe?.usuario_id) {
      const doDono = insts.filter((i) => i.usuario_id === pipe.usuario_id);
      if (doDono.length) insts = doDono;
    }
  }
  // "folga" = quanto ainda pode disparar; sem cota conta como folga infinita porem
  // desempata por menos disparos, mantendo o giro entre os numeros
  insts.sort((a, b) => {
    const fa = a.cota_dia ? (a.cota_dia - a.disparos_hoje) / a.cota_dia : Infinity;
    const fb = b.cota_dia ? (b.cota_dia - b.disparos_hoje) / b.cota_dia : Infinity;
    if (fb !== fa) return fb - fa;              // maior folga proporcional primeiro
    return a.disparos_hoje - b.disparos_hoje;   // empate: menos disparos
  });
  return insts[0];
};
export const addDisparoInstancia = (id) =>
  db.prepare("UPDATE instancias SET disparos_hoje = disparos_hoje + 1 WHERE id = ?").run(id);
export const zerarDisparosInstancias = () =>
  db.prepare("UPDATE instancias SET disparos_hoje = 0").run();

// ---------- campanhas / disparo ----------
// MULTI-CAMPANHA: uma campanha ativa POR FUNIL (Matheus e Valentino disparam em
// paralelo, cada um pelo chip do seu funil). O gate de cadencia segue GLOBAL:
// nunca sai mais de 1 mensagem a cada 3-7min somando tudo (protege os chips).
export const campanhasAtivas = () =>
  db.prepare("SELECT * FROM campanhas WHERE status = 'ativa' ORDER BY id").all();
export const campanhaDaPipeline = (pipelineId) =>
  pipelineId
    ? db.prepare("SELECT * FROM campanhas WHERE pipeline_id = ? AND status = 'ativa' ORDER BY id LIMIT 1").get(pipelineId)
    : null;
// teto por campanha: conta so as mensagens dos leads DAQUELE funil
// CONTAGEM DO DIA: sempre no fuso de SP ('-3 hours'). Com date(criado_em) cru
// (UTC) o teto zerava as 21h de SP e a campanha voltava a disparar de noite.
// TIPOS que consomem a cota do dia: abertura fria, reengajamento (regua),
// follow-up agendado pela IA e retomada pedida pela equipe. Faltava 'retomada'
// (criada em 04/09) — sem ela a retomada saia POR CIMA do teto.
export const TIPOS_ENVIO = ["disparo", "reengajamento", "followup", "retomada"];
const phEnvio = TIPOS_ENVIO.map(() => "?").join(",");

// QUAIS MENSAGENS SAO DESTA CAMPANHA: as de leads vinculados a ela, mais as de
// leads soltos (sem campanha nenhuma) que estao no funil dela. Contar por FUNIL,
// como era ate 05/09/26, somava duas campanhas do mesmo funil: a de Blumenau
// (3 msg) aparecia com o numero da de BH (21) e as duas dividiam a cota.
const SQL_DESTA_CAMPANHA = `(
  EXISTS (SELECT 1 FROM campanha_leads cl WHERE cl.lead_id = l.id AND cl.campanha_id = @camp)
  OR (NOT EXISTS (SELECT 1 FROM campanha_leads cl2 WHERE cl2.lead_id = l.id) AND l.pipeline_id = @pipe)
)`;
const SQL_ENVIO_HOJE = `SELECT COUNT(DISTINCT e.id) c FROM eventos e JOIN leads l ON l.id = e.lead_id
  WHERE e.tipo IN (${TIPOS_ENVIO.map((t) => `'${t}'`).join(",")})
    AND date(e.criado_em, '-3 hours') = date('now', '-3 hours')
    AND ${SQL_DESTA_CAMPANHA}`;

export const disparosHojeDaCampanha = (camp) => {
  if (!camp?.id) return disparosHoje();
  return db.prepare(SQL_ENVIO_HOJE).get({ camp: camp.id, pipe: camp.pipeline_id ?? -1 }).c;
};

// MINI RELATORIO do dia: quantas mensagens de cada tipo e por qual numero.
// Sem isso o painel so mostrava "16/20" sem dizer o que eram nem de onde sairam.
export function relatorioHojeDaCampanha(camp) {
  const vazio = { aberturas: 0, reengajamentos: 0, followups: 0, retomadas: 0, total: 0 };
  if (!camp?.id) return { ...vazio, por_chip: [] };
  const arg = { camp: camp.id, pipe: camp.pipeline_id ?? -1 };
  const linhas = db.prepare(`SELECT e.tipo, COUNT(DISTINCT e.id) n FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo IN (${TIPOS_ENVIO.map((t) => `'${t}'`).join(",")})
      AND date(e.criado_em, '-3 hours') = date('now', '-3 hours')
      AND ${SQL_DESTA_CAMPANHA} GROUP BY e.tipo`).all(arg);
  const mapa = { disparo: "aberturas", reengajamento: "reengajamentos", followup: "followups", retomada: "retomadas" };
  const r = { ...vazio };
  for (const l of linhas) { r[mapa[l.tipo]] = l.n; r.total += l.n; }

  // por NUMERO: o chip fica fixado no lead no primeiro disparo (instancia_id)
  r.por_chip = db.prepare(`SELECT i.id, i.nome, i.numero, i.status, i.disparos_hoje, i.cota_dia, COUNT(DISTINCT e.id) n
    FROM eventos e JOIN leads l ON l.id = e.lead_id JOIN instancias i ON i.id = l.instancia_id
    WHERE e.tipo IN (${TIPOS_ENVIO.map((t) => `'${t}'`).join(",")})
      AND date(e.criado_em, '-3 hours') = date('now', '-3 hours')
      AND ${SQL_DESTA_CAMPANHA} GROUP BY i.id ORDER BY n DESC`).all(arg);
  return r;
}
export const reengajamentosHojeDaCampanha = (camp) => {
  if (!camp?.id) return reengajamentosHoje();
  return db.prepare(`SELECT COUNT(DISTINCT e.id) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo = 'reengajamento'
      AND date(e.criado_em, '-3 hours') = date('now', '-3 hours')
      AND ${SQL_DESTA_CAMPANHA}`).get({ camp: camp.id, pipe: camp.pipeline_id ?? -1 }).c;
};
export const campanhaAtiva = () =>
  db.prepare("SELECT * FROM campanhas WHERE status = 'ativa' ORDER BY id LIMIT 1").get();
export const templatesDaCampanha = (campanhaId, tipo = "abertura") =>
  db.prepare("SELECT * FROM templates WHERE campanha_id = ? AND tipo = ?").all(campanhaId, tipo);

// TETO DIARIO = TODAS as mensagens ativas que saem pro WhatsApp hoje:
// disparo de abertura + reengajamento + follow-up de intermediario. Assim o numero
// que o cliente configura ("max/dia") e o VOLUME TOTAL que sai do chip, protegendo-o.
// numero sem WhatsApp NAO conta (nao gera evento 'disparo').
export const disparosHoje = () => {
  const { data } = agoraSP();
  return db.prepare(`SELECT COUNT(*) c FROM eventos
    WHERE tipo IN ('disparo','reengajamento','followup')
    AND datetime(criado_em, '-3 hours') >= datetime(? || ' 00:00')`).get(data).c;
};
// so as aberturas (pro dashboard mostrar o funil de prospeccao puro)
export const aberturasHoje = () => {
  const { data } = agoraSP();
  return db.prepare(`SELECT COUNT(*) c FROM eventos WHERE tipo = 'disparo'
    AND datetime(criado_em, '-3 hours') >= datetime(? || ' 00:00')`).get(data).c;
};
// reengajamentos enviados hoje (pra respeitar a cota de reengajamento)
export const reengajamentosHoje = () => {
  const { data } = agoraSP();
  return db.prepare(`SELECT COUNT(*) c FROM eventos WHERE tipo = 'reengajamento'
    AND datetime(criado_em, '-3 hours') >= datetime(? || ' 00:00')`).get(data).c;
};

// tira o lead da fila SEM contar como disparo (usado pra numero sem WhatsApp).
export const removerDaFila = (campanhaId, leadId) =>
  db.prepare("UPDATE campanha_leads SET disparado_em = datetime('now'), template_id = NULL WHERE campanha_id = ? AND lead_id = ?")
    .run(campanhaId, leadId);

export const proximoLeadPraDisparo = (campanhaId) =>
  db.prepare(`SELECT l.* FROM campanha_leads cl JOIN leads l ON l.id = cl.lead_id
    WHERE cl.campanha_id = ? AND cl.disparado_em IS NULL AND l.status = 'novo'
      AND l.telefone NOT IN (SELECT telefone FROM blocklist)
    ORDER BY l.id LIMIT 1`).get(campanhaId);

export const marcarDisparado = (campanhaId, leadId, templateId) => {
  db.prepare("UPDATE campanha_leads SET disparado_em = datetime('now'), template_id = ? WHERE campanha_id = ? AND lead_id = ?")
    .run(templateId, campanhaId, leadId);
  atualizarLead(leadId, { status: "disparado" });
};

// leads disparados sem resposta ha X horas (pro follow-up)
export const leadsPraFollowup = (campanhaId, coluna, horasMin, horasMax) =>
  db.prepare(`SELECT l.*, cl.disparado_em FROM campanha_leads cl JOIN leads l ON l.id = cl.lead_id
    WHERE cl.campanha_id = ? AND cl.disparado_em IS NOT NULL AND cl.${coluna} IS NULL
      AND l.status = 'disparado'
      AND cl.disparado_em <= datetime('now', '-' || ? || ' hours')
      AND cl.disparado_em >= datetime('now', '-' || ? || ' hours')
      AND l.telefone NOT IN (SELECT telefone FROM blocklist)
    ORDER BY cl.disparado_em LIMIT 5`).all(campanhaId, horasMin, horasMax);

export const marcarFollowup = (campanhaId, leadId, coluna) =>
  db.prepare(`UPDATE campanha_leads SET ${coluna} = datetime('now') WHERE campanha_id = ? AND lead_id = ?`)
    .run(campanhaId, leadId);

// ---------- reunioes ----------
export function marcarReuniao(leadId, closer, inicio, meetUrl, gcalEventId) {
  try {
    const r = db.prepare("INSERT INTO reunioes (lead_id, closer, inicio, meet_url, gcal_event_id) VALUES (?, ?, ?, ?, ?)")
      .run(leadId, closer, inicio, meetUrl || null, gcalEventId || null);
    atualizarLead(leadId, { status: "reuniao_marcada", closer });
    return { ok: true, id: r.lastInsertRowid };
  } catch (e) {
    return { ok: false, erro: /UNIQUE/.test(e.message) ? "horario_ocupado" : e.message };
  }
}
export const reunioesAtivas = (closer) =>
  db.prepare(`SELECT * FROM reunioes WHERE status IN ('marcada','remarcada')
    ${closer ? "AND closer = ?" : ""} ORDER BY inicio`).all(...(closer ? [closer] : []));
export const reuniaoAtivaDoLead = (leadId) =>
  db.prepare("SELECT * FROM reunioes WHERE lead_id = ? AND status IN ('marcada','remarcada') ORDER BY id DESC LIMIT 1").get(leadId);
export const cancelarReuniao = (id, status = "cancelada") =>
  db.prepare("UPDATE reunioes SET status = ? WHERE id = ?").run(status, id);

// ---------- metricas ----------
export function metricas() {
  const conta = (tipo) => db.prepare("SELECT COUNT(*) c FROM eventos WHERE tipo = ?").get(tipo).c;
  const porStatus = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) c FROM leads GROUP BY status").all().map((r) => [r.status, r.c]));
  return {
    disparos: conta("disparo"),
    respostas: conta("resposta"),
    reunioes: conta("reuniao"),
    optouts: conta("optout"),
    porStatus,
    disparosHoje: disparosHoje(),
  };
}
