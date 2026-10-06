// ADMIN DO DONO (so no SDR interno da VPS, so papel admin).
// Le e administra os containers dos clientes em /root/sdr-clientes/<slug>:
//   - lista com uso, saude, cobranca e alertas
//   - cobranca: valor, vencimento, inicio, historico de pagamentos
//   - usuarios de cada cliente: criar, desativar, remover, redefinir senha
//   - cofre: senha que O ADMIN definiu fica cifrada (AES-256-GCM) e pode ser
//     vista de novo com a senha do admin. A senha que o cliente trocou sozinho
//     nao existe em lugar nenhum (so o hash) e nunca pode ser mostrada.
//   - criar cliente (roda deploy/novo-cliente.sh) e cancelar (para o container
//     e arquiva a pasta, dados preservados)
import express from "express";
import { execFile } from "node:child_process";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { db, agoraSP, registrarEvento } from "./db.js";

const BASE = process.env.SDR_CLIENTES_DIR || "/root/sdr-clientes";
const ARQUIVO = process.env.SDR_ARQUIVADOS_DIR || "/root/sdr-clientes-arquivados";
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG_RE = /^[a-z0-9-]{2,40}$/;
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

// ---------- banco interno ----------
db.exec(`CREATE TABLE IF NOT EXISTS admin_clientes (
  slug TEXT PRIMARY KEY,
  plano TEXT,
  valor_mensal REAL,
  dia_vencimento INTEGER,
  inicio_em TEXT,
  proxima_cobranca TEXT,
  status TEXT DEFAULT 'ativo',
  contato_nome TEXT,
  contato_whats TEXT,
  observacoes TEXT,
  tags TEXT,
  cancelado_em TEXT,
  atualizado_em TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS admin_cobrancas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  valor REAL NOT NULL,
  referente TEXT,
  pago_em TEXT NOT NULL,
  forma TEXT,
  obs TEXT,
  autor TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS admin_cofre (
  slug TEXT NOT NULL,
  alvo TEXT NOT NULL,
  email TEXT,
  cifrado TEXT NOT NULL,
  hash TEXT NOT NULL,
  criado_em TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (slug, alvo)
)`);

// ---------- cofre (AES-256-GCM) ----------
// chave: ADMIN_COFRE_KEY do .env interno; sem ela, deriva do token do painel
// interno. Trocar qualquer um dos dois torna o cofre ilegivel (senhas somem,
// e so redefinir de novo).
const chaveCofre = () => createHash("sha256").update(process.env.ADMIN_COFRE_KEY || `cofre:${process.env.PAINEL_SENHA || ""}`).digest();
function cifrar(txt) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", chaveCofre(), iv);
  const ct = Buffer.concat([c.update(String(txt), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(":");
}
function decifrar(pacote) {
  const [iv, tag, ct] = String(pacote).split(":").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", chaveCofre(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
const guardarNoCofre = (slug, alvo, email, senha) => db.prepare(`INSERT INTO admin_cofre (slug, alvo, email, cifrado, hash) VALUES (?,?,?,?,?)
  ON CONFLICT(slug, alvo) DO UPDATE SET email = excluded.email, cifrado = excluded.cifrado, hash = excluded.hash, criado_em = datetime('now')`)
  .run(slug, alvo, email || null, cifrar(senha), sha(senha));

// ---------- helpers de cliente ----------
const dirCliente = (slug) => join(BASE, slug);
function lerEnv(slug) {
  const arq = join(dirCliente(slug), ".env");
  if (!existsSync(arq)) return null;
  const txt = readFileSync(arq, "utf8");
  const pega = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim() || "";
  return { pega, criadoEm: (() => { try { const s = statSync(arq); return (s.birthtime?.getTime() ? s.birthtime : s.mtime).toISOString(); } catch { return null; } })() };
}
function abrirDb(slug, escrever = false) {
  const arq = join(dirCliente(slug), "dados", "sdr.db");
  const cdb = new Database(arq, { readonly: !escrever, fileMustExist: true });
  cdb.pragma("busy_timeout = 4000");
  return cdb;
}
const cfgCliente = (cdb, chave, def = "") => { try { return cdb.prepare("SELECT valor FROM config WHERE chave = ?").get(chave)?.valor ?? def; } catch { return def; } };
const setCfgCliente = (cdb, chave, valor) => cdb.prepare("INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(chave, String(valor));
const listarSlugs = () => existsSync(BASE) ? readdirSync(BASE).filter((s) => SLUG_RE.test(s) && existsSync(join(BASE, s, ".env"))) : [];
const slugValido = (s) => SLUG_RE.test(String(s || "")) && existsSync(join(BASE, s, ".env"));

function rodar(cmd, args, timeout = 8000) {
  return new Promise((ok) => execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) =>
    ok({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") })));
}
async function statusContainers() {
  const r = await rodar("docker", ["ps", "-a", "--format", "{{.Names}}|{{.State}}|{{.Status}}"], 5000);
  const mapa = {};
  if (!r.ok) return null; // sem docker (fora da VPS): status desconhecido
  for (const l of r.stdout.trim().split("\n")) {
    const [nome, estado, desc] = l.split("|");
    if (nome?.startsWith("sdr-")) mapa[nome.slice(4)] = { estado, desc };
  }
  return mapa;
}

// ---------- datas (dia civil de SP) ----------
const hojeSP = () => agoraSP().data; // AAAA-MM-DD
function somarMeses(iso, n, dia) {
  const [a, m] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(dia || Number(iso.slice(8, 10)), ultimo));
  return alvo.toISOString().slice(0, 10);
}
const difDias = (a, b) => Math.round((new Date(a + "T12:00:00Z") - new Date(b + "T12:00:00Z")) / 86400_000);

// cadastro de cobranca do cliente (cria com padroes na primeira leitura)
function cadastro(slug, env) {
  let c = db.prepare("SELECT * FROM admin_clientes WHERE slug = ?").get(slug);
  if (!c) {
    const inicio = (env?.criadoEm || new Date().toISOString()).slice(0, 10);
    const whats = Number(env?.pega("WHATSAPPS_LIMITE")) || 1;
    const dia = Number(inicio.slice(8, 10));
    let prox = somarMeses(inicio, 1, dia);
    while (prox < hojeSP()) prox = somarMeses(prox, 1, dia);
    db.prepare(`INSERT INTO admin_clientes (slug, plano, valor_mensal, dia_vencimento, inicio_em, proxima_cobranca, status)
      VALUES (?,?,?,?,?,?, 'ativo')`).run(slug, "Prospecta", 100 + Math.max(0, whats - 1) * 20, dia, inicio, prox);
    c = db.prepare("SELECT * FROM admin_clientes WHERE slug = ?").get(slug);
  }
  return c;
}

function metricas(slug) {
  const m = { leads: 0, disparos: 0, disparos7: 0, respostas7: 0, reunioes: 0, reunioes30: 0, whats_conectados: 0, whats_total: 0,
    usuarios: 0, pausada: false, ia_sem_saldo: false, assinatura_status: "", ultimo_acesso: null, ultima_atividade: null, erro: null };
  try {
    const cdb = abrirDb(slug);
    const n = (sql, ...a) => { try { return cdb.prepare(sql).get(...a)?.n ?? 0; } catch { return 0; } };
    const v = (sql) => { try { return cdb.prepare(sql).get()?.v ?? null; } catch { return null; } };
    m.leads = n("SELECT COUNT(*) n FROM leads WHERE eh_teste = 0");
    m.disparos = n("SELECT COUNT(*) n FROM eventos WHERE tipo = 'disparo'");
    m.disparos7 = n("SELECT COUNT(*) n FROM eventos WHERE tipo = 'disparo' AND criado_em >= datetime('now','-7 days')");
    m.respostas7 = n("SELECT COUNT(*) n FROM eventos WHERE tipo = 'resposta' AND criado_em >= datetime('now','-7 days')");
    m.reunioes = n("SELECT COUNT(*) n FROM eventos WHERE tipo = 'reuniao'");
    m.reunioes30 = n("SELECT COUNT(*) n FROM eventos WHERE tipo = 'reuniao' AND criado_em >= datetime('now','-30 days')");
    m.whats_conectados = n("SELECT COUNT(*) n FROM instancias WHERE status = 'conectado'");
    m.whats_total = n("SELECT COUNT(*) n FROM instancias");
    m.usuarios = n("SELECT COUNT(*) n FROM usuarios WHERE ativo = 1");
    m.pausada = cfgCliente(cdb, "conta_pausada") === "1";
    m.ia_sem_saldo = Boolean(cfgCliente(cdb, "anthropic_sem_saldo"));
    m.assinatura_status = cfgCliente(cdb, "assinatura_status");
    m.ultimo_acesso = v("SELECT MAX(ultimo_acesso) v FROM usuarios");
    m.ultima_atividade = v("SELECT MAX(criado_em) v FROM eventos");
    cdb.close();
  } catch (e) { m.erro = String(e.message).slice(0, 80); }
  return m;
}

function situacao(cad, met, cont) {
  if (cad.status === "cancelado") return { chave: "cancelado", rot: "Cancelado" };
  if (met.pausada) return { chave: "pausado", rot: "Disparos pausados" };
  if (cad.status === "trial") return { chave: "trial", rot: "Teste grátis" };
  if (cad.proxima_cobranca) {
    const d = difDias(cad.proxima_cobranca, hojeSP());
    if (d < 0) return { chave: "atrasado", rot: `Atrasado há ${-d} dia${d === -1 ? "" : "s"}`, dias: d };
    if (d <= 5) return { chave: "vence", rot: d === 0 ? "Vence hoje" : `Vence em ${d} dia${d === 1 ? "" : "s"}`, dias: d };
    return { chave: "em_dia", rot: "Em dia", dias: d };
  }
  return { chave: "em_dia", rot: "Em dia" };
}
function alertasDe(c) {
  const a = [];
  if (c.cadastro.status === "cancelado") return a;
  if (c.situacao.chave === "atrasado") a.push({ nivel: "alto", txt: `Pagamento atrasado (venceu ${c.cadastro.proxima_cobranca.split("-").reverse().join("/")})` });
  if (c.situacao.chave === "vence") a.push({ nivel: "medio", txt: c.situacao.rot });
  if (c.container && c.container.estado !== "running") a.push({ nivel: "alto", txt: "Sistema fora do ar (container parado)" });
  if (c.metricas.erro) a.push({ nivel: "alto", txt: "Não consegui ler o banco desse cliente" });
  if (c.metricas.ia_sem_saldo) a.push({ nivel: "alto", txt: "IA sem saldo: a chave da Anthropic precisa de crédito" });
  if (!c.metricas.erro && c.metricas.whats_total && !c.metricas.whats_conectados) a.push({ nivel: "medio", txt: "Nenhum WhatsApp conectado" });
  if (!c.metricas.erro && !c.metricas.whats_total) a.push({ nivel: "baixo", txt: "Ainda não conectou o WhatsApp" });
  const ref = c.metricas.ultimo_acesso || c.metricas.ultima_atividade;
  if (ref && Date.now() - new Date(ref.replace(" ", "T") + "Z").getTime() > 7 * 86400_000) a.push({ nivel: "baixo", txt: "Sem acesso há mais de 7 dias" });
  return a;
}

async function montarCliente(slug, conts) {
  const env = lerEnv(slug);
  const cad = cadastro(slug, env);
  const met = metricas(slug);
  const c = {
    slug, nome: env?.pega("CLIENTE_NOME") || slug, email: env?.pega("PAINEL_EMAIL") || "", url: env?.pega("APP_URL") || "",
    whats_limite: Number(env?.pega("WHATSAPPS_LIMITE")) || 1, cadastro: cad, metricas: met,
    container: conts ? (conts[slug] || { estado: "inexistente", desc: "" }) : null,
  };
  c.situacao = situacao(cad, met, c.container);
  c.alertas = alertasDe(c);
  return c;
}

// ============================================================
// ROTAS
// ============================================================
export function rotasAdmin({ senhaConfere }) {
  const r = express.Router();
  const pedirSenha = (req, res) => {
    const conf = senhaConfere(req, req.body?.senha_admin);
    if (!conf.ok) { res.status(403).json({ erro: conf.erro, precisa_senha: true }); return false; }
    return true;
  };
  const log = (req, slug, txt) => registrarEvento(null, "admin", `${req.usuario?.nome || "admin"} · ${slug} · ${txt}`);
  const comCliente = (fn) => async (req, res) => {
    const slug = String(req.params.slug || "");
    if (!slugValido(slug)) return res.status(404).json({ erro: "cliente não encontrado" });
    try { await fn(req, res, slug); } catch (e) { console.error("[admin]", e); res.status(500).json({ erro: e.message }); }
  };

  // ---- lista + resumo ----
  r.get("/clientes", async (req, res) => {
    if (!existsSync(BASE)) return res.status(404).json({ erro: "sem clientes aqui (rota exclusiva do interno)" });
    const conts = await statusContainers();
    const clientes = [];
    for (const slug of listarSlugs()) clientes.push(await montarCliente(slug, conts));
    const ativos = clientes.filter((c) => c.cadastro.status !== "cancelado");
    const mes = hojeSP().slice(0, 7);
    const recebidoMes = db.prepare("SELECT COALESCE(SUM(valor),0) v FROM admin_cobrancas WHERE substr(pago_em,1,7) = ?").get(mes).v;
    const atrasados = ativos.filter((c) => c.situacao.chave === "atrasado");
    const prox7 = ativos.filter((c) => c.cadastro.proxima_cobranca && difDias(c.cadastro.proxima_cobranca, hojeSP()) >= 0 && difDias(c.cadastro.proxima_cobranca, hojeSP()) <= 7);
    const arquivados = existsSync(ARQUIVO) ? readdirSync(ARQUIVO).length : 0;
    res.json({
      hoje: hojeSP(), clientes, arquivados,
      resumo: {
        total: ativos.length,
        mrr: ativos.filter((c) => c.cadastro.status !== "trial").reduce((s, c) => s + (Number(c.cadastro.valor_mensal) || 0), 0),
        recebido_mes: recebidoMes,
        a_receber_7: prox7.reduce((s, c) => s + (Number(c.cadastro.valor_mensal) || 0), 0), qtd_7: prox7.length,
        atrasados: atrasados.length, valor_atrasado: atrasados.reduce((s, c) => s + (Number(c.cadastro.valor_mensal) || 0), 0),
        leads: ativos.reduce((s, c) => s + c.metricas.leads, 0), reunioes30: ativos.reduce((s, c) => s + c.metricas.reunioes30, 0),
        alertas: ativos.reduce((s, c) => s + c.alertas.filter((a) => a.nivel === "alto").length, 0),
      },
    });
  });

  // ---- exportar CSV ----
  r.get("/clientes.csv", async (req, res) => {
    const conts = await statusContainers();
    const linhas = [["cliente", "slug", "email", "status", "plano", "valor_mensal", "inicio", "proxima_cobranca", "leads", "disparos_7d", "respostas_7d", "reunioes_30d", "whats", "ultimo_acesso", "contato", "whats_contato", "tags"]];
    for (const slug of listarSlugs()) {
      const c = await montarCliente(slug, conts);
      linhas.push([c.nome, c.slug, c.email, c.situacao.rot, c.cadastro.plano, c.cadastro.valor_mensal, c.cadastro.inicio_em, c.cadastro.proxima_cobranca,
        c.metricas.leads, c.metricas.disparos7, c.metricas.respostas7, c.metricas.reunioes30, `${c.metricas.whats_conectados}/${c.whats_limite}`,
        c.metricas.ultimo_acesso || "", c.cadastro.contato_nome || "", c.cadastro.contato_whats || "", c.cadastro.tags || ""]);
    }
    const csv = linhas.map((l) => l.map((v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }).join(";")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="clientes-prospecta-${hojeSP()}.csv"`);
    res.send("﻿" + csv);
  });

  // ---- detalhe ----
  r.get("/cliente/:slug", comCliente(async (req, res, slug) => {
    const conts = await statusContainers();
    const c = await montarCliente(slug, conts);
    const env = lerEnv(slug);
    const cofre = Object.fromEntries(db.prepare("SELECT alvo, hash, criado_em FROM admin_cofre WHERE slug = ?").all(slug).map((x) => [x.alvo, x]));
    let usuarios = [], donoHash = "";
    try {
      const cdb = abrirDb(slug);
      usuarios = cdb.prepare("SELECT id, nome, email, papel, ativo, ultimo_acesso, senha_hash FROM usuarios ORDER BY id").all();
      donoHash = cfgCliente(cdb, "painel_senha_hash") || env.pega("PAINEL_SENHA_LOGIN_HASH") || (env.pega("PAINEL_SENHA_LOGIN") ? sha(env.pega("PAINEL_SENHA_LOGIN")) : "");
      c.email = cfgCliente(cdb, "painel_email") || c.email;
      cdb.close();
    } catch { /* banco ilegivel: metricas ja avisam */ }
    const estadoCofre = (alvo, hashAtual) => !cofre[alvo] ? "sem" : cofre[alvo].hash === hashAtual ? "ok" : "trocada";
    c.dono = { email: c.email, senha: estadoCofre("dono", donoHash) };
    c.usuarios = usuarios.map(({ senha_hash, ...u }) => ({ ...u, senha: estadoCofre(`u${u.id}`, senha_hash) }));
    c.cobrancas = db.prepare("SELECT * FROM admin_cobrancas WHERE slug = ? ORDER BY pago_em DESC, id DESC LIMIT 60").all(slug);
    c.historico = db.prepare("SELECT detalhe, criado_em FROM eventos WHERE tipo = 'admin' AND detalhe LIKE ? ORDER BY id DESC LIMIT 40").all(`% · ${slug} · %`);
    res.json(c);
  }));

  // ---- editar cadastro / cobranca ----
  r.patch("/cliente/:slug", comCliente(async (req, res, slug) => {
    cadastro(slug, lerEnv(slug));
    const b = req.body || {}, sets = [], vals = [];
    const data = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null;
    const campos = {
      plano: (v) => String(v || "").slice(0, 40) || null,
      valor_mensal: (v) => Math.max(0, Math.round(Number(v) * 100) / 100 || 0),
      dia_vencimento: (v) => Math.min(31, Math.max(1, Math.round(Number(v)) || 1)),
      inicio_em: data, proxima_cobranca: data,
      status: (v) => ["ativo", "trial", "cancelado"].includes(v) ? v : "ativo",
      contato_nome: (v) => String(v || "").slice(0, 80) || null,
      contato_whats: (v) => String(v || "").replace(/[^\d+]/g, "").slice(0, 20) || null,
      observacoes: (v) => String(v || "").slice(0, 3000) || null,
      tags: (v) => String(v || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10).join(", ").slice(0, 200) || null,
    };
    for (const [k, f] of Object.entries(campos)) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(f(b[k])); }
    if (!sets.length) return res.json({ ok: true });
    db.prepare(`UPDATE admin_clientes SET ${sets.join(", ")}, atualizado_em = datetime('now') WHERE slug = ?`).run(...vals, slug);
    log(req, slug, `editou cadastro (${Object.keys(b).filter((k) => campos[k]).join(", ")})`);
    res.json({ ok: true });
  }));

  // ---- pagamentos ----
  r.post("/cliente/:slug/pagamento", comCliente(async (req, res, slug) => {
    const cad = cadastro(slug, lerEnv(slug));
    const b = req.body || {};
    const valor = Math.round(Number(b.valor ?? cad.valor_mensal) * 100) / 100;
    if (!(valor > 0)) return res.status(400).json({ erro: "valor inválido" });
    const pagoEm = /^\d{4}-\d{2}-\d{2}$/.test(String(b.pago_em || "")) ? b.pago_em : hojeSP();
    const referente = cad.proxima_cobranca || pagoEm;
    db.prepare("INSERT INTO admin_cobrancas (slug, valor, referente, pago_em, forma, obs, autor) VALUES (?,?,?,?,?,?,?)")
      .run(slug, valor, referente, pagoEm, String(b.forma || "").slice(0, 30) || null, String(b.obs || "").slice(0, 300) || null, req.usuario?.nome || null);
    // empurra o proximo vencimento 1 mes (a partir do vencimento pago, nao da data do pagamento)
    if (b.avancar !== false) db.prepare("UPDATE admin_clientes SET proxima_cobranca = ?, status = CASE WHEN status = 'trial' THEN 'ativo' ELSE status END WHERE slug = ?")
      .run(somarMeses(referente, 1, cad.dia_vencimento), slug);
    // pagou: se estava pausado por inadimplencia, volta a disparar
    let retomou = false;
    if (b.retomar !== false) {
      try {
        const cdb = abrirDb(slug, true);
        if (cfgCliente(cdb, "conta_pausada") === "1") { setCfgCliente(cdb, "conta_pausada", ""); retomou = true; }
        setCfgCliente(cdb, "assinatura_status", "ativa");
        cdb.close();
      } catch { /* sem banco: so registra o pagamento */ }
    }
    log(req, slug, `registrou pagamento de R$ ${valor.toFixed(2)} (ref. ${referente})${retomou ? " e retomou os disparos" : ""}`);
    res.json({ ok: true, retomou });
  }));
  r.delete("/cliente/:slug/pagamento/:id", comCliente(async (req, res, slug) => {
    const p = db.prepare("SELECT * FROM admin_cobrancas WHERE id = ? AND slug = ?").get(Number(req.params.id), slug);
    if (!p) return res.status(404).json({ erro: "pagamento não encontrado" });
    db.prepare("DELETE FROM admin_cobrancas WHERE id = ?").run(p.id);
    // desfaz o avanco do vencimento se ele foi o ultimo
    if (p.referente) db.prepare("UPDATE admin_clientes SET proxima_cobranca = ? WHERE slug = ?").run(p.referente, slug);
    log(req, slug, `apagou o pagamento de R$ ${Number(p.valor).toFixed(2)} (ref. ${p.referente})`);
    res.json({ ok: true });
  }));

  // ---- pausar / retomar disparos ----
  r.post("/cliente/:slug/pausar", comCliente(async (req, res, slug) => {
    const pausar = Boolean(req.body?.pausar);
    const cdb = abrirDb(slug, true);
    setCfgCliente(cdb, "conta_pausada", pausar ? "1" : "");
    setCfgCliente(cdb, "assinatura_status", pausar ? "inadimplente" : "ativa");
    cdb.close();
    log(req, slug, pausar ? "PAUSOU os disparos" : "retomou os disparos");
    res.json({ ok: true });
  }));

  // ---- usuarios do cliente ----
  const PAPEIS = ["admin", "gestor", "operador", "sdr", "closer", "leitor"];
  const gerarSenha = () => randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 10);
  r.post("/cliente/:slug/usuarios", comCliente(async (req, res, slug) => {
    const b = req.body || {};
    const nome = String(b.nome || "").trim().slice(0, 80), email = String(b.email || "").trim().toLowerCase().slice(0, 120);
    if (!nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ erro: "preencha nome e um e-mail válido" });
    const papel = PAPEIS.includes(b.papel) ? b.papel : "operador";
    const senha = String(b.senha || "").trim() || gerarSenha();
    if (senha.length < 6) return res.status(400).json({ erro: "senha com no mínimo 6 caracteres" });
    const cdb = abrirDb(slug, true);
    if (cdb.prepare("SELECT 1 FROM usuarios WHERE lower(email) = ?").get(email)) { cdb.close(); return res.status(409).json({ erro: "já existe um usuário com esse e-mail nesse cliente" }); }
    const id = cdb.prepare("INSERT INTO usuarios (nome, email, senha_hash, papel, ativo) VALUES (?,?,?,?,1)").run(nome, email, sha(senha), papel).lastInsertRowid;
    cdb.close();
    guardarNoCofre(slug, `u${id}`, email, senha);
    log(req, slug, `criou o usuário ${email} (${papel})`);
    res.json({ ok: true, id, senha });
  }));
  r.patch("/cliente/:slug/usuarios/:id", comCliente(async (req, res, slug) => {
    const id = Number(req.params.id), b = req.body || {};
    const cdb = abrirDb(slug, true);
    const u = cdb.prepare("SELECT * FROM usuarios WHERE id = ?").get(id);
    if (!u) { cdb.close(); return res.status(404).json({ erro: "usuário não encontrado" }); }
    if (b.ativo !== undefined) cdb.prepare("UPDATE usuarios SET ativo = ? WHERE id = ?").run(b.ativo ? 1 : 0, id);
    if (b.papel !== undefined && PAPEIS.includes(b.papel)) cdb.prepare("UPDATE usuarios SET papel = ? WHERE id = ?").run(b.papel, id);
    if (b.nome) cdb.prepare("UPDATE usuarios SET nome = ? WHERE id = ?").run(String(b.nome).slice(0, 80), id);
    cdb.close();
    log(req, slug, `editou o usuário ${u.email}${b.ativo !== undefined ? (b.ativo ? " (reativou)" : " (desativou)") : ""}`);
    res.json({ ok: true });
  }));
  r.delete("/cliente/:slug/usuarios/:id", comCliente(async (req, res, slug) => {
    if (!pedirSenha(req, res)) return;
    const id = Number(req.params.id);
    const cdb = abrirDb(slug, true);
    const u = cdb.prepare("SELECT email FROM usuarios WHERE id = ?").get(id);
    if (!u) { cdb.close(); return res.status(404).json({ erro: "usuário não encontrado" }); }
    // nao apaga a linha (tarefas/notas apontam pro id): desativa e libera o e-mail
    cdb.prepare("UPDATE usuarios SET ativo = 0, email = ? WHERE id = ?").run(`removido-${id}-${u.email}`, id);
    cdb.close();
    db.prepare("DELETE FROM admin_cofre WHERE slug = ? AND alvo = ?").run(slug, `u${id}`);
    log(req, slug, `removeu o usuário ${u.email}`);
    res.json({ ok: true });
  }));

  // ---- senhas: redefinir (dono ou usuario) e ver o que esta no cofre ----
  r.post("/cliente/:slug/senha", comCliente(async (req, res, slug) => {
    const alvo = String(req.body?.alvo || "");
    const senha = String(req.body?.nova || "").trim() || gerarSenha();
    if (senha.length < 6) return res.status(400).json({ erro: "senha com no mínimo 6 caracteres" });
    const cdb = abrirDb(slug, true);
    let email;
    if (alvo === "dono") {
      setCfgCliente(cdb, "painel_senha_hash", sha(senha)); // vale por cima da senha do .env
      email = cfgCliente(cdb, "painel_email") || lerEnv(slug).pega("PAINEL_EMAIL");
    } else if (/^u\d+$/.test(alvo)) {
      const u = cdb.prepare("SELECT email FROM usuarios WHERE id = ?").get(Number(alvo.slice(1)));
      if (!u) { cdb.close(); return res.status(404).json({ erro: "usuário não encontrado" }); }
      cdb.prepare("UPDATE usuarios SET senha_hash = ? WHERE id = ?").run(sha(senha), Number(alvo.slice(1)));
      email = u.email;
    } else { cdb.close(); return res.status(400).json({ erro: "alvo inválido" }); }
    cdb.close();
    guardarNoCofre(slug, alvo, email, senha);
    log(req, slug, `redefiniu a senha de ${email}`);
    res.json({ ok: true, senha, email });
  }));
  r.post("/cliente/:slug/ver-senha", comCliente(async (req, res, slug) => {
    if (!pedirSenha(req, res)) return;
    const alvo = String(req.body?.alvo || "");
    const item = db.prepare("SELECT * FROM admin_cofre WHERE slug = ? AND alvo = ?").get(slug, alvo);
    if (!item) return res.status(404).json({ erro: "essa senha não foi definida pelo Admin. Redefina para poder ver." });
    let senha;
    try { senha = decifrar(item.cifrado); } catch { return res.status(500).json({ erro: "o cofre não abriu (a chave do cofre mudou). Redefina a senha." }); }
    log(req, slug, `viu a senha de ${item.email || alvo}`);
    res.json({ ok: true, senha, email: item.email });
  }));

  // ---- entrar na conta (suporte) ----
  r.post("/entrar", async (req, res) => {
    const slug = String(req.body?.slug || "");
    if (!slugValido(slug)) return res.status(404).json({ erro: "cliente não encontrado" });
    const env = lerEnv(slug);
    const url = env.pega("APP_URL"), token = env.pega("PAINEL_SENHA");
    if (!url || !token) return res.status(500).json({ erro: "container sem APP_URL/PAINEL_SENHA" });
    log(req, slug, "entrou na conta");
    res.json({ ok: true, url, token, nome: env.pega("CLIENTE_NOME") || slug });
  });

  // ---- novo cliente (roda o deploy/novo-cliente.sh) ----
  r.post("/clientes", async (req, res) => {
    if (!pedirSenha(req, res)) return;
    const b = req.body || {};
    const slug = String(b.slug || "").trim().toLowerCase();
    const email = String(b.email || "").trim().toLowerCase();
    // nome vai pro .env do container: sem quebra de linha nem caractere de controle
    const nome = String(b.nome || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 60);
    const chave = String(b.chave_ia || "").trim();
    const whats = Math.min(20, Math.max(1, Math.round(Number(b.whats) || 1)));
    const senha = String(b.senha || "").trim() || gerarSenha();
    if (!SLUG_RE.test(slug)) return res.status(400).json({ erro: "identificador: só letras minúsculas, números e hífen (2 a 40)" });
    if (existsSync(dirCliente(slug))) return res.status(409).json({ erro: "já existe um cliente com esse identificador" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ erro: "e-mail inválido" });
    if (!nome) return res.status(400).json({ erro: "preencha o nome do cliente" });
    if (!/^sk-ant-[\w-]{20,}$/.test(chave)) return res.status(400).json({ erro: "a chave da IA começa com sk-ant- (pode trocar depois no painel do cliente)" });
    if (senha.length < 6 || /[\x00-\x1f\x7f]/.test(senha)) return res.status(400).json({ erro: "senha com no mínimo 6 caracteres, sem quebra de linha" });
    const script = join(RAIZ, "deploy", "novo-cliente.sh");
    if (!existsSync(script)) return res.status(500).json({ erro: "script de provisionamento não encontrado no servidor" });
    // argumentos separados (sem shell): nada do formulario vira comando
    const r2 = await rodar("bash", [script, slug, email, senha, chave, nome, String(whats)], 120_000);
    if (!r2.ok) return res.status(500).json({ erro: `o provisionamento falhou: ${(r2.stderr || r2.stdout).slice(-300)}` });
    const env = lerEnv(slug);
    const cad = cadastro(slug, env);
    const valor = Number(b.valor_mensal) > 0 ? Math.round(Number(b.valor_mensal) * 100) / 100 : cad.valor_mensal;
    const dia = Math.min(31, Math.max(1, Math.round(Number(b.dia_vencimento)) || cad.dia_vencimento));
    db.prepare(`UPDATE admin_clientes SET valor_mensal = ?, dia_vencimento = ?, plano = COALESCE(?, plano), status = ?,
      proxima_cobranca = ?, contato_nome = ?, contato_whats = ? WHERE slug = ?`).run(valor, dia, String(b.plano || "").slice(0, 40) || null,
      b.trial ? "trial" : "ativo", /^\d{4}-\d{2}-\d{2}$/.test(String(b.proxima_cobranca || "")) ? b.proxima_cobranca : somarMeses(hojeSP(), 1, dia),
      String(b.contato_nome || "").slice(0, 80) || null, String(b.contato_whats || "").replace(/[^\d+]/g, "").slice(0, 20) || null, slug);
    guardarNoCofre(slug, "dono", email, senha);
    log(req, slug, `CRIOU o cliente ${nome} (${email})`);
    res.json({ ok: true, slug, url: env?.pega("APP_URL") || "", email, senha });
  });

  // ---- cancelar cliente: para o container e arquiva a pasta (dados ficam) ----
  r.post("/cliente/:slug/cancelar", comCliente(async (req, res, slug) => {
    if (String(req.body?.confirmar || "") !== slug) return res.status(400).json({ erro: `digite o identificador "${slug}" para confirmar` });
    if (!pedirSenha(req, res)) return;
    const parou = await rodar("docker", ["rm", "-f", `sdr-${slug}`], 30_000);
    mkdirSync(ARQUIVO, { recursive: true });
    const destino = join(ARQUIVO, `${slug}-${hojeSP()}-${Date.now().toString(36)}`);
    renameSync(dirCliente(slug), destino);
    db.prepare("UPDATE admin_clientes SET status = 'cancelado', cancelado_em = datetime('now') WHERE slug = ?").run(slug);
    log(req, slug, `CANCELOU o cliente (container ${parou.ok ? "removido" : "não encontrado"}, dados em ${destino})`);
    res.json({ ok: true, arquivado_em: destino });
  }));

  return r;
}
