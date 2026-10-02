// META ADS · API DE CONVERSOES
// Devolve pra Meta o que acontece com cada lead no funil (respondeu, qualificou,
// marcou reuniao, comprou, foi desqualificado) pra ela otimizar a campanha:
// achar mais gente parecida com quem compra e parar de buscar quem e desqualificado.
//
// Como funciona:
// 1. Um GATILHO no banco anota toda troca de coluna do card (arrastar, em massa,
//    ligacao, IA mudando status, entrega pro closer...) na tabela fila_etapas.
// 2. A cada 20s o processarFila() le essa fila e, se a coluna nova tem um evento
//    configurado (meta_mapa), cria o envio em meta_eventos.
// 3. enviarPendentes() manda pra Graph API. Falhou? tenta de novo com espera
//    crescente (2, 4, 8, 16 min) ate 5 vezes. Cada evento tem event_id fixo por
//    lead+evento, entao a Meta descarta duplicado e o mesmo evento nao sai 2x.
import { createHash } from "node:crypto";
import { db, getConfig, setConfig, getLead } from "./db.js";

const VERSAO = process.env.META_API_VERSION || "v23.0";
const GRAPH = `https://graph.facebook.com/${VERSAO}`;

// ---------- banco ----------
for (const sql of [
  // frio = veio de lista importada; quente = chegou por anuncio da Meta
  "ALTER TABLE leads ADD COLUMN origem_tipo TEXT",
  "ALTER TABLE leads ADD COLUMN ctwa_clid TEXT",
  "ALTER TABLE leads ADD COLUMN anuncio_info TEXT",
]) { try { db.exec(sql); } catch { /* ja existe */ } }

db.exec(`CREATE TABLE IF NOT EXISTS fila_etapas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  de_etapa_id INTEGER,
  para_etapa_id INTEGER NOT NULL,
  criado_em TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TRIGGER IF NOT EXISTS trg_lead_etapa_upd AFTER UPDATE OF etapa_id ON leads
  WHEN NEW.etapa_id IS NOT NULL AND (OLD.etapa_id IS NULL OR OLD.etapa_id != NEW.etapa_id)
  BEGIN INSERT INTO fila_etapas (lead_id, de_etapa_id, para_etapa_id) VALUES (NEW.id, OLD.etapa_id, NEW.etapa_id); END`);
db.exec(`CREATE TRIGGER IF NOT EXISTS trg_lead_etapa_ins AFTER INSERT ON leads
  WHEN NEW.etapa_id IS NOT NULL
  BEGIN INSERT INTO fila_etapas (lead_id, de_etapa_id, para_etapa_id) VALUES (NEW.id, NULL, NEW.etapa_id); END`);

db.exec(`CREATE TABLE IF NOT EXISTS meta_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  etapa_id INTEGER,
  evento TEXT NOT NULL,
  event_id TEXT UNIQUE,
  status TEXT DEFAULT 'pendente',
  origem TEXT,
  quente INTEGER DEFAULT 0,
  valor REAL,
  tentativas INTEGER DEFAULT 0,
  proxima_em TEXT,
  resposta TEXT,
  criado_em TEXT DEFAULT (datetime('now')),
  enviado_em TEXT
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_meta_ev_status ON meta_eventos(status, proxima_em)");

// ---------- config ----------
export const EVENTOS_META = [
  { id: "Lead", rot: "Lead", desc: "Entrou em contato / virou lead" },
  { id: "Contact", rot: "Contato", desc: "Conversou com a empresa" },
  { id: "LeadQualificado", rot: "Lead qualificado", desc: "Tem perfil (falou com o decisor, tem interesse)" },
  { id: "Schedule", rot: "Agendamento", desc: "Marcou reunião" },
  { id: "Purchase", rot: "Compra", desc: "Fechou. Envia o valor do card" },
  { id: "LeadDesqualificado", rot: "Lead desqualificado", desc: "Sem perfil. Ensina a Meta a parar de buscar esse tipo" },
];
const EVENTO_RE = /^[A-Za-z][A-Za-z0-9_]{1,39}$/;

export function configMeta() {
  let mapa = {};
  try { mapa = JSON.parse(getConfig("meta_mapa", "{}") || "{}"); } catch { mapa = {}; }
  return {
    ativo: getConfig("meta_ativo", "0") === "1",
    pixel: getConfig("meta_pixel", "") || "",
    token: getConfig("meta_token", "") || "",
    teste: getConfig("meta_teste_codigo", "") || "",
    waba: getConfig("meta_waba", "") || "",
    quais: getConfig("meta_quais", "quentes") === "todos" ? "todos" : "quentes",
    funilAnuncio: Number(getConfig("meta_funil_anuncio", "0")) || null,
    iaAnuncio: getConfig("meta_ia_anuncio", "1") !== "0",
    mapa,
  };
}
export const metaPronta = (c = configMeta()) => c.ativo && /^\d{5,20}$/.test(c.pixel) && c.token.length > 20;

// salva o que veio do painel (token so troca se mandaram um novo)
export function salvarConfigMeta(b = {}) {
  const erros = [];
  if (b.pixel !== undefined) {
    const p = String(b.pixel || "").replace(/\D/g, "");
    if (p && !/^\d{5,20}$/.test(p)) erros.push("o ID do pixel são só números");
    else setConfig("meta_pixel", p);
  }
  if (b.token) {
    const t = String(b.token).trim();
    if (t.length < 20 || /\s/.test(t)) erros.push("esse token não parece válido");
    else setConfig("meta_token", t);
  }
  if (b.apagar_token) setConfig("meta_token", "");
  if (b.teste !== undefined) setConfig("meta_teste_codigo", String(b.teste || "").trim().slice(0, 40));
  if (b.waba !== undefined) setConfig("meta_waba", String(b.waba || "").replace(/\D/g, "").slice(0, 25));
  if (b.quais !== undefined) setConfig("meta_quais", b.quais === "todos" ? "todos" : "quentes");
  if (b.funil_anuncio !== undefined) setConfig("meta_funil_anuncio", String(Number(b.funil_anuncio) || ""));
  if (b.ia_anuncio !== undefined) setConfig("meta_ia_anuncio", b.ia_anuncio ? "1" : "0");
  if (b.mapa && typeof b.mapa === "object") {
    const limpo = {};
    for (const [etapa, ev] of Object.entries(b.mapa)) {
      if (!/^\d+$/.test(etapa) || !ev) continue;
      if (EVENTO_RE.test(String(ev))) limpo[etapa] = String(ev);
    }
    setConfig("meta_mapa", JSON.stringify(limpo));
  }
  if (b.ativo !== undefined) {
    if (b.ativo && !metaPronta({ ...configMeta(), ativo: true })) erros.push("pra ligar, preencha o ID do pixel e o token");
    else setConfig("meta_ativo", b.ativo ? "1" : "0");
  }
  return erros;
}

// ---------- dados do lead (criptografados como a Meta pede) ----------
const sha = (v) => createHash("sha256").update(String(v)).digest("hex");
const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
function telefoneE164(tel) {
  let d = String(tel || "").replace(/\D/g, "");
  if (!d || d.startsWith("0000")) return null; // lead simulado
  if (d.length <= 11) d = "55" + d;
  return d;
}
function montarEvento(ev, lead, cfg) {
  const etapa = ev.etapa_id ? db.prepare("SELECT e.nome, p.nome pipeline FROM etapas e LEFT JOIN pipelines p ON p.id = e.pipeline_id WHERE e.id = ?").get(ev.etapa_id) : null;
  const user = { external_id: [sha(`prospecta:${lead.id}`)], country: [sha("br")] };
  const tel = telefoneE164(lead.telefone);
  if (tel) user.ph = [sha(tel)];
  const telDec = telefoneE164(lead.telefone_decisor);
  if (telDec && telDec !== tel) user.ph = [...(user.ph || []), sha(telDec)];
  const cidade = semAcento(lead.cidade).toLowerCase().replace(/[^a-z]/g, "");
  if (cidade) user.ct = [sha(cidade)];
  const custom = {
    lead_event_source: "Prospecta",
    event_source: "crm",
    etapa: etapa?.nome || undefined,
    funil: etapa?.pipeline || undefined,
    tipo_lead: lead.origem_tipo === "quente" ? "quente" : "frio",
  };
  if (ev.evento === "LeadDesqualificado" && lead.motivo_perda) custom.motivo = String(lead.motivo_perda).slice(0, 100);
  if (ev.evento === "Purchase") { custom.value = Number(ev.valor) || 0; custom.currency = "BRL"; }
  const base = {
    event_name: ev.evento,
    event_time: Math.floor(new Date(String(ev.criado_em).replace(" ", "T") + "Z").getTime() / 1000) || Math.floor(Date.now() / 1000),
    event_id: ev.event_id,
    user_data: user,
    custom_data: custom,
  };
  // lead que veio de anuncio de clique pro WhatsApp: liga o evento ao clique
  if (lead.ctwa_clid && cfg.waba) {
    return { ...base, action_source: "business_messaging", messaging_channel: "whatsapp",
      user_data: { ...user, ctwa_clid: lead.ctwa_clid, whatsapp_business_account_id: cfg.waba } };
  }
  return { ...base, action_source: "system_generated" };
}

async function postarEventos(cfg, eventos, codigoTeste) {
  const corpo = { data: eventos, access_token: cfg.token };
  if (codigoTeste) corpo.test_event_code = codigoTeste;
  const r = await fetch(`${GRAPH}/${cfg.pixel}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const e = d.error || {};
    const err = new Error(e.error_user_msg || e.message || `HTTP ${r.status}`);
    err.codigo = e.code;
    throw err;
  }
  return d;
}

// ---------- fila: troca de coluna -> evento ----------
function origemDoMovimento(leadId, paraEtapaId) {
  const m = db.prepare(`SELECT usuario_nome, origem FROM movimentacoes
    WHERE lead_id = ? AND para_etapa_id = ? AND criado_em >= datetime('now', '-3 minutes') ORDER BY id DESC LIMIT 1`).get(leadId, paraEtapaId);
  if (m?.usuario_nome) return `${m.usuario_nome} (${m.origem || "manual"})`;
  return "IA / automático";
}
export function processarFila() {
  const linhas = db.prepare("SELECT * FROM fila_etapas ORDER BY id LIMIT 500").all();
  if (!linhas.length) return 0;
  db.prepare("DELETE FROM fila_etapas WHERE id <= ?").run(linhas[linhas.length - 1].id);
  const cfg = configMeta();
  if (!metaPronta(cfg)) return 0;
  let n = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO meta_eventos (lead_id, etapa_id, evento, event_id, origem, quente, valor, criado_em)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const f of linhas) {
    const evento = cfg.mapa[String(f.para_etapa_id)];
    if (!evento) continue;
    const lead = getLead(f.lead_id);
    if (!lead || lead.eh_teste) continue;
    const quente = lead.origem_tipo === "quente";
    if (cfg.quais === "quentes" && !quente) continue; // lista fria fica de fora (padrao)
    const r = ins.run(lead.id, f.para_etapa_id, evento, `prospecta-${lead.id}-${evento}`, origemDoMovimento(lead.id, f.para_etapa_id),
      quente ? 1 : 0, Number(lead.valor_venda) || null, f.criado_em);
    n += r.changes;
  }
  return n;
}

let enviando = false;
export async function enviarPendentes() {
  if (enviando) return;
  const cfg = configMeta();
  if (!metaPronta(cfg)) return;
  enviando = true;
  try {
    const pend = db.prepare(`SELECT * FROM meta_eventos WHERE status IN ('pendente','erro') AND tentativas < 5
      AND (proxima_em IS NULL OR proxima_em <= datetime('now')) ORDER BY id LIMIT 40`).all();
    for (const ev of pend) {
      const lead = getLead(ev.lead_id);
      if (!lead) { db.prepare("UPDATE meta_eventos SET status = 'ignorado', resposta = 'lead excluído' WHERE id = ?").run(ev.id); continue; }
      // a Meta so aceita eventos de ate 7 dias atras
      if (Date.now() - new Date(String(ev.criado_em).replace(" ", "T") + "Z").getTime() > 6.5 * 86400_000) {
        db.prepare("UPDATE meta_eventos SET status = 'ignorado', resposta = 'passou de 7 dias, a Meta não aceita mais' WHERE id = ?").run(ev.id);
        continue;
      }
      try {
        const d = await postarEventos(cfg, [montarEvento(ev, lead, cfg)], cfg.teste || null);
        db.prepare("UPDATE meta_eventos SET status = 'enviado', enviado_em = datetime('now'), resposta = ? WHERE id = ?")
          .run(`recebido pela Meta${cfg.teste ? " (modo teste)" : ""}${d.fbtrace_id ? " · " + d.fbtrace_id : ""}`, ev.id);
      } catch (e) {
        const t = ev.tentativas + 1;
        db.prepare(`UPDATE meta_eventos SET status = 'erro', tentativas = ?, resposta = ?,
          proxima_em = datetime('now', ?) WHERE id = ?`).run(t, String(e.message).slice(0, 300), `+${2 ** t} minutes`, ev.id);
        if (e.codigo === 190 || e.codigo === 100) break; // token invalido / pixel errado: nao adianta seguir agora
      }
    }
  } finally {
    enviando = false;
  }
}

export function reenviarEvento(id) {
  return db.prepare("UPDATE meta_eventos SET status = 'pendente', tentativas = 0, proxima_em = NULL WHERE id = ? AND status != 'enviado'").run(Number(id)).changes;
}

// testa o token (le o pixel) e, com codigo de teste, manda um evento de teste
export async function testarConexaoMeta() {
  const cfg = configMeta();
  if (!/^\d{5,20}$/.test(cfg.pixel)) return { ok: false, erro: "preencha o ID do pixel" };
  if (cfg.token.length < 20) return { ok: false, erro: "preencha o token de acesso" };
  try {
    const r = await fetch(`${GRAPH}/${cfg.pixel}?fields=id,name&access_token=${encodeURIComponent(cfg.token)}`, { signal: AbortSignal.timeout(12_000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) return { ok: false, erro: d.error?.error_user_msg || d.error?.message || `HTTP ${r.status}` };
    const res = { ok: true, nome: d.name || null };
    if (cfg.teste) {
      const ev = { event_name: "Lead", event_time: Math.floor(Date.now() / 1000), event_id: `prospecta-teste-${Date.now()}`,
        action_source: "system_generated", user_data: { external_id: [sha("prospecta:teste")], country: [sha("br")] },
        custom_data: { lead_event_source: "Prospecta", event_source: "crm" } };
      const e = await postarEventos(cfg, [ev], cfg.teste);
      res.teste = `evento de teste recebido (${e.events_received || 0}). Confira em Gerenciador de Eventos > Eventos de teste.`;
    }
    return res;
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

export function resumoMeta() {
  const q = (sql) => db.prepare(sql).get().n;
  return {
    enviados7: q("SELECT COUNT(*) n FROM meta_eventos WHERE status = 'enviado' AND enviado_em >= datetime('now','-7 days')"),
    erros: q("SELECT COUNT(*) n FROM meta_eventos WHERE status = 'erro'"),
    pendentes: q("SELECT COUNT(*) n FROM meta_eventos WHERE status = 'pendente'"),
    quentes: q("SELECT COUNT(*) n FROM leads WHERE origem_tipo = 'quente'"),
    desqualificados: q("SELECT COUNT(*) n FROM meta_eventos WHERE evento = 'LeadDesqualificado' AND status = 'enviado'"),
  };
}
export const ultimosEventosMeta = (limite = 40) => db.prepare(`SELECT m.id, m.lead_id, m.evento, m.status, m.origem, m.quente,
  m.tentativas, m.resposta, m.criado_em, m.enviado_em, l.nome_clinica, e.nome etapa
  FROM meta_eventos m LEFT JOIN leads l ON l.id = m.lead_id LEFT JOIN etapas e ON e.id = m.etapa_id
  ORDER BY m.id DESC LIMIT ?`).all(limite);

// ---------- anuncio: le o clique do anuncio no webhook ----------
// O WhatsApp manda a origem do anuncio de "clique pro WhatsApp" dentro do
// contextInfo (externalAdReply / ctwaClid) ou num "referral". Cada versao da
// uazapi poe isso num lugar, entao procura pelo payload todo (ate 8 niveis).
export function infoAnuncio(payload) {
  const achado = { clid: null, titulo: null, source_id: null, source_url: null };
  let temAnuncio = false;
  const visitar = (o, nivel) => {
    if (!o || typeof o !== "object" || nivel > 8) return;
    for (const [k, v] of Object.entries(o)) {
      const kl = k.toLowerCase();
      if ((kl === "ctwaclid" || kl === "ctwa_clid") && typeof v === "string" && v) { achado.clid = v.slice(0, 500); temAnuncio = true; }
      else if ((kl === "externaladreply" || kl === "referral") && v && typeof v === "object") {
        temAnuncio = true;
        achado.titulo ||= String(v.title || v.headline || v.body || "").slice(0, 150) || null;
        achado.source_id ||= String(v.sourceId || v.source_id || "").slice(0, 60) || null;
        achado.source_url ||= String(v.sourceUrl || v.source_url || "").slice(0, 300) || null;
        visitar(v, nivel + 1);
      } else if (v && typeof v === "object") visitar(v, nivel + 1);
    }
  };
  visitar(payload, 0);
  return temAnuncio ? achado : null;
}

export function marcarLeadQuente(leadId, anuncio) {
  db.prepare(`UPDATE leads SET origem_tipo = 'quente', ctwa_clid = COALESCE(?, ctwa_clid),
    anuncio_info = ? WHERE id = ?`).run(anuncio.clid || null, JSON.stringify({ titulo: anuncio.titulo, source_id: anuncio.source_id, source_url: anuncio.source_url }), leadId);
}

let iniciado = false;
export function iniciarMeta() {
  if (iniciado) return;
  iniciado = true;
  setInterval(() => {
    try { processarFila(); } catch (e) { console.error("[meta] fila:", e.message); }
    enviarPendentes().catch((e) => console.error("[meta] envio:", e.message));
  }, 20_000);
}
