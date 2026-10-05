// Facilita SDR — servidor da VPS.
// Webhook da uazapi + API do painel (consumida pelo app na Vercel) + worker de disparo.
// REGRA DE OURO (chip proprio do Matheus): a IA SO responde telefone que existe
// na tabela leads. Qualquer outra conversa do WhatsApp dele e invisivel pro sistema.
import express from "express";
import multer from "multer";
import { execFile } from "node:child_process";
import { mkdirSync, renameSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync as fsExiste } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  db, agoraSP, getConfig, setConfig, upsertLead, getLead, getLeadPorTelefone,
  atualizarLead, salvarMensagem, historicoLead, ultimaMensagemUsuario,
  naBlocklist, bloquear, registrarEvento, webhookJaVisto, metricas,
  reunioesAtivas, reuniaoAtivaDoLead, cancelarReuniao, campanhaAtiva, disparosHoje, disparosHojeDaCampanha,
  listarInstancias, getInstancia, getInstanciaPorToken, criarInstanciaDB,
  atualizarInstancia, removerInstancia, instanciasConectadas,
  tarefasDoLead, addTarefa, marcarTarefa, atualizarTarefa, removerTarefa, setTarefaGcal, tarefasAtrasadas,
  // CRM v2
  PERMISSOES, pode, funilVisivel, listarUsuarios, getUsuario, getUsuarioPorEmail, criarUsuario,
  atualizarUsuario, marcarAcesso,
  listarPipelines, getPipeline, criarPipeline, atualizarPipeline, removerPipeline,
  followupsDaCampanha, relatorioHojeDaCampanha,
  etapasDaPipeline, addEtapa, atualizarEtapa, removerEtapa, etapaDeEntrada,
  moverLead, kanbanDaPipeline,
  telefonesDoLead, addTelefone, removerTelefone, editarTelefone, normalizarTelefone, variantesTelefone,
  threadsDoLead, getThread, threadPorTelefone, abrirThread, instanciaDoLead, fixarChipDoLead,
  audioDoLead, registrarMovimento,
} from "./lib/db.js";
import {
  parseWebhook, enviarTexto, enviarMidia, mostrarDigitando, pararDigitando, criarInstancia,
  conectarInstancia, statusInstanciaLive, statusConectado, configurarWebhook, checarWhatsapp,
  fotoPerfilWhatsapp, uazapiConfigurada,
} from "./lib/uazapi.js";
import { responderLead, horariosDisponiveis } from "./lib/agente.js";
import { transcreverAudioMensagem } from "./lib/transcrever.js";
import { alertar } from "./lib/telegram.js";
import { iniciarWorker } from "./worker.js";
import {
  iniciarMeta, configMeta, metaPronta, salvarConfigMeta, testarConexaoMeta, resumoMeta, ultimosEventosMeta,
  reenviarEvento, infoAnuncio, marcarLeadQuente, EVENTOS_META,
} from "./lib/meta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8795);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const PAINEL_SENHA = process.env.PAINEL_SENHA || "";
const DELAY_MIN = Number(process.env.DELAY_MIN || 26);
const DELAY_MAX = Number(process.env.DELAY_MAX || 34);
const DADOS_DIR = process.env.DADOS_DIR || join(__dirname, "dados");
mkdirSync(DADOS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "8mb" }));

// ASYNC-SAFE: Express 4 nao captura rejeicao de handler async — sem isso o erro
// vira 500 mudo (foi o caso do "HTTP 500" sem nada no log, 21/08). Aqui todo
// handler registrado passa a encaminhar a rejeicao pro tratador de erro.
for (const metodo of ["get", "post", "patch", "put", "delete"]) {
  const orig = app[metodo].bind(app);
  app[metodo] = (rota, ...fns) => orig(rota, ...fns.map((fn) =>
    typeof fn === "function" && fn.length <= 3
      ? function (req, res, next) { return Promise.resolve(fn(req, res, next)).catch(next); }
      : fn));
}
const upload = multer({ dest: join(DADOS_DIR, "tmp"), limits: { fileSize: 20 * 1024 * 1024 } });

// ---------- CORS (painel na Vercel consome essa API) ----------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- auth do painel ----------
// Login email+senha (POST /api/login) troca por um token de sessao (o PAINEL_SENHA
// interno, que continua forte). Freio: 8 tentativas erradas por IP a cada 15min.
import { createHash, randomBytes } from "node:crypto";
// Benchmarks de Mercado (funil de prospecção). Arquivo separado pra ajustar sem
// mexer no código. Na UI aparece só como "Benchmarks de Mercado".
const BENCH = JSON.parse(readFileSync(join(__dirname, "db", "benchmarks.json"), "utf8"));
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const tentativas = new Map(); // ip -> { n, ate }

// TRAVA DE CHIP: conversa que corre pelo WhatsApp de UMA pessoa so pode ser
// respondida por ela (Matheus nao manda pelo chip do Valentino e vice-versa).
// Chip "da empresa" (sem dono) e liberado pra todos.
function chipBloqueado(inst, usuario) {
  if (!inst?.usuario_id || !usuario?.id) return null;
  if (inst.usuario_id === usuario.id) return null;
  const dono = getUsuario(inst.usuario_id)?.nome || "outra pessoa";
  return `essa conversa corre pelo WhatsApp de ${dono} — só ${dono} pode responder por aqui`;
}

// SESSOES por usuario: cada login ganha um token proprio, que aponta pro usuario.
// O PAINEL_SENHA continua valendo como token de admin (compatibilidade: nao quebra
// o login atual do Matheus nem os containers ja provisionados).
const sessoes = new Map(); // token -> { usuarioId, criado }
const novaSessao = (usuarioId) => {
  const token = randomBytes(24).toString("hex");
  sessoes.set(token, { usuarioId, criado: Date.now() });
  return token;
};

// rotas de NAVEGACAO (link/target _blank nao manda header): validam ?t= na mao.
// Aceita a senha mestre E sessao de usuario — sem isso o Valentino (login proprio)
// tomava 401 em conectar agenda / exportar / ouvir audio.
const tokenQueryValido = (t) => Boolean(t) && (t === PAINEL_SENHA || sessoes.has(String(t)));

const NOME_DONO = String(process.env.CLIENTE_NOME || "").trim() || "Administrador";
function auth(req, res, next) {
  if (!PAINEL_SENHA) return res.status(500).json({ erro: "PAINEL_SENHA nao configurada" });
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token === PAINEL_SENHA) {
    // token mestre = admin (o dono da instalacao)
    req.usuario = db.prepare("SELECT * FROM usuarios WHERE papel = 'admin' ORDER BY id LIMIT 1").get()
      || { id: 0, nome: NOME_DONO, papel: "admin", email: getConfig("painel_email", "") };
    return next();
  }
  const s = sessoes.get(token);
  if (!s) return res.status(401).json({ erro: "sessao invalida" });
  const u = getUsuario(s.usuarioId);
  if (!u || !u.ativo) { sessoes.delete(token); return res.status(401).json({ erro: "usuario inativo" }); }
  req.usuario = u;
  next();
}

// gate de permissao: use `exige("editar_pipeline")` depois do auth
const exige = (acao) => (req, res, next) =>
  pode(req.usuario, acao) ? next() : res.status(403).json({ erro: "sem permissão pra isso" });

app.post("/api/login", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  const t = tentativas.get(ip) || { n: 0, ate: 0 };
  if (t.n >= 8 && Date.now() < t.ate) return res.status(429).json({ erro: "muitas tentativas, espera uns minutos" });
  const { email, senha } = req.body || {};
  // login vem do banco (setado via node/setConfig) OU, em container de cliente
  // provisionado, das envs PAINEL_EMAIL / PAINEL_SENHA_LOGIN (fallback só quando
  // o banco não tem credencial — o login do Matheus na VPS não muda em nada)
  const emailCfg = getConfig("painel_email", "") || String(process.env.PAINEL_EMAIL || "").trim().toLowerCase();
  const hashCfg = getConfig("painel_senha_hash", "");
  const emailOk = String(email || "").trim().toLowerCase() === emailCfg && Boolean(emailCfg);
  const senhaOk = hashCfg
    ? sha(senha || "") === hashCfg
    : process.env.PAINEL_SENHA_LOGIN_HASH
      ? sha(senha || "") === process.env.PAINEL_SENHA_LOGIN_HASH
      : (process.env.PAINEL_SENHA_LOGIN ? String(senha || "") === process.env.PAINEL_SENHA_LOGIN : false);
  // 1) login do DONO (config/env): continua valendo e devolve o token mestre
  if (emailOk && senhaOk) {
    tentativas.delete(ip);
    const dono = getUsuarioPorEmail(email);
    if (dono) marcarAcesso(dono.id);
    return res.json({ ok: true, token: PAINEL_SENHA, usuario: dono ? { nome: dono.nome, papel: dono.papel } : { nome: NOME_DONO, papel: "admin" } });
  }
  // 2) login de USUARIO da equipe (funcionarios do cliente, com papel/permissao)
  const u = getUsuarioPorEmail(email);
  if (u && u.senha_hash === sha(senha || "")) {
    tentativas.delete(ip);
    marcarAcesso(u.id);
    return res.json({ ok: true, token: novaSessao(u.id), usuario: { nome: u.nome, papel: u.papel } });
  }
  tentativas.set(ip, { n: t.n + 1, ate: Date.now() + 15 * 60_000 });
  return res.status(401).json({ erro: "email ou senha errados" });
});

// quem sou eu (o painel usa pra esconder o que o papel nao pode)
app.get("/api/eu", auth, (req, res) => {
  const u = req.usuario;
  res.json({ id: u.id, nome: u.nome, email: u.email, papel: u.papel, permissoes: PERMISSOES[u.papel] || [] });
});

// trocar a propria senha (dono via token mestre OU usuario da equipe).
// No dono, grava painel_senha_hash no banco — a partir dai a env
// PAINEL_SENHA_LOGIN(_HASH) do provisionamento deixa de valer (fallback so sem banco).
// CONFIRMAR COM A PROPRIA SENHA antes de ligar algo sensivel (sincronizar
// mensagens de contatos novos, mandar dados de lead pra Meta). Mesma regra do
// login: dono confere a senha do painel, usuario da equipe confere a dele.
// 5 erros em 15 min bloqueiam a confirmacao por 15 min.
const errosSenha = new Map();
function senhaConfere(req, senha) {
  const chave = String(req.usuario?.id ?? "dono");
  const reg = errosSenha.get(chave);
  if (reg && reg.n >= 5 && Date.now() - reg.desde < 15 * 60_000) return { ok: false, erro: "muitas tentativas erradas. Espere 15 minutos." };
  const s = String(senha || "");
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  let ok = false;
  if (s) {
    if (token === PAINEL_SENHA) {
      const hashCfg = getConfig("painel_senha_hash", "");
      ok = hashCfg ? sha(s) === hashCfg
        : process.env.PAINEL_SENHA_LOGIN_HASH ? sha(s) === process.env.PAINEL_SENHA_LOGIN_HASH
        : (process.env.PAINEL_SENHA_LOGIN ? s === process.env.PAINEL_SENHA_LOGIN : false);
    }
    // usuario da equipe (ou o admin que o acesso do dono representa): a senha dele
    if (!ok && req.usuario?.id) ok = db.prepare("SELECT senha_hash FROM usuarios WHERE id = ?").get(req.usuario.id)?.senha_hash === sha(s);
  }
  if (ok) { errosSenha.delete(chave); return { ok: true }; }
  const novo = reg && Date.now() - reg.desde < 15 * 60_000 ? { n: reg.n + 1, desde: reg.desde } : { n: 1, desde: Date.now() };
  errosSenha.set(chave, novo);
  return { ok: false, erro: s ? "senha errada" : "confirme com a sua senha" };
}

app.post("/api/senha", auth, (req, res) => {
  const { senha_atual, senha_nova } = req.body || {};
  if (String(senha_nova || "").length < 6) return res.status(422).json({ erro: "senha nova muito curta (mínimo 6 caracteres)" });
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token === PAINEL_SENHA) {
    const hashCfg = getConfig("painel_senha_hash", "");
    const atualOk = hashCfg
      ? sha(senha_atual || "") === hashCfg
      : process.env.PAINEL_SENHA_LOGIN_HASH
        ? sha(senha_atual || "") === process.env.PAINEL_SENHA_LOGIN_HASH
        : (process.env.PAINEL_SENHA_LOGIN ? String(senha_atual || "") === process.env.PAINEL_SENHA_LOGIN : false);
    if (!atualOk) return res.status(401).json({ erro: "senha atual errada" });
    setConfig("painel_senha_hash", sha(senha_nova));
    registrarEvento(null, "senha", "senha do painel trocada pelo dono");
    return res.json({ ok: true });
  }
  const u = req.usuario;
  const linha = u?.id ? db.prepare("SELECT senha_hash FROM usuarios WHERE id = ?").get(u.id) : null;
  if (!linha || linha.senha_hash !== sha(senha_atual || "")) return res.status(401).json({ erro: "senha atual errada" });
  db.prepare("UPDATE usuarios SET senha_hash = ? WHERE id = ?").run(sha(senha_nova), u.id);
  res.json({ ok: true });
});

// ============================================================
// WEBHOOK uazapi
// ============================================================
const OPTOUT_FORTE = /\b(par[ae] de (me )?(mandar|enviar)|remove\w* meu (numero|número|contato)|descadastr|me tir[ae] d)\b/i;
// RECUSA (nao e opt-out): move pra PERDIDO, porta aberta, sem bloquear o numero.
// Cobre: sem interesse, ja tem, nao e o momento, e "a empresa nao e mais alvo"
// (vendendo/fechando/encerrando o negocio).
const RECUSA = /\b(n[aã]o (tenho|temos|há|ha|tem) interesse|n[aã]o (quero|queremos|precisamos|preciso)|sem interesse|n[aã]o obrigad|j[aá] (tenho|temos|uso|usamos|trabalho|trabalhamos)|n[aã]o (é|e) (o )?momento|agora n[aã]o|(estou|estamos|vou|vamos) (vend|fech|encerr|desativ)\w*|(clínica|clinica|empresa|negócio|negocio) (foi )?(vendid|fechad|encerrad)\w*|n[aã]o (atuo|atuamos|trabalho) mais)\b/i;
const debounces = new Map(); // leadId -> { msgId, timer }
const processando = new Set(); // lock por lead

app.post("/webhook", async (req, res) => {
  res.json({ ok: true }); // responde ja (uazapi reenvia sem 200 rapido)
  try {
    if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) { console.log("[webhook] secret errado"); return; }
    const m = parseWebhook(req.body);
    console.log("[webhook]", m ? `${m.telefone} fromMe=${m.fromMe} tipo=${m.tipo} "${(m.texto || "").slice(0, 40)}"` : "payload nao parseado");
    if (!m || m.ehGrupo || m.tipo === "figurinha") return;
    if (webhookJaVisto(m.messageId)) return;

    // qual CHIP recebeu essa mensagem (decide pra qual conversa ela vai)
    const instChegada = getInstanciaPorToken(req.body?.token || req.body?.instance || null) || null;

    let lead = getLeadPorTelefone(m.telefone);
    // ANUNCIO DA META (clique pro WhatsApp): quem ja e lead vira "quente"; numero
    // novo vira lead quente no funil escolhido em Integracoes > Meta Ads. Mensagem
    // que NAO vem de anuncio segue a regra de sempre (nao-lead e ignorado).
    // RECEBER CONTATOS NOVOS (Integracoes > WhatsApp, por numero): quem chama
    // primeiro nesse chip vira lead quente no funil escolhido. Desligado (padrao)
    // = regra antiga, porque varios chips sao o numero pessoal da equipe.
    const anuncio = !m.fromMe ? infoAnuncio(req.body) : null;
    if (anuncio && lead) marcarLeadQuente(lead.id, anuncio);
    else if (!lead && !m.fromMe && !threadPorTelefone(m.telefone, instChegada?.id || null)) {
      if (anuncio) lead = criarLeadDeAnuncio(m.telefone, anuncio, req.body, instChegada);
      if (!lead && instChegada?.receber_novos) lead = criarLeadDeEntrada(m.telefone, req.body, instChegada, anuncio);
    }
    // THREAD paralela (decisor): o numero nao e o principal de nenhum lead, mas
    // pertence a uma conversa aberta dentro de um card. Sem isso a resposta do
    // decisor era DESCARTADA como "nao e lead" e nunca chegava no painel.
    let threadParalela = null;
    if (!lead) {
      threadParalela = threadPorTelefone(m.telefone, instChegada?.id || null);
      if (threadParalela) {
        lead = getLead(threadParalela.lead_id);
        // se a thread achada e a principal do lead (mesmo numero), trata como conversa normal
        if (lead && variantesTelefone(lead.telefone).includes(threadParalela.telefone)) threadParalela = null;
      }
      if (!lead) return; // chip proprio: conversa que nao e lead NAO EXISTE pra gente
    } else if (instChegada && lead.instancia_id && instChegada.id !== lead.instancia_id) {
      // a mensagem chegou num chip DIFERENTE do da conversa principal: se o outro
      // socio abriu conversa com essa empresa pelo numero DELE, a mensagem e da
      // thread dele — nunca da conversa principal (cada papo fica no seu numero)
      const tOutroChip = threadPorTelefone(m.telefone, instChegada.id);
      if (tOutroChip && tOutroChip.lead_id === lead.id && tOutroChip.instancia_id === instChegada.id)
        threadParalela = tOutroChip;
    }

    // AUDIO DO LEAD: baixa e transcreve no whisper local pra IA entender e responder.
    // Falhou (servico fora, download quebrou)? m.texto fica vazio e vale o fallback
    // de sempre ("pede com jeito pra pessoa escrever").
    if (m.tipo === "audio" && !m.fromMe && !m.texto) {
      const tokMidia = getInstanciaPorToken(req.body?.token || req.body?.instance || null)?.uazapi_token
        || instanciaDoLead(lead)?.uazapi_token || null;
      const transcricao = await transcreverAudioMensagem(tokMidia, m).catch(() => null);
      if (transcricao) {
        m.texto = `🎤 ${transcricao}`;
        registrarEvento(lead.id, "audio_transcrito", transcricao.slice(0, 100));
      }
    }

    if (threadParalela) {
      // conversa direta com o DECISOR: entra no card e a IA DA SEGUIMENTO
      // (mesma persona, mesmo chip). Humano assume igual a conversa principal.
      if (m.fromMe && m.enviadaPelaApi) return; // eco do proprio envio
      const textoTh = m.texto || (m.tipo === "audio" ? "[áudio]" : "[mídia]");
      const rIns = salvarMensagem(lead.id, m.fromMe ? "assistant" : "user", textoTh, m.tipo);
      db.prepare("UPDATE mensagens SET thread_id = ? WHERE id = ?").run(threadParalela.id, rIns.lastInsertRowid);
      if (m.fromMe) {
        // dono respondeu pelo celular: humano assumiu ESTA thread
        if (!threadParalela.ia_pausada) db.prepare("UPDATE threads SET ia_pausada = 1 WHERE id = ?").run(threadParalela.id);
        // MATA a resposta que a IA ja tinha agendado (debounce de ~30s): sem isso
        // ela soltava a mensagem por cima mesmo com o botao ja desativado
        const chaveTh = `th${threadParalela.id}`;
        const pend = debounces.get(chaveTh);
        if (pend) { clearTimeout(pend.timer); debounces.delete(chaveTh); }
        return;
      }
      db.prepare("UPDATE threads SET nao_lida = 1 WHERE id = ?").run(threadParalela.id);
      registrarEvento(lead.id, "resposta", `decisor respondeu (${threadParalela.rotulo || threadParalela.telefone})`);
      // IA segue a conversa com o decisor (salvo se pausada nesta thread ou no lead)
      if (!threadParalela.ia_pausada && !lead.ia_pausada) {
        const tokPayloadTh = req.body?.token || req.body?.instance || null;
        const tokTh = getInstanciaPorToken(tokPayloadTh)?.uazapi_token
          || instanciaDoLead(lead, threadParalela.instancia_id)?.uazapi_token || null;
        if (tokTh) {
          // mesmo debounce humanizado da conversa principal (chave propria da thread)
          const chave = `th${threadParalela.id}`;
          const msgIdRef = rIns.lastInsertRowid;
          const alvoMs = (DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000;
          const antigo = debounces.get(chave);
          if (antigo) { clearTimeout(antigo.timer); clearInterval(antigo.digitando); }
          const digitando = setInterval(() => mostrarDigitando(tokTh, m.telefone), 7000);
          mostrarDigitando(tokTh, m.telefone);
          const timer = setTimeout(async () => {
            clearInterval(digitando);
            debounces.delete(chave);
            const maisNova = db.prepare("SELECT id FROM mensagens WHERE thread_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(threadParalela.id);
            if (maisNova?.id !== msgIdRef) return; // chegou msg mais nova na thread
            if (processando.has(chave)) return;
            processando.add(chave);
            try {
              await responderLead(lead.id, tokTh, { threadId: threadParalela.id });
            } finally {
              processando.delete(chave);
              pararDigitando(tokTh, m.telefone); // respondeu (ou nao): para de "digitar"
            }
          }, alvoMs);
          debounces.set(chave, { msgId: msgIdRef, timer, digitando });
        }
      }
      return;
    }

    // MULTI-WHATSAPP: responde pelo MESMO numero que recebeu (token no payload).
    // Sem token no payload, usa o CHIP GRAVADO do lead — nunca "o primeiro da
    // lista" (isso fazia a conversa trocar de numero com 2+ chips = risco de ban).
    const tokenPayload = req.body?.token || req.body?.instance || null;
    const instRecebeu = getInstanciaPorToken(tokenPayload) || instanciaDoLead(lead) || null;
    const tokenResposta = instRecebeu?.uazapi_token || getConfig("instancia_token", "");
    if (instRecebeu) fixarChipDoLead(lead.id, instRecebeu.id); // cola a conversa neste chip

    // eco da propria IA (mensagem que NOS enviamos volta como fromMe) -> ignora
    if (m.fromMe && m.enviadaPelaApi) return;

    // Matheus respondeu esse lead pelo celular -> humano assumiu, IA pausa
    if (m.fromMe) {
      if (m.texto) salvarMensagem(lead.id, "assistant", m.texto);
      if (!lead.ia_pausada) {
        atualizarLead(lead.id, { ia_pausada: 1 });
        registrarEvento(lead.id, "handoff", "atendente respondeu pelo celular");
      }
      // cancela a resposta ja agendada (debounce) — o humano falou primeiro
      const pend = debounces.get(lead.id);
      if (pend) { clearTimeout(pend.timer); debounces.delete(lead.id); }
      return;
    }

    if (naBlocklist(m.telefone)) return;

    // mensagem do lead
    const texto = m.texto || (m.tipo === "audio" ? "[o lead enviou um áudio que você não consegue ouvir; peça com jeito pra pessoa escrever]" : "[o lead enviou uma mídia que você não consegue abrir]");
    salvarMensagem(lead.id, "user", texto, m.tipo);

    // primeira resposta do lead = evento de funil + status
    if (lead.status === "disparado" || lead.status === "novo") {
      atualizarLead(lead.id, { status: "respondeu" });
      registrarEvento(lead.id, "resposta", "");
    }

    // opt-out mecanico (rede de seguranca alem do agente): bloqueia o numero
    if (OPTOUT_FORTE.test(m.texto || "")) {
      bloquear(lead.telefone, `pediu: "${m.texto.slice(0, 80)}"`); // forma SALVA do numero (casa com o disparo)
      atualizarLead(lead.id, { status: "optout", ia_pausada: 1 });
      registrarEvento(lead.id, "optout", "mecanico");
      const desc = "Tranquilo, não te mando mais nada. Obrigado pelo retorno!";
      const r = await enviarTexto(tokenResposta, m.telefone, desc);
      if (r.ok) salvarMensagem(lead.id, "assistant", desc);
      return;
    }

    // RECUSA clara ("não tenho interesse"): move pra PERDIDO na hora, uma resposta
    // educada de porta aberta, e a IA para (nao fica insistindo). Nao bloqueia.
    // recusa_mecanica: "1" = corta na regex e manda despedida (padrao do interno);
    // "0" = deixa pra IA quebrar a objecao (padrao dos clientes — o cerebro deles
    // costuma mandar NAO aceitar a primeira recusa, e a regex passava por cima)
    const recusaMecanica = getConfig("recusa_mecanica", MODO_IA === "api" ? "0" : "1") === "1";
    if (recusaMecanica && RECUSA.test(m.texto || "")) {
      // A recusa da RECEPCAO nao mata o lead quando ja existe conversa aberta com
      // o DECISOR: quem decide e ele. Nesse caso so encerra o canal da empresa e
      // a IA segue com o decisor na thread dele (caso Kewvy/Recupera+, 20/08).
      const decisorAtivo = db.prepare(`SELECT COUNT(*) c FROM threads t
        WHERE t.lead_id = ? AND t.telefone <> ? AND t.ia_pausada = 0
          AND EXISTS (SELECT 1 FROM mensagens m2 WHERE m2.thread_id = t.id AND m2.role = 'user')`)
        .get(lead.id, lead.telefone).c > 0;
      const desc = "Tranquilo! Qualquer coisa no futuro, é só chamar. Abraço!";
      const r = await enviarTexto(tokenResposta, m.telefone, desc);
      if (r.ok) salvarMensagem(lead.id, "assistant", desc);
      if (decisorAtivo) {
        registrarEvento(lead.id, "recusa_recepcao", "recepção recusou, mas o decisor está em conversa — lead segue vivo");
      } else {
        atualizarLead(lead.id, { status: "perdido", ia_pausada: 1, motivo_perda: `recusou: "${m.texto.slice(0, 60)}"` });
        registrarEvento(lead.id, "perdido", "recusa mecanica");
      }
      return;
    }

    if (lead.ia_pausada) return; // humano no comando

    // DEBOUNCE humanizado: espera ~30s desde a ULTIMA mensagem, com "digitando",
    // e so o handler da ultima mensagem responde (rajada = 1 resposta com contexto todo)
    const msgIdRef = ultimaMensagemUsuario(lead.id);
    const alvoMs = (DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)) * 1000;
    const antigo = debounces.get(lead.id);
    if (antigo) { clearTimeout(antigo.timer); clearInterval(antigo.digitando); }

    const digitando = setInterval(() => mostrarDigitando(tokenResposta, m.telefone), 7000);
    mostrarDigitando(tokenResposta, m.telefone);

    const timer = setTimeout(async () => {
      clearInterval(digitando);
      debounces.delete(lead.id);
      if (ultimaMensagemUsuario(lead.id) !== msgIdRef) return; // chegou msg mais nova
      if (processando.has(lead.id)) return;
      processando.add(lead.id);
      try {
        await responderLead(lead.id, tokenResposta);
      } finally {
        processando.delete(lead.id);
        pararDigitando(tokenResposta, m.telefone); // respondeu (ou nao): para de "digitar"
      }
    }, alvoMs);
    debounces.set(lead.id, { msgId: msgIdRef, timer, digitando });
  } catch (e) {
    console.error("[webhook] erro:", e);
  }
});

// ============================================================
// API do painel
// ============================================================
app.get("/api/estado", auth, (req, res) => {
  res.json({
    metricas: metricas(),
    instancia: (() => {
      const insts = listarInstancias();
      const con = insts.filter((i) => i.status === "conectado").length;
      return { status: con > 0 ? "conectado" : (insts.length ? "desconectado" : "sem instância"),
               detalhe: `${con}/${insts.length}`, total: insts.length, conectadas: con };
    })(),
    campanha: campanhaAtiva() || null,
    audio_configurado: Boolean(getConfig("audio_oficial")),
    horarios: horariosDisponiveis(),
    agora: agoraSP(),
  });
});

app.get("/api/leads", auth, (req, res) => {
  const { status, busca, incluir_teste } = req.query;
  let sql = "SELECT * FROM leads", cond = [], vals = [];
  if (!incluir_teste) cond.push("eh_teste = 0"); // pipeline/conversas escondem testes
  if (status) { cond.push("status = ?"); vals.push(status); }
  if (busca) { cond.push("(nome_clinica LIKE ? OR telefone LIKE ? OR cidade LIKE ?)"); vals.push(`%${busca}%`, `%${busca}%`, `%${busca}%`); }
  if (cond.length) sql += " WHERE " + cond.join(" AND ");
  // ordena por movimentação recente; limite alto o bastante pra não cortar
  // conversa antiga da lista (o Kanban tem paginação própria por etapa)
  sql += " ORDER BY atualizado_em DESC LIMIT " + (Number(req.query.limite) || 5000);
  const leads = db.prepare(sql).all(...vals);
  // anexa a ULTIMA mensagem de cada lead (pra preview no card do pipeline)
  const ultima = db.prepare("SELECT role, texto, criado_em FROM mensagens WHERE lead_id = ? ORDER BY id DESC LIMIT 1");
  const contNotas = db.prepare("SELECT COUNT(*) c FROM notas WHERE lead_id = ?");
  const tarefaAberta = db.prepare("SELECT texto, quando FROM tarefas WHERE lead_id = ? AND feita = 0 ORDER BY COALESCE(quando,'9999') ASC, id ASC LIMIT 1");
  const contThreadNaoLida = db.prepare("SELECT COUNT(*) c FROM threads WHERE lead_id = ? AND nao_lida = 1");
  const reengHoras = Number(getConfig("reengajar_horas", "20"));
  const engajados = ["respondeu", "em_conversa"]; // só quem está em conversa (decisor já avançou)
  for (const l of leads) {
    const u = ultima.get(l.id);
    l.ultima_role = u?.role || null;
    // PRECISA DE MIM (negrito na lista): o lead falou por último e a IA não vai
    // responder — ou porque um humano assumiu, ou porque a IA foi pausada, ou
    // porque a resposta chegou numa thread paralela (decisor), que é sempre humana.
    // Se a IA está tocando a conversa, fica normal (não é problema meu).
    l.precisa_resposta = !!(u?.role === "user" && l.ia_pausada) || contThreadNaoLida.get(l.id).c > 0;
    l.ultima_msg = u?.texto ? String(u.texto).slice(0, 120) : null; // preview curto (a lista so mostra 90)
    l.ultima_msg_em = u?.criado_em || null; // pra lista de Conversas separar "cobrados hoje"
    l.qtd_notas = contNotas.get(l.id).c;
    // TAREFA (só pra lead que ENGAJOU; follow-up frio de quem nunca respondeu está desligado):
    // 0) MINHA tarefa manual (ligar pro decisor etc) — vence as automáticas no card
    // 1) follow-up de intermediário agendado pela IA (followup_em)
    // 2) lead quente que ESFRIOU: respondeu, última msg foi nossa, e sumiu -> IA vai reengajar
    const tm = tarefaAberta.get(l.id);
    if (tm) {
      l.tem_tarefa = true; l.tarefa_tipo = "manual";
      l.tarefa_texto = tm.texto; l.tarefa_quando = tm.quando || null;
    } else if (l.followup_em && !l.ia_pausada) {
      l.tem_tarefa = true; l.tarefa_quando = l.followup_em.slice(0, 16); l.tarefa_tipo = "retorno";
    } else if (!l.ia_pausada && !l.reengajado_em && engajados.includes(l.status) && u?.role === "assistant" && !l.telefone_decisor) {
      const horasParado = u.criado_em ? (Date.now() - new Date(u.criado_em + "Z").getTime()) / 3600000 : 0;
      if (horasParado >= reengHoras - 4) { // aparece um pouco antes de disparar
        l.tem_tarefa = true; l.tarefa_tipo = "reengajar"; l.tarefa_quando = null;
        l.horas_parado = Math.round(horasParado);
      } else l.tem_tarefa = false;
    } else l.tem_tarefa = false;
  }
  res.json(leads);
});

app.get("/api/lead/:id", auth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "lead nao existe" });
  const notas = db.prepare(`SELECT n.*, u.nome usuario_nome FROM notas n LEFT JOIN usuarios u ON u.id = n.usuario_id
    WHERE n.lead_id = ? ORDER BY n.id DESC`).all(lead.id);
  const tarefas = tarefasDoLead(lead.id);
  const threadId = req.query.thread ? Number(req.query.thread) : null;
  let mensagens;
  if (threadId) {
    const th = getThread(threadId);
    // thread PRINCIPAL (numero da empresa): inclui tambem as mensagens sem
    // thread_id — a IA e o webhook gravam na conversa principal sem marcar.
    const ehPrincipal = th && variantesTelefone(lead.telefone).includes(th.telefone);
    mensagens = ehPrincipal
      ? db.prepare("SELECT * FROM mensagens WHERE lead_id = ? AND (thread_id = ? OR thread_id IS NULL) ORDER BY id LIMIT 200").all(lead.id, threadId)
      : db.prepare("SELECT * FROM mensagens WHERE lead_id = ? AND thread_id = ? ORDER BY id LIMIT 200").all(lead.id, threadId);
    db.prepare("UPDATE threads SET nao_lida = 0 WHERE id = ?").run(threadId); // abriu = leu
  } else {
    mensagens = historicoLead(lead.id, 200);
  }
  // ultimo resultado de ligacao registrado (pro botao clicado ficar marcado)
  const ultLig = db.prepare("SELECT detalhe FROM eventos WHERE lead_id = ? AND tipo = 'ligacao' ORDER BY id DESC LIMIT 1").get(lead.id);
  // por qual NUMERO essa conversa sai (chip da thread aberta ou do lead)
  const instConv = instanciaDoLead(lead, threadId ? getThread(threadId)?.instancia_id || null : null);
  // a IA esta preparando resposta AGORA? (debounce ou claude rodando) — vira os
  // "3 pontinhos" no painel, so pra quem olha (nada vai pro WhatsApp por isso)
  const chaveTh = threadId ? `th${threadId}` : null;
  const iaDigitando = debounces.has(lead.id) || processando.has(lead.id)
    || (chaveTh ? debounces.has(chaveTh) || processando.has(chaveTh) : false);
  res.json({
    lead, mensagens, reuniao: reuniaoAtivaDoLead(lead.id) || null, notas, tarefas,
    chip: instConv ? { nome: instConv.nome, numero: instConv.numero } : null,
    ia_digitando: iaDigitando,
    resumo: lead.resumo || null,
    ultima_ligacao: ultLig ? ultLig.detalhe.split(" · ")[0] : null,
    telefones: telefonesDoLead(lead.id),
    threads: threadsDoLead(lead.id),
    // pra trocar etapa/pipeline direto do painel de notas
    pipelines: listarPipelines().filter((p) => funilVisivel(req.usuario, p.tipo))
      .map((p) => ({ id: p.id, nome: p.nome, tipo: p.tipo, etapas: etapasDaPipeline(p.id) })),
    usuarios: listarUsuarios().filter((u) => u.ativo),
  });
});

// resumo por IA (cacheado; regenera so se a conversa andou) — chamado sob demanda
app.get("/api/lead/:id/resumo", auth, async (req, res) => {
  try {
    const { resumoDaConversa } = await import("./lib/agente.js");
    res.json({ resumo: await resumoDaConversa(Number(req.params.id)) });
  } catch (e) { res.json({ resumo: null }); }
});

app.patch("/api/lead/:id", auth, (req, res) => {
  const campos = req.body || {};
  const antes = getLead(req.params.id);
  if (!antes) return res.status(404).json({ erro: "lead nao existe" });
  atualizarLead(req.params.id, campos);
  const depois = getLead(req.params.id);
  // CONFIRMA que gravou: campo fora da whitelist sumia em silencio e a pessoa
  // achava que tinha salvado. Agora o painel recebe o erro e avisa.
  const ignorados = Object.keys(campos).filter((k) => {
    const novo = campos[k] === "" ? null : campos[k];
    return String(depois[k] ?? "") !== String(novo ?? "");
  });
  if (ignorados.length) return res.status(400).json({ erro: `campo(s) não salvos: ${ignorados.join(", ")}`, lead: depois });
  res.json({ ok: true, lead: depois });
});

app.delete("/api/lead/:id", auth, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "lead nao existe" });
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM mensagens WHERE lead_id = ?").run(lead.id);
    db.prepare("DELETE FROM reunioes WHERE lead_id = ?").run(lead.id);
    db.prepare("DELETE FROM eventos WHERE lead_id = ?").run(lead.id);
    db.prepare("DELETE FROM campanha_leads WHERE lead_id = ?").run(lead.id);
    db.prepare("DELETE FROM threads WHERE lead_id = ?").run(lead.id); // cascata: sem isso a thread ficava orfa
    db.prepare("DELETE FROM leads WHERE id = ?").run(lead.id);
  });
  tx();
  res.json({ ok: true });
});

// FOLLOW MANUAL: o botao "follow N" do card. Cada clique conta um follow feito
// por telefone/humano, registra evento e nota, e avanca o contador da regua.
const RESULTADOS_LIGACAO = ["nao_atendeu", "conectou", "decisor", "reuniao", "recusou"];
app.post("/api/lead/:id/follow", auth, exige("conversar"), (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "lead nao existe" });
  const obs = String(req.body?.obs || "").trim();
  const n = (lead.follows_feitos || 0) + 1;
  // resultado do follow: conta no funil de ligacoes do dashboard igual aos
  // botoes de Registrar Ligacao (o dashboard le eventos tipo 'ligacao' e
  // classifica pelo prefixo do detalhe)
  const resultado = RESULTADOS_LIGACAO.includes(req.body?.resultado) ? req.body.resultado : "nao_atendeu";
  db.prepare("UPDATE leads SET follows_feitos = ?, ultimo_follow_em = datetime('now') WHERE id = ?").run(n, lead.id);
  registrarEvento(lead.id, "ligacao", `${resultado} · follow ${n}${obs ? " · " + obs : ""}`);
  db.prepare("INSERT INTO notas (lead_id, texto, usuario_id) VALUES (?,?,?)")
    .run(lead.id, `Follow ${n} feito${obs ? ": " + obs : ""}`, req.usuario?.id || null);
  res.json({ ok: true, follows: n, resultado });
});

// exclusao em massa por SELECAO (checkboxes do Kanban): apaga os leads e tudo
// que pendura neles — mensagens, threads, telefones, notas, tarefas, eventos
app.post("/api/leads/excluir", auth, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ erro: "nenhum lead selecionado" });
  if (ids.length > 500) return res.status(400).json({ erro: "máximo 500 por vez" });
  const tx = db.transaction(() => {
    for (const id of ids) {
      for (const t of ["mensagens", "reunioes", "eventos", "campanha_leads", "threads", "telefones", "notas", "tarefas"])
        db.prepare(`DELETE FROM ${t} WHERE lead_id = ?`).run(id);
      db.prepare("DELETE FROM threads WHERE lead_id = ?").run(id); // cascata: sem isso a thread ficava orfa
      db.prepare("DELETE FROM leads WHERE id = ?").run(id);
    }
  });
  tx();
  console.log(`[leads] exclusao em massa: ${ids.length} leads (${req.usuario?.nome || "?"})`);
  res.json({ ok: true, excluidos: ids.length });
});

// exclusao em massa (todos de um status, ex: limpar "Sem WhatsApp")
app.post("/api/leads/excluir-status", auth, (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ erro: "status obrigatorio" });
  const ids = db.prepare("SELECT id FROM leads WHERE status = ?").all(status).map((r) => r.id);
  const tx = db.transaction(() => {
    for (const id of ids) {
      db.prepare("DELETE FROM mensagens WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM reunioes WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM eventos WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM campanha_leads WHERE lead_id = ?").run(id);
      db.prepare("DELETE FROM threads WHERE lead_id = ?").run(id); // cascata: sem isso a thread ficava orfa
      db.prepare("DELETE FROM leads WHERE id = ?").run(id);
    }
  });
  tx();
  res.json({ ok: true, excluidos: ids.length });
});

// atendente responde pela tela (IA pausa sozinha)
app.post("/api/lead/:id/mensagem", auth, async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "lead nao existe" });
  const texto = String(req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ erro: "texto vazio" });
  // THREAD paralela (decisor): a mensagem sai pro TELEFONE DA THREAD, nao pro
  // principal — senao "conversar com o decisor" mandaria tudo pra recepcao.
  let thread = null;
  if (req.body?.thread_id) {
    thread = getThread(Number(req.body.thread_id));
    if (!thread || thread.lead_id !== lead.id) return res.status(400).json({ erro: "thread não é desse lead" });
  }
  const alvo = thread?.telefone || lead.telefone;
  const simulado = String(alvo).startsWith("0000");
  // sai pelo chip DESTE lead (continuidade da conversa) e respeita o dono
  const inst = instanciaDoLead(lead, thread?.instancia_id || null);
  if (!inst && !simulado) return res.status(502).json({ erro: "nenhum WhatsApp conectado" });
  const trava = chipBloqueado(inst, req.usuario);
  if (trava) return res.status(403).json({ erro: trava });
  if (inst && !thread) fixarChipDoLead(lead.id, inst.id);
  const r = simulado ? { ok: true } : await enviarTexto(inst.uazapi_token, alvo, texto);
  if (!r.ok) return res.status(502).json({ erro: r.erro });
  const msgId = salvarMensagem(lead.id, "assistant", texto);
  if (thread) db.prepare("UPDATE mensagens SET thread_id = ? WHERE id = ?").run(thread.id, msgId?.lastInsertRowid ?? msgId);
  if (!lead.ia_pausada && !thread) { atualizarLead(lead.id, { ia_pausada: 1 }); registrarEvento(lead.id, "handoff", "painel"); }
  // humano falou NUMA THREAD: a IA daquela thread para tambem (antes ela seguia
  // respondendo e atropelava a conversa do humano)
  if (thread && !thread.ia_pausada) db.prepare("UPDATE threads SET ia_pausada = 1 WHERE id = ?").run(thread.id);
  res.json({ ok: true });
});

// assumir/devolver a conversa de UMA thread (o botao do topo opera a thread aberta)
app.post("/api/thread/:id/ia", auth, (req, res) => {
  const th = getThread(Number(req.params.id));
  if (!th) return res.status(404).json({ erro: "thread nao existe" });
  const pausar = Boolean(req.body?.pausar);
  db.prepare("UPDATE threads SET ia_pausada = ? WHERE id = ?").run(pausar ? 1 : 0, th.id);
  if (pausar) {
    const d = debounces.get(`th${th.id}`);
    if (d) { clearTimeout(d.timer); debounces.delete(`th${th.id}`); }
  }
  registrarEvento(th.lead_id, "handoff",
    pausar ? `humano assumiu a conversa "${th.rotulo || th.telefone}"` : `IA retomou a conversa "${th.rotulo || th.telefone}"`);
  res.json({ ok: true });

  // devolveu a THREAD pra IA: ela retoma ali mesmo (nao espera nova mensagem)
  if (!pausar) {
    const lead = getLead(th.lead_id);
    if (lead && !lead.ia_pausada) {
      const tok = instanciaDoLead(lead, th.instancia_id)?.uazapi_token || "SIMULADO";
      responderLead(lead.id, tok, { threadId: th.id })
        .catch((e) => console.error("[retomar thread] erro:", e.message));
    }
  }
});

app.post("/api/lead/:id/ia", auth, async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "lead nao existe" });
  const pausar = Boolean(req.body?.pausar);
  atualizarLead(lead.id, { ia_pausada: pausar ? 1 : 0 });
  // assumiu = parada IMEDIATA: mata resposta pendente no debounce (sem isso a
  // IA ainda soltava a mensagem que estava preparando)
  if (pausar) {
    const d = debounces.get(lead.id);
    if (d) { clearTimeout(d.timer); debounces.delete(lead.id); }
  }
  registrarEvento(lead.id, "handoff", pausar ? "humano assumiu (painel)" : "devolvido pra IA (painel)");
  res.json({ ok: true });

  // DEVOLVEU pra IA -> ela RETOMA a conversa na hora (nao espera o lead responder).
  // Le todo o historico, inclusive o que o humano escreveu no meio, e da sequencia.
  if (!pausar) {
    // RETOMA NO CANAL CERTO: se a ultima mensagem do lead veio numa thread (o
    // decisor, por ex.), a IA responde NELA — antes respondia sempre na conversa
    // principal e a resposta ia pro numero da empresa, nao pra quem perguntou.
    const ult = db.prepare(`SELECT thread_id FROM mensagens WHERE lead_id = ? AND role = 'user'
      ORDER BY id DESC LIMIT 1`).get(lead.id);
    const th = ult?.thread_id ? getThread(ult.thread_id) : null;
    const alvoThread = th && th.lead_id === lead.id && !th.ia_pausada ? th : null;
    const tokRetomar = instanciaDoLead(lead, alvoThread?.instancia_id || null)?.uazapi_token || "SIMULADO";
    responderLead(lead.id, tokRetomar, alvoThread ? { threadId: alvoThread.id } : {})
      .catch((e) => console.error("[retomar IA] erro:", e.message));
  }
});

// ---------- reunioes ----------
app.get("/api/reunioes", auth, (req, res) => {
  res.json(db.prepare(`SELECT r.*, l.nome_clinica, l.telefone, l.cidade, l.dor
    FROM reunioes r JOIN leads l ON l.id = r.lead_id ORDER BY r.inicio DESC LIMIT 200`).all());
});
// ESPELHO DA AGENDA: mostra o que está na agenda conectada do usuário, junto
// com as reuniões que o CRM marcou. Assim ele vê a semana real sem sair do painel.
app.get("/api/agenda", auth, async (req, res) => {
  const { gcalConfigurado, listarEventos } = await import("./lib/gcal.js");
  const dias = Math.min(60, Math.max(1, Number(req.query.dias) || 28));
  // de qual agenda: a pedida na query > a do usuário logado > a primeira conectada.
  // O nome do usuário só vale se existir agenda com esse nome (senão cai na conectada).
  const conectados = ["matheus", "valentino"].filter((c) => gcalConfigurado(c));
  const pedido = String(req.query.closer || req.usuario?.gcal_email || req.usuario?.nome || "")
    .toLowerCase().split("@")[0].split(" ")[0];
  const closer = (pedido && gcalConfigurado(pedido)) ? pedido : (conectados[0] || pedido || "matheus");
  const conectada = gcalConfigurado(closer);
  // desdeDias 7: a grade semanal mostra a semana INTEIRA, inclusive os dias que ja passaram
  const eventos = conectada ? await listarEventos(closer, { dias, desdeDias: 7 }) : [];

  // tarefas de reunião do CRM que ainda não estão na agenda (sem gcal_event_id)
  const tarefasReuniao = db.prepare(`SELECT t.*, l.nome_clinica FROM tarefas t JOIN leads l ON l.id = t.lead_id
    WHERE t.tipo='reuniao' AND t.feita=0 AND t.quando IS NOT NULL ORDER BY t.quando, t.hora`).all();

  // liga cada evento ao lead (pra mostrar resumo ao clicar na agenda)
  const rs = db.prepare(`SELECT r.*, l.id lead_id, l.nome_clinica, l.telefone, l.telefone_decisor,
      l.nome_contato, l.nome_decisor, l.dor, l.cidade, l.nicho, l.valor_venda, l.resumo
    FROM reunioes r JOIN leads l ON l.id = r.lead_id WHERE r.status IN ('marcada','remarcada')`).all();
  for (const e of eventos) {
    const ini = (e.inicio || "").slice(0, 16);
    const r = rs.find((x) => (x.inicio || "").slice(0, 16) === ini)
      || rs.find((x) => e.titulo && x.nome_clinica && e.titulo.includes(x.nome_clinica));
    if (r) e.lead = {
      id: r.lead_id, nome: r.nome_clinica, telefone: r.telefone, telefone_decisor: r.telefone_decisor,
      contato: r.nome_decisor || r.nome_contato, dor: r.dor, cidade: r.cidade, nicho: r.nicho,
      valor: r.valor_venda, resumo: r.resumo, closer: r.closer,
    };
  }
  // rotulo de exibicao: em container de cliente a agenda e a DELE (a chave interna
  // "matheus" e so herança do schema) — nunca mostrar matheus/valentino pro cliente
  const ehCliente = MODO_IA === "api";
  const rotuloDe = (c) => ehCliente ? (NOME_DONO.split(/\s+/)[0] || "minha agenda") : c;
  res.json({
    closer, conectada, eventos, closer_nome: rotuloDe(closer),
    pessoas: (ehCliente ? ["matheus"] : ["matheus", "valentino"]).map((c) => ({ nome: rotuloDe(c), chave: c, conectada: gcalConfigurado(c) })),
    reunioes: db.prepare(`SELECT r.*, l.nome_clinica, l.telefone FROM reunioes r JOIN leads l ON l.id = r.lead_id
      WHERE r.status IN ('marcada','remarcada') AND r.inicio >= date('now','-1 day') ORDER BY r.inicio LIMIT 50`).all(),
    tarefas: tarefasReuniao,
    closers: conectados,
  });
});

app.patch("/api/reuniao/:id", auth, async (req, res) => {
  const { status } = req.body || {};
  if (!["marcada", "remarcada", "realizada", "no_show", "cancelada"].includes(status))
    return res.status(400).json({ erro: "status invalido" });
  cancelarReuniao(req.params.id, status);
  const r = db.prepare("SELECT * FROM reunioes WHERE id = ?").get(req.params.id);
  if (r) {
    if (status === "no_show") atualizarLead(r.lead_id, { status: "reuniao_marcada" });
    if (status === "realizada") atualizarLead(r.lead_id, { status: "compareceu" });
    if (status === "cancelada" && r.gcal_event_id) {
      const { apagarEventoMeet } = await import("./lib/gcal.js");
      apagarEventoMeet(r.closer, r.gcal_event_id).catch(() => {}); // best-effort
    }
  }
  res.json({ ok: true });
});

// ---------- campanhas ----------
app.get("/api/campanhas", auth, (req, res) => {
  const camps = db.prepare("SELECT * FROM campanhas ORDER BY id DESC").all();
  const hoje = agoraSP().data;
  for (const c of camps) {
    c.followups = followupsDaCampanha(c); // resolvido (config da campanha ou padrao)
    c.templates = db.prepare("SELECT * FROM templates WHERE campanha_id = ?").all(c.id);
    c.total_leads = db.prepare("SELECT COUNT(*) c FROM campanha_leads WHERE campanha_id = ?").get(c.id).c;
    c.disparados = db.prepare("SELECT COUNT(*) c FROM campanha_leads WHERE campanha_id = ? AND disparado_em IS NOT NULL").get(c.id).c;
    c.na_fila = db.prepare(`SELECT COUNT(*) c FROM campanha_leads cl JOIN leads l ON l.id = cl.lead_id
      WHERE cl.campanha_id = ? AND cl.disparado_em IS NULL AND l.status = 'novo'`).get(c.id).c;
    // "hoje" = volume de mensagens ativas (disparo + reengajamento + follow-up)
    // DESTA campanha, que e o que o motor compara com o teto dela. Antes usava o
    // total do sistema: com 2 campanhas, as duas mostravam a soma (60/20 e 60/40).
    c.disparados_hoje = disparosHojeDaCampanha(c);
    // mini relatorio do dia: quebra por tipo de mensagem + por numero de WhatsApp
    c.hoje = relatorioHojeDaCampanha(c);
    c.aberturas_hoje = c.hoje.aberturas;
    c.sem_whatsapp = db.prepare("SELECT COUNT(*) c FROM leads WHERE status = 'sem_whatsapp'").get().c;
    // resultado da campanha (lista de anuncios do painel): quem respondeu e quem marcou
    const doResultado = (tipo) => db.prepare(`SELECT COUNT(DISTINCT e.lead_id) c FROM eventos e
      JOIN campanha_leads cl ON cl.lead_id = e.lead_id WHERE cl.campanha_id = ? AND e.tipo = ?`).get(c.id, tipo).c;
    c.respostas = doResultado("resposta");
    c.reunioes = doResultado("reuniao");
    c.pipeline_nome = c.pipeline_id ? db.prepare("SELECT nome FROM pipelines WHERE id = ?").get(c.pipeline_id)?.nome || null : null;
  }
  res.json(camps);
});

app.post("/api/campanhas", auth, (req, res) => {
  const b = req.body || {};
  if (!b.nome) return res.status(400).json({ erro: "nome obrigatorio" });
  const pct = b.pct_reengajar !== undefined ? Math.max(0, Math.min(100, Number(b.pct_reengajar))) : 30;
  // funil de DISPARO da campanha (define por qual chip ela sai)
  const pipeCamp = b.pipeline_id ? Number(b.pipeline_id) : (listarPipelines().find((p) => p.tipo === "disparo")?.id || null);
  // follow-ups por etapa: {"respondeu":2,"em_conversa":2,"decisor":3,"negociando":3}
  const fuJson = b.followups && typeof b.followups === "object" ? JSON.stringify(b.followups) : null;
  const r = db.prepare(`INSERT INTO campanhas (nome, teto_dia, cadencia_min_seg, cadencia_max_seg, janela_inicio, janela_fim, dias_semana, pct_reengajar, pipeline_id, followups_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    b.nome, b.teto_dia || 25, b.cadencia_min_seg || 180, b.cadencia_max_seg || 420,
    b.janela_inicio || "08:30", b.janela_fim || "18:00", b.dias_semana || "1,2,3,4,5", pct, pipeCamp, fuJson);
  const id = r.lastInsertRowid;
  for (const t of b.aberturas || []) db.prepare("INSERT INTO templates (campanha_id, tipo, texto) VALUES (?, 'abertura', ?)").run(id, t);
  res.json({ ok: true, id });
});

app.patch("/api/campanha/:id", auth, (req, res) => {
  const b = req.body || {};
  if (b.status) {
    if (b.status === "ativa") {
      // 1 ativa POR FUNIL (Matheus e Valentino rodam campanhas em paralelo)
      const minha = db.prepare("SELECT pipeline_id FROM campanhas WHERE id = ?").get(req.params.id);
      db.prepare("UPDATE campanhas SET status = 'pausada' WHERE status = 'ativa' AND COALESCE(pipeline_id,0) = COALESCE(?,0)")
        .run(minha?.pipeline_id ?? null);
    }
    db.prepare("UPDATE campanhas SET status = ? WHERE id = ?").run(b.status, req.params.id);
  }
  for (const k of ["teto_dia", "cadencia_min_seg", "cadencia_max_seg", "janela_inicio", "janela_fim", "dias_semana", "pct_reengajar", "pipeline_id"])
    if (b[k] !== undefined) db.prepare(`UPDATE campanhas SET ${k} = ? WHERE id = ?`).run(b[k], req.params.id);
  if (b.followups && typeof b.followups === "object")
    db.prepare("UPDATE campanhas SET followups_json = ? WHERE id = ?").run(JSON.stringify(b.followups), req.params.id);
  res.json({ ok: true });
});

// substitui as mensagens (aberturas/follow-ups) de uma campanha existente
app.patch("/api/campanha/:id/templates", auth, (req, res) => {
  const b = req.body || {};
  const tipos = { aberturas: "abertura", followup1: "followup1", followup2: "followup2" };
  for (const [campo, tipo] of Object.entries(tipos)) {
    if (!Array.isArray(b[campo])) continue;
    db.prepare("DELETE FROM templates WHERE campanha_id = ? AND tipo = ?").run(req.params.id, tipo);
    for (const t of b[campo].filter(Boolean))
      db.prepare("INSERT INTO templates (campanha_id, tipo, texto) VALUES (?, ?, ?)").run(req.params.id, tipo, t);
  }
  res.json({ ok: true });
});

// vincula todos os leads status=novo (opcionalmente filtrando cidade) na campanha
// listas (tags) disponiveis pra vincular: so do funil da campanha, com contagem
app.get("/api/campanha/:id/listas", auth, (req, res) => {
  const camp = db.prepare("SELECT pipeline_id FROM campanhas WHERE id = ?").get(req.params.id);
  if (!camp) return res.status(404).json({ erro: "campanha nao existe" });
  const listas = db.prepare(`SELECT COALESCE(l.tag_importacao, l.origem_lista, 'sem tag') tag,
      COUNT(*) novos,
      SUM(CASE WHEN cl.lead_id IS NULL THEN 1 ELSE 0 END) faltam
    FROM leads l LEFT JOIN campanha_leads cl ON cl.lead_id = l.id AND cl.campanha_id = ?
    WHERE l.status = 'novo' AND l.eh_teste = 0 AND COALESCE(l.pipeline_id,0) = COALESCE(?,0)
    GROUP BY tag ORDER BY MAX(l.criado_em) DESC`).all(req.params.id, camp.pipeline_id);
  res.json(listas);
});
app.post("/api/campanha/:id/leads", auth, (req, res) => {
  const { cidade, tag } = req.body || {};
  // SO leads do funil da propria campanha — sem isso, "vincular" puxava lead de
  // TODOS os funis (inclusive de outro dono) pra dentro da campanha errada
  const camp = db.prepare("SELECT pipeline_id FROM campanhas WHERE id = ?").get(req.params.id);
  if (!camp) return res.status(404).json({ erro: "campanha nao existe" });
  const leads = db.prepare(`SELECT id FROM leads WHERE status = 'novo' AND eh_teste = 0
      AND COALESCE(pipeline_id,0) = COALESCE(?,0)
      ${tag ? "AND COALESCE(tag_importacao, origem_lista, 'sem tag') = ?" : ""}
      ${cidade ? "AND cidade LIKE ?" : ""}`)
    .all(camp.pipeline_id, ...(tag ? [tag] : []), ...(cidade ? [`%${cidade}%`] : []));
  const ins = db.prepare("INSERT OR IGNORE INTO campanha_leads (campanha_id, lead_id) VALUES (?, ?)");
  let n = 0;
  for (const l of leads) n += ins.run(req.params.id, l.id).changes;
  res.json({ ok: true, vinculados: n });
});

// ---------- importar CSV (formato Apify Google Maps ou generico) ----------
function parseCSV(texto) {
  const linhas = [];
  let atual = [], campo = "", aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === "," || c === ";") { atual.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      atual.push(campo); campo = "";
      if (atual.some((x) => x.trim())) linhas.push(atual);
      atual = [];
    } else campo += c;
  }
  if (campo || atual.length) { atual.push(campo); if (atual.some((x) => x.trim())) linhas.push(atual); }
  return linhas;
}

app.post("/api/importar", auth, upload.single("csv"), async (req, res) => {
  try {
    const texto = readFileSync(req.file.path, "utf8");
    unlinkSync(req.file.path);
    const linhas = parseCSV(texto);
    if (linhas.length < 2) return res.status(400).json({ erro: "csv vazio" });
    const header = linhas[0].map((h) => h.trim().toLowerCase());
    const col = (...nomes) => header.findIndex((h) => nomes.includes(h));
    // MAPEAMENTO CONFERIDO NO PAINEL: {indiceDaColuna: campo}. Quando vem, ele
    // MANDA — o palpite automatico e so fallback (import antigo/via API).
    let mapa = null;
    try { mapa = req.body?.mapeamento ? JSON.parse(req.body.mapeamento) : null; } catch { /* ignora mapa invalido */ }
    const doMapa = (campo) => {
      const k = Object.keys(mapa || {}).find((i) => mapa[i] === campo);
      return k === undefined ? -1 : Number(k);
    };
    const idx = (campo, fallback) => (mapa ? doMapa(campo) : fallback);
    const iNome = idx("nome", col("title", "nome", "name", "nome_clinica"));
    const iTel = idx("telefone", col("phone", "telefone", "phoneunformatted", "whatsapp", "numero", "número"));
    const iCidade = idx("cidade", col("city", "cidade"));
    const iSite = idx("site", col("website", "site", "url"));
    const iNota = idx("nota", col("totalscore", "nota", "rating"));
    const iAval = idx("avaliacoes", col("reviewscount", "avaliacoes", "reviews"));
    const iNicho = idx("nicho", col("categoryname", "nicho", "categoria"));
    if (iTel === -1) return res.status(400).json({ erro: `coluna de telefone nao achada. header: ${header.join(", ")}` });

    // colunas extras do modelo novo (decisor, valor, GMN)
    const iDecisorNome = idx("decisor", col("decisor", "nome_decisor", "responsavel", "responsável"));
    const iDecisorTel = idx("telefone_decisor", col("telefone_decisor", "tel_decisor", "whatsapp_decisor", "celular_decisor"));
    const iValor = idx("valor", col("valor", "valor_venda", "ticket"));
    const iGmn = idx("gmn", col("google_meu_negocio", "gmn", "google", "maps"));
    const iAtendente = idx("atendente", col("atendente", "contato", "nome_contato"));

    const origem = req.body?.origem || req.file.originalname || "csv";
    // TAG da importação (agrupa a lista) e PIPELINE de destino
    const tag = String(req.body?.tag || "").trim() || origem;
    const pipelineId = Number(req.body?.pipeline_id) || listarPipelines()[0]?.id || null;
    const pipe = pipelineId ? getPipeline(pipelineId) : null;
    const etapa = pipelineId ? etapaDeEntrada(pipelineId) : null;
    // campanha da pipeline: só pipeline de DISPARO entra em fila de envio
    const campanha = pipe?.tipo === "disparo"
      ? db.prepare("SELECT id FROM campanhas WHERE pipeline_id = ? AND status IN ('ativa','pausada') ORDER BY id DESC LIMIT 1").get(pipelineId)
      : null;

    let novos = 0, repetidos = 0, semTel = 0;
    for (const l of linhas.slice(1)) {
      let tel = String(l[iTel] || "").replace(/\D/g, "");
      if (!tel) { semTel++; continue; }
      tel = normalizarTelefone(tel);
      const antes = db.prepare("SELECT COUNT(*) c FROM leads").get().c;
      const leadId = upsertLead({
        nome_clinica: l[iNome] || "Clínica", telefone: tel,
        cidade: iCidade >= 0 ? l[iCidade] : null, site: iSite >= 0 ? l[iSite] : null,
        nota: iNota >= 0 ? l[iNota] : null, avaliacoes: iAval >= 0 ? l[iAval] : null,
        nicho: iNicho >= 0 ? l[iNicho] : null, origem_lista: origem,
      });
      const eNovo = db.prepare("SELECT COUNT(*) c FROM leads").get().c > antes;
      eNovo ? novos++ : repetidos++;
      if (!leadId) continue;

      // lead NOVO entra na pipeline escolhida; lead repetido não é movido de etapa
      // (senão uma reimportação jogaria conversa em andamento de volta pra "Novos")
      if (eNovo && etapa) {
        db.prepare("UPDATE leads SET pipeline_id = ?, etapa_id = ?, tag_importacao = ? WHERE id = ?")
          .run(pipelineId, etapa.id, tag, leadId);
        addTelefone(leadId, tel, "empresa", "Empresa");
        abrirThread(leadId, tel, "Empresa", pipe?.instancia_id || null);
        if (campanha) db.prepare("INSERT OR IGNORE INTO campanha_leads (campanha_id, lead_id) VALUES (?,?)").run(campanha.id, leadId);
      }
      // dados extras (valem pra novo e pra repetido: enriquecem o cadastro)
      const extras = {};
      if (iDecisorNome >= 0 && l[iDecisorNome]) extras.nome_decisor = l[iDecisorNome];
      if (iAtendente >= 0 && l[iAtendente]) extras.nome_contato = l[iAtendente];
      if (iValor >= 0 && l[iValor]) extras.valor_venda = Number(String(l[iValor]).replace(/[^\d,.-]/g, "").replace(",", ".")) || 0;
      if (iGmn >= 0 && l[iGmn]) extras.google_negocio = l[iGmn];
      if (iDecisorTel >= 0 && l[iDecisorTel]) {
        const dec = normalizarTelefone(l[iDecisorTel], tel);
        if (dec) { extras.telefone_decisor = dec; addTelefone(leadId, dec, "decisor", l[iDecisorNome] || "Decisor"); }
      }
      if (Object.keys(extras).length) atualizarLead(leadId, extras);
    }
    res.json({
      ok: true, novos, repetidos, semTel, tag,
      pipeline: pipe?.nome || null, tipo: pipe?.tipo || null,
      na_fila: Boolean(campanha),
      aviso: pipe?.tipo === "disparo" && !campanha
        ? "Importado, mas essa pipeline de disparo ainda não tem campanha — cria uma pra começar a enviar."
        : null,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// EXPORTAR leads em CSV (do funil pedido, ou todos). Auth por query (download direto).
app.get("/api/exportar.csv", (req, res) => {
  if (!tokenQueryValido(String(req.query.t || ""))) return res.status(401).end();
  const pid = req.query.pipeline_id ? Number(req.query.pipeline_id) : null;
  const leads = db.prepare(`SELECT l.*, e.nome etapa_nome, p.nome pipeline_nome,
      (SELECT nome FROM usuarios u WHERE u.id = l.usuario_id) responsavel
    FROM leads l LEFT JOIN etapas e ON e.id = l.etapa_id LEFT JOIN pipelines p ON p.id = l.pipeline_id
    WHERE l.eh_teste = 0 ${pid ? "AND l.pipeline_id = " + pid : ""} ORDER BY l.id`).all();
  const cab = ["nome", "telefone", "cidade", "nicho", "funil", "etapa", "status", "responsavel", "valor",
    "tag", "atendente", "decisor", "telefone_decisor", "site", "google_meu_negocio", "dor", "criado_em"];
  const esc = (v) => { const t = String(v ?? ""); return /[",\n;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const linhas = leads.map((l) => [l.nome_clinica, l.telefone, l.cidade, l.nicho, l.pipeline_nome, l.etapa_nome,
    l.status, l.responsavel, l.valor_venda || 0, l.tag_importacao || l.origem_lista, l.nome_atendente || l.nome_contato,
    l.nome_decisor, l.telefone_decisor, l.site, l.google_negocio, l.dor, l.criado_em].map(esc).join(","));
  const csv = "\ufeff" + [cab.join(","), ...linhas].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="prospecta-leads${pid ? "-funil" + pid : ""}.csv"`);
  res.send(csv);
});

// ---------- planilha MODELO de importacao ----------
// Baixa um CSV pronto com os cabecalhos certos e 2 linhas de exemplo. O link
// do Drive (opcional) fica na config `planilha_modelo_url` — quem preferir
// copiar a planilha do Drive usa esse; quem quiser baixar direto usa este CSV.
const COLUNAS_MODELO = [
  ["nome", "Nome da empresa (obrigatório)"],
  ["telefone", "Telefone com DDD (obrigatório)"],
  ["cidade", "Cidade"],
  ["nicho", "Segmento/nicho"],
  ["site", "Site"],
  ["google_meu_negocio", "Link do Google Meu Negócio"],
  ["atendente", "Nome de quem atende"],
  ["decisor", "Nome do decisor"],
  ["telefone_decisor", "Telefone do decisor"],
  ["valor", "Valor previsto da venda"],
  ["avaliacoes", "Nº de avaliações no Google"],
  ["nota", "Nota no Google"],
];
app.get("/api/modelo-importacao.csv", (req, res) => {
  if (!tokenQueryValido(String(req.query.t || ""))) return res.status(401).end();
  const head = COLUNAS_MODELO.map(([c]) => c).join(",");
  const ex1 = ["Clínica Exemplo", "31999998888", "Belo Horizonte", "Odontologia", "https://exemplo.com.br",
    "https://maps.google.com/?cid=123", "Juliana", "Dr. Paulo", "31988887777", "1500", "42", "4.8"];
  const ex2 = ["Consultório Modelo", "3133334444", "Contagem", "Fisioterapia", "", "", "", "", "", "", "18", "4.5"];
  const csv = "﻿" + [head, ex1.join(","), ex2.join(",")].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="modelo-importacao-leads.csv"');
  res.send(csv);
});
app.get("/api/modelo-importacao", auth, (req, res) => {
  res.json({
    colunas: COLUNAS_MODELO.map(([campo, desc]) => ({ campo, desc })),
    drive_url: getConfig("planilha_modelo_url", ""),
  });
});

// ---------- audio oficial ----------
// ÁUDIO POR PESSOA: cada sócio/funcionário sobe o áudio na voz DELE. O áudio
// usado numa conversa é o do dono da pipeline daquele lead (cai no global se
// a pessoa não tiver o dela). Todo mundo da empresa VÊ todos os áudios.
const chaveAudio = (uid) => (uid ? `audio_oficial_u${uid}` : "audio_oficial");
const chaveAudioInfo = (uid) => (uid ? `audio_oficial_info_u${uid}` : "audio_oficial_info");

app.post("/api/audio", auth, upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "arquivo nao veio" });
  // de quem é esse áudio: o indicado no form, senão o próprio usuário logado
  const uid = req.body?.usuario_id ? Number(req.body.usuario_id) : (req.usuario?.id || null);
  const ext = (extname(req.file.originalname || "") || ".ogg").toLowerCase();
  const destino = join(DADOS_DIR, `audio-oficial${uid ? "-u" + uid : ""}${ext}`);
  renameSync(req.file.path, destino);
  setConfig(chaveAudio(uid), destino);
  setConfig(chaveAudioInfo(uid), JSON.stringify({
    nome: req.file.originalname, kb: Math.round(req.file.size / 1024), em: agoraSP().iso,
    dono: uid ? (getUsuario(uid)?.nome || null) : null,
  }));
  res.json({ ok: true, caminho: destino, usuario_id: uid });
});

// TRAZER UM ÁUDIO PRA MIM: copia o áudio geral (ou de outra pessoa) pro meu slot.
// Caso real: o áudio "geral" era a voz do Matheus — ele recupera com 1 clique.
app.post("/api/audio/atribuir", auth, (req, res) => {
  const de = req.body?.de ? Number(req.body.de) : null;   // null = áudio geral da empresa
  const para = req.body?.para ? Number(req.body.para) : (req.usuario?.id || null);
  if (!para) return res.status(400).json({ erro: "não sei pra quem copiar" });
  const origem = getConfig(chaveAudio(de), "");
  if (!origem || !fsExiste(origem)) return res.status(404).json({ erro: "o áudio de origem não existe mais" });
  const ext = (extname(origem) || ".ogg").toLowerCase();
  const destino = join(DADOS_DIR, `audio-oficial-u${para}${ext}`);
  copyFileSync(origem, destino);
  setConfig(chaveAudio(para), destino);
  let info = null; try { info = JSON.parse(getConfig(chaveAudioInfo(de), "null")); } catch {}
  setConfig(chaveAudioInfo(para), JSON.stringify({
    ...(info || {}), em: agoraSP().iso, dono: getUsuario(para)?.nome || null,
    nome: (info?.nome || "áudio") + " (copiado)",
  }));
  res.json({ ok: true });
});

// remove o áudio de uma pessoa (volta a usar o padrão da empresa)
app.delete("/api/audio", auth, (req, res) => {
  const uid = req.query.usuario_id ? Number(req.query.usuario_id) : (req.usuario?.id || null);
  if (!uid) return res.status(400).json({ erro: "diz de quem é o áudio" });
  setConfig(chaveAudio(uid), "");
  setConfig(chaveAudioInfo(uid), "");
  res.json({ ok: true });
});

// toca o audio oficial no painel (auth por query, tag <audio> nao manda header)
app.get("/api/audio-arquivo", async (req, res) => {
  if (!tokenQueryValido(String(req.query.t || ""))) return res.status(401).end();
  const uid = req.query.usuario_id ? Number(req.query.usuario_id) : null;
  const caminho = getConfig(chaveAudio(uid), "") || (uid ? getConfig("audio_oficial", "") : "");
  const { existsSync } = await import("node:fs");
  if (!caminho || !existsSync(caminho)) return res.status(404).end();
  res.sendFile(caminho);
});

// TODOS da empresa veem TODOS os áudios (o da empresa + o de cada pessoa)
app.get("/api/audio-info", auth, (req, res) => {
  const leInfo = (uid) => { try { return JSON.parse(getConfig(chaveAudioInfo(uid), "null")); } catch { return null; } };
  const geral = getConfig("audio_oficial", "");
  const porPessoa = listarUsuarios().filter((u) => u.ativo).map((u) => ({
    usuario_id: u.id, nome: u.nome,
    configurado: Boolean(getConfig(chaveAudio(u.id), "")),
    info: leInfo(u.id),
  }));
  res.json({
    configurado: Boolean(geral), info: leInfo(null),   // compatibilidade com o painel antigo
    geral: { configurado: Boolean(geral), info: leInfo(null) },
    porPessoa,
    eu: req.usuario?.id || null,
  });
});

// ---------- config ----------
// Em container de CLIENTE (MODO_IA=api) os nomes internos dos closers nao podem
// vazar pela API: slots_matheus vira slots_dono etc. O armazenamento continua nas
// chaves canonicas (agente/worker intactos); a traducao e so na borda HTTP.
const CFG_ALIAS_DONO = { slots_matheus: "slots_dono", meet_matheus: "meet_dono", gcal_email_matheus: "gcal_email_dono" };
app.get("/api/config", auth, (req, res) => {
  const chaves = ["slots_matheus", "slots_valentino", "meet_matheus", "meet_valentino",
    "closer_matheus_ativo", "closer_valentino_ativo", "audio_oficial", "instancia_status",
    "link_site", "gcal_email_matheus", "gcal_email_valentino", "convidados_reuniao",
    "treino_geral", "treino_pitch", "treino_objecoes", "treino_exemplo", "link_apresentacao", "empresa_nome", "termo_lead"];
  const cfg = Object.fromEntries(chaves.map((c) => [c, getConfig(c, "")]));
  if (MODO_IA === "api") {
    for (const [interno, publico] of Object.entries(CFG_ALIAS_DONO)) { cfg[publico] = cfg[interno]; delete cfg[interno]; }
    for (const k of Object.keys(cfg)) if (k.includes("valentino") || k.startsWith("closer_")) delete cfg[k];
  }
  res.json(cfg);
});
app.post("/api/config", auth, (req, res) => {
  const permitidas = ["slots_matheus", "slots_valentino", "meet_matheus", "meet_valentino",
    "closer_matheus_ativo", "closer_valentino_ativo",
    "treino_geral", "treino_pitch", "treino_objecoes", "treino_exemplo", "link_apresentacao", "empresa_nome", "link_site", "termo_lead"];
  const paraInterno = Object.fromEntries(Object.entries(CFG_ALIAS_DONO).map(([i, p]) => [p, i]));
  for (const [k, v] of Object.entries(req.body || {})) {
    const chave = paraInterno[k] || k;
    if (MODO_IA === "api" && (chave.includes("valentino") || chave.startsWith("closer_"))) continue;
    if (permitidas.includes(chave)) setConfig(chave, v);
  }
  res.json({ ok: true });
});

// ---------- WhatsApps (multi-instancia + rotacao) ----------
const WHATSAPPS_LIMITE = Number(process.env.WHATSAPPS_LIMITE || 99); // container de cliente define pelo plano

app.get("/api/instancias", auth, (req, res) => {
  // uazapi_token NUNCA vai pro navegador (com ele da pra mandar mensagem pelo
  // numero direto na uazapi, fora do sistema)
  let instancias = listarInstancias().map(({ uazapi_token, ...i }) => ({
    ...i, dono: i.usuario_id ? (getUsuario(i.usuario_id)?.nome || null) : null,
  }));
  // ?minhas=1 -> só os WhatsApps desta pessoa (os sem dono aparecem pra todos)
  if (req.query.minhas === "1" && req.usuario?.id)
    instancias = instancias.filter((i) => !i.usuario_id || i.usuario_id === req.usuario.id);
  res.json({ instancias, limite: WHATSAPPS_LIMITE });
});

app.post("/api/instancias", auth, (req, res) => {
  const insts = listarInstancias();
  if (insts.length >= WHATSAPPS_LIMITE)
    return res.status(403).json({ erro: `seu plano permite ${WHATSAPPS_LIMITE} WhatsApp(s). Fale com o suporte pra aumentar (R$20/mês por número).` });
  const nome = String(req.body?.nome || `WhatsApp ${insts.length + 1}`).slice(0, 40);
  const id = criarInstanciaDB(nome);
  // o WhatsApp fica no nome de quem conectou (cada um tem o chip dele)
  if (req.usuario?.id) atualizarInstancia(id, { usuario_id: req.usuario.id });
  res.json({ ok: true, id });
});

app.patch("/api/instancias", auth, (req, res) => {
  const inst = getInstancia(req.body?.id);
  if (!inst) return res.status(404).json({ erro: "não existe" });
  const campos = {};
  if (req.body.nome !== undefined) campos.nome = String(req.body.nome).slice(0, 40);
  if (req.body.cota_dia !== undefined) campos.cota_dia = Math.max(0, Number(req.body.cota_dia) || 0);
  // de quem é o número (null = da empresa)
  if (req.body.usuario_id !== undefined) campos.usuario_id = req.body.usuario_id ? Number(req.body.usuario_id) : null;
  if (req.body.pipeline_id !== undefined) campos.pipeline_id = req.body.pipeline_id ? Number(req.body.pipeline_id) : null;
  // receber contatos novos (quem chama primeiro vira lead)
  if (["receber_novos", "funil_novos", "ia_novos"].some((k) => req.body[k] !== undefined) && !pode(req.usuario, "conectar_whatsapp"))
    return res.status(403).json({ erro: "seu papel não pode mudar isso" });
  if (req.body.receber_novos !== undefined) campos.receber_novos = req.body.receber_novos ? 1 : 0;
  // LIGAR a sincronizacao e decisao do cliente: so com a senha de quem esta logado
  if (campos.receber_novos === 1 && !inst.receber_novos) {
    const conf = senhaConfere(req, req.body.senha);
    if (!conf.ok) return res.status(403).json({ erro: conf.erro, precisa_senha: true });
  }
  if (req.body.limite_novos_dia !== undefined) campos.limite_novos_dia = Math.min(500, Math.max(1, Math.round(Number(req.body.limite_novos_dia) || 30)));
  if (req.body.funil_novos !== undefined) campos.funil_novos = req.body.funil_novos ? Number(req.body.funil_novos) : null;
  if (req.body.ia_novos !== undefined) campos.ia_novos = req.body.ia_novos ? 1 : 0;
  if (campos.receber_novos && !getPipeline(campos.funil_novos ?? inst.funil_novos ?? inst.pipeline_id ?? 0))
    return res.status(400).json({ erro: "escolha o funil onde os contatos novos vão entrar" });
  atualizarInstancia(inst.id, campos);
  if (campos.receber_novos !== undefined && campos.receber_novos !== (inst.receber_novos ? 1 : 0))
    registrarEvento(null, "seguranca", `${req.usuario?.nome || "dono"} ${campos.receber_novos ? "LIGOU" : "desligou"} a sincronização de contatos novos no WhatsApp ${inst.nome}`);
  // espelha o vínculo na pipeline (o personalizador e o worker leem dos dois lados)
  if (campos.pipeline_id !== undefined) {
    db.prepare("UPDATE pipelines SET instancia_id = NULL WHERE instancia_id = ?").run(inst.id);
    if (campos.pipeline_id) db.prepare("UPDATE pipelines SET instancia_id = ? WHERE id = ?").run(inst.id, campos.pipeline_id);
  }
  res.json({ ok: true });
});

app.delete("/api/instancias", auth, (req, res) => {
  const inst = getInstancia(req.query.id);
  if (!inst) return res.status(404).json({ erro: "não existe" });
  removerInstancia(inst.id);
  res.json({ ok: true });
});

// QR por instancia: ?inst=<id>. Cria/recupera token na uazapi e conecta.
app.get("/api/qr", auth, async (req, res) => {
  const inst = req.query.inst ? getInstancia(req.query.inst) : listarInstancias()[0];
  if (!inst) return res.status(404).json({ erro: "adicione um WhatsApp primeiro" });
  const rotulo = `${process.env.CLIENTE_NOME || "Facilita SDR"} - ${inst.nome}`;
  let token = inst.uazapi_token;
  if (!token) {
    const nova = await criarInstancia(rotulo);
    if (!nova.token) return res.status(502).json({ erro: `nao criei instancia: ${nova.erro}` });
    token = nova.token;
    atualizarInstancia(inst.id, { uazapi_token: token });
  }
  let r = await conectarInstancia(token);
  if (r.tokenInvalido) {
    const nova = await criarInstancia(rotulo);
    if (!nova.token) return res.status(502).json({ erro: "token morto e nao recriei" });
    token = nova.token;
    atualizarInstancia(inst.id, { uazapi_token: token });
    r = await conectarInstancia(token);
  }
  if (statusConectado(r.status)) {
    atualizarInstancia(inst.id, { status: "conectado", numero: r.owner || inst.numero });
    setConfig("instancia_status", "conectado"); // compat
    await configurarWebhook(token);
  }
  res.json({ status: r.status, qrcode: r.qrcode || null, paircode: r.paircode || null, inst: inst.id });
});

// ---------- OAuth Google por closer (botao "Conectar agenda" no painel) ----------
// Requer o redirect URI cadastrado no OAuth client do Google Cloud:
//   https://sdr.2-25-138-60.sslip.io/api/gcal/callback
const PAINEL_URL = process.env.PAINEL_URL || "https://facilita-sdr.vercel.app";
const assinaState = (closer, ts) => sha(`${WEBHOOK_SECRET}|gcal|${closer}|${ts}`).slice(0, 24);

app.get("/api/gcal/conectar", (req, res) => {
  const t = String(req.query.t || "");
  if (!tokenQueryValido(t)) return res.status(401).send("sessao invalida — abre pelo painel");
  const closer = req.query.closer === "valentino" ? "valentino" : "matheus";
  const ts = Date.now();
  const state = `${closer}.${ts}.${assinaState(closer, ts)}`;
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: `${process.env.APP_URL}/api/gcal/callback`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  res.redirect(url);
});

app.get("/api/gcal/callback", async (req, res) => {
  try {
    const [closer, ts, assin] = String(req.query.state || "").split(".");
    if (!["matheus", "valentino"].includes(closer) || assin !== assinaState(closer, ts) ||
        Date.now() - Number(ts) > 15 * 60_000)
      return res.status(400).send("state invalido/expirado — tenta de novo pelo painel");
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code || ""),
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        redirect_uri: `${process.env.APP_URL}/api/gcal/callback`,
        grant_type: "authorization_code",
      }),
    });
    const d = await r.json();
    if (!d.refresh_token) return res.status(502).send("Google nao devolveu autorizacao: " + JSON.stringify(d).slice(0, 200));
    setConfig(`gcal_refresh_${closer}`, d.refresh_token);
    // guarda o E-MAIL da agenda: usado pra convidar o socio nas reunioes marcadas
    try {
      const perfil = await (await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${d.access_token}` }, signal: AbortSignal.timeout(8_000),
      })).json();
      if (perfil?.email) setConfig(`gcal_email_${closer}`, perfil.email);
    } catch { /* sem e-mail: convite do socio so nao acontece */ }
    registrarEvento(null, "gcal", `agenda conectada: ${closer}`);
    res.redirect(`${PAINEL_URL}?gcal=${closer}`);
  } catch (e) {
    res.status(500).send("erro: " + e.message);
  }
});

// ---------- notificacoes no Telegram: quem recebe os alertas ----------
// Cada destino e um par (bot, chat): da pra ter o bot PROPRIO de cada pessoa.
app.get("/api/telegram/chats", auth, async (req, res) => {
  const { destinosExtras, chatsRecentes, nomeDoBot } = await import("./lib/telegram.js");
  const extras = destinosExtras();
  const principal = process.env.TELEGRAM_CHAT_ID || null;
  const jaTem = new Set([principal, ...extras.map((d) => d.chat)].filter(Boolean));
  // "procurar novos" so no bot principal (o extra ja veio com chat definido)
  const recentes = req.query.buscar === "1"
    ? (await chatsRecentes()).filter((c) => !jaTem.has(c.id))
    : [];
  res.json({
    principal,
    bot_principal: req.query.buscar === "1" ? await nomeDoBot(process.env.TELEGRAM_BOT_TOKEN) : null,
    extras: extras.map((d) => ({ nome: d.nome, chat: d.chat, usuario_id: d.usuario_id || null,
      dono: d.usuario_id ? getUsuario(d.usuario_id)?.nome || null : null,
      bot_proprio: d.token !== (process.env.TELEGRAM_BOT_TOKEN || "") })),
    usuarios: listarUsuarios().filter((u) => u.ativo).map((u) => ({ id: u.id, nome: u.nome })),
    dono_principal: Number(getConfig("telegram_usuario_principal", "") || 0) || null,
    recentes,
  });
});
app.post("/api/telegram/chats", auth, async (req, res) => {
  const chatId = String(req.body?.chat_id || "").trim();
  const token = String(req.body?.token || "").trim();       // bot proprio (opcional)
  const nome = String(req.body?.nome || "").trim() || "extra";
  const usuarioId = req.body?.usuario_id ? Number(req.body.usuario_id) : null;
  if (!/^-?\d+$/.test(chatId)) return res.status(400).json({ erro: "chat_id inválido (só números)" });
  if (token && !/^\d+:[\w-]{20,}$/.test(token)) return res.status(400).json({ erro: "token do bot com formato inválido" });
  const { destinosExtras, salvarDestinos, enviarPara, nomeDoBot } = await import("./lib/telegram.js");

  const tokenUsado = token || process.env.TELEGRAM_BOT_TOKEN || "";
  if (!tokenUsado) return res.status(400).json({ erro: "sem bot configurado no servidor: informe o token do bot" });
  // valida ANTES de salvar: token vivo + chat alcancavel (mensagem de teste)
  const bot = await nomeDoBot(tokenUsado);
  if (!bot) return res.status(400).json({ erro: "esse token não respondeu no Telegram (bot inválido ou revogado)" });
  const teste = await enviarPara({ token: tokenUsado, chat: chatId },
    `✅ Pronto! Esse chat agora recebe os avisos do Prospecta AI (cadastrado por ${req.usuario?.nome || "alguém"} pelo painel).`);
  if (!teste.ok) return res.status(400).json({ erro: `não consegui mandar mensagem nesse chat: ${teste.erro}. A pessoa já mandou /start pro @${bot}?` });

  const extras = destinosExtras().filter((d) => !(d.chat === chatId && d.token === tokenUsado));
  salvarDestinos([...extras, { nome, token, chat: chatId, usuario_id: usuarioId }]);
  res.json({ ok: true, bot });
});
// muda de quem sao os avisos de um destino ja cadastrado
app.post("/api/telegram/dono", auth, async (req, res) => {
  const chat = String(req.body?.chat || "").trim();
  const uid = req.body?.usuario_id ? Number(req.body.usuario_id) : null;
  const { destinosExtras, salvarDestinos } = await import("./lib/telegram.js");
  const extras = destinosExtras();
  if (!extras.some((d) => d.chat === chat)) return res.status(404).json({ erro: "destino nao encontrado" });
  salvarDestinos(extras.map((d) => (d.chat === chat ? { ...d, usuario_id: uid } : d)));
  res.json({ ok: true });
});
app.post("/api/telegram/principal", auth, (req, res) => {
  const uid = req.body?.usuario_id ? Number(req.body.usuario_id) : null;
  setConfig("telegram_usuario_principal", uid ? String(uid) : "");
  res.json({ ok: true });
});
app.delete("/api/telegram/chats/:chatId", auth, async (req, res) => {
  const alvo = String(req.params.chatId);
  if (alvo === String(process.env.TELEGRAM_CHAT_ID || "")) return res.status(400).json({ erro: "esse é o chat principal (fixado no servidor)" });
  const { destinosExtras, salvarDestinos } = await import("./lib/telegram.js");
  salvarDestinos(destinosExtras().filter((d) => d.chat !== alvo));
  res.json({ ok: true });
});

// ---------- status da agenda Google por closer ----------
app.get("/api/gcal-status", auth, async (req, res) => {
  const { statusConexao } = await import("./lib/gcal.js");
  // container de cliente: agenda unica ("dono", que internamente e o slot matheus)
  if (MODO_IA === "api") return res.json({ dono: await statusConexao("matheus") });
  res.json({
    matheus: await statusConexao("matheus"),
    valentino: await statusConexao("valentino"),
  });
});

// abertura da campanha ativa (mesmas mensagens que o disparo real usa)
function aberturaDaCampanha(lead) {
  const camp = campanhaAtiva();
  const tpls = camp ? db.prepare("SELECT texto FROM templates WHERE campanha_id = ? AND tipo = 'abertura'").all(camp.id) : [];
  const tpl = tpls.length ? tpls[Math.floor(Math.random() * tpls.length)].texto
    : `Oi, tudo bem? Aqui é o Matheus. Consigo falar com o responsável da {nome_clinica}?`;
  return tpl.replaceAll("{nome_clinica}", lead.nome_clinica || "clínica").replaceAll("{cidade}", lead.cidade || "");
}

// ---------- teste REAL: cadastra um telefone teu como lead e dispara a abertura ----------
app.post("/api/testar-real", auth, async (req, res) => {
  const instCon = db.prepare("SELECT * FROM instancias WHERE status = 'conectado' ORDER BY id").get();
  if (!instCon) return res.status(409).json({ erro: "nenhum WhatsApp conectado (Config → QR)" });
  const token = instCon.uazapi_token;
  let tel = String(req.body?.telefone || "").replace(/\D/g, "");
  if (!tel) return res.status(400).json({ erro: "telefone obrigatório" });
  if (tel.length <= 11 && !tel.startsWith("55")) tel = "55" + tel;
  const existente = getLeadPorTelefone(tel);
  if (existente && !["novo", "disparado"].includes(existente.status))
    return res.status(409).json({ erro: `esse número já está em conversa (${existente.status}) — acompanha pela aba Conversas` });
  const nome = req.body?.nome || "Clínica Teste Real";
  const chk = await checarWhatsapp(token, tel);
  if (chk.temWhatsapp === false) return res.status(422).json({ erro: `esse número não tem WhatsApp (${tel})` });
  if (chk.numeroCorrigido) tel = chk.numeroCorrigido;
  const id = existente?.id || upsertLead({ nome_clinica: nome, telefone: tel, cidade: "Teste", nicho: "teste", origem_lista: "teste-real" });
  const abertura = aberturaDaCampanha(getLead(id));
  const r = await enviarTexto(token, tel, abertura);
  if (r.ok) fixarChipDoLead(id, instCon.id); // teste tambem cola no chip
  if (!r.ok) return res.status(502).json({ erro: `envio falhou: ${r.erro}` });
  salvarMensagem(id, "assistant", abertura);
  atualizarLead(id, { status: "disparado", ia_pausada: 0, eh_teste: 1 }); // teste nunca suja a pipe
  registrarEvento(id, "disparo", "teste-real");
  res.json({ ok: true, lead_id: id, msg: "abertura enviada; responde do outro celular que a IA assume" });
});

// ---------- simulador (teste E2E sem WhatsApp real) ----------
app.post("/api/simular", auth, async (req, res) => {
  const { texto, reset } = req.body || {};
  const telefoneFake = "0000" + (req.body?.slot || "1");
  let lead = getLeadPorTelefone(telefoneFake);
  if (reset && lead) {
    db.prepare("DELETE FROM mensagens WHERE lead_id = ?").run(lead.id);
    db.prepare("DELETE FROM reunioes WHERE lead_id = ?").run(lead.id);
    db.prepare("DELETE FROM threads WHERE lead_id = ?").run(lead.id); // cascata: sem isso a thread ficava orfa
    db.prepare("DELETE FROM leads WHERE id = ?").run(lead.id);
    lead = null;
  }
  if (!lead) {
    const id = upsertLead({ nome_clinica: "Clínica Simulada", telefone: telefoneFake, cidade: "Belo Horizonte", nicho: "clínica de teste", origem_lista: "simulador" });
    lead = getLead(id);
    salvarMensagem(lead.id, "assistant", aberturaDaCampanha(lead));
    atualizarLead(lead.id, { status: "disparado" });
  }
  if (!texto) return res.json({ lead, mensagens: historicoLead(lead.id, 100) });
  salvarMensagem(lead.id, "user", texto);
  if (lead.status === "disparado") { atualizarLead(lead.id, { status: "respondeu" }); registrarEvento(lead.id, "resposta", "simulador"); }
  await responderLead(lead.id, "SIMULADO");
  res.json({ lead: getLead(lead.id), mensagens: historicoLead(lead.id, 100), reuniao: reuniaoAtivaDoLead(lead.id) || null });
});

// MANUAL de onboarding (PDF que vive junto do codigo, igual pra todo cliente).
// Fica na aba Manual do painel; download direto, sem login (link curto pra
// mandar no WhatsApp durante o onboarding).
app.get("/manual", async (req, res) => {
  const { existsSync } = await import("node:fs");
  const pdf = join(__dirname, "materiais", "Manual-Prospecta-AI.pdf");
  if (!existsSync(pdf)) return res.status(404).send("manual nao disponivel");
  const baixar = String(req.query.download || "") === "1";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${baixar ? "attachment" : "inline"}; filename="Manual-Prospecta-AI.pdf"`);
  res.sendFile(pdf);
});

// apresentacao comercial publica (link que a IA manda pro intermediario/lead)
app.get("/apresentacao", async (req, res) => {
  const { existsSync } = await import("node:fs");
  const pdf = join(DADOS_DIR, "apresentacao.pdf");
  if (!existsSync(pdf)) return res.status(404).send("apresentacao nao configurada");
  // nome do arquivo segue a marca do deploy (cliente = Prospecta; interno = Facilita AI)
  const marcaPdf = (process.env.SDR_MARCA || "Facilita AI").replace(/\s+/g, "-");
  res.setHeader("Content-Disposition", `inline; filename="${marcaPdf}-Apresentacao.pdf"`);
  res.sendFile(pdf);
});

// ============================================================
// NOTAS do lead (follow-up manual, observacoes do vendedor)
// ============================================================
app.get("/api/lead/:id/notas", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM notas WHERE lead_id = ? ORDER BY id DESC").all(req.params.id));
});
// nota com FOTO opcional (print de conversa, cartao, foto da fachada...).
// A imagem fica em dados/anexos e o caminho relativo vai na coluna `anexo`.
app.post("/api/lead/:id/notas", auth, upload.single("foto"), (req, res) => {
  const texto = String(req.body?.texto || "").trim();
  if (!texto && !req.file) return res.status(400).json({ erro: "nota vazia" });
  let anexo = null;
  if (req.file) {
    const ok = /^image\//.test(req.file.mimetype || "");
    if (!ok) { try { unlinkSync(req.file.path); } catch {} return res.status(400).json({ erro: "só aceito imagem" }); }
    const dir = join(DADOS_DIR, "anexos");
    mkdirSync(dir, { recursive: true });
    const ext = (extname(req.file.originalname || "") || ".jpg").toLowerCase();
    const nome = `nota-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`;
    renameSync(req.file.path, join(dir, nome));
    anexo = nome;
  }
  const id = db.prepare("INSERT INTO notas (lead_id, texto, anexo, usuario_id) VALUES (?,?,?,?)")
    .run(req.params.id, texto || "[foto]", anexo, req.usuario?.id || null).lastInsertRowid;
  registrarEvento(Number(req.params.id), "nota", (texto || "foto").slice(0, 60));
  res.json({ ok: true, id, anexo });
});
// serve a foto da nota (auth por query: <img> nao manda header)
app.get("/api/nota-anexo/:arquivo", (req, res) => {
  if (!tokenQueryValido(String(req.query.t || ""))) return res.status(401).end();
  const nome = String(req.params.arquivo).replace(/[^\w.-]/g, ""); // sem path traversal
  const caminho = join(DADOS_DIR, "anexos", nome);
  if (!fsExiste(caminho)) return res.status(404).end();
  res.sendFile(caminho);
});
app.patch("/api/nota/:id", auth, (req, res) => {
  const texto = String(req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ erro: "nota vazia" });
  const n = db.prepare("SELECT id FROM notas WHERE id = ?").get(req.params.id);
  if (!n) return res.status(404).json({ erro: "nota nao existe" });
  db.prepare("UPDATE notas SET texto = ? WHERE id = ?").run(texto, req.params.id);
  res.json({ ok: true });
});
app.delete("/api/nota/:id", auth, (req, res) => {
  const n = db.prepare("SELECT anexo FROM notas WHERE id = ?").get(req.params.id);
  if (n?.anexo) { try { unlinkSync(join(DADOS_DIR, "anexos", n.anexo)); } catch { /* ja sumiu */ } }
  db.prepare("DELETE FROM notas WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
// CRM v2 — usuarios, pipelines/etapas, kanban, telefones, threads
// ============================================================

// ---- usuarios ----
// listar é liberado pra quem vê dashboard (precisa pro seletor "de quem são os
// números" e pra atribuir responsável). Criar/editar continua só pra admin.
app.get("/api/usuarios", auth, exige("ver_dashboard"), (req, res) => res.json(listarUsuarios()));
app.post("/api/usuarios", auth, exige("gerir_usuarios"), (req, res) => {
  const { nome, email, senha, papel } = req.body || {};
  if (!nome || !email || !senha) return res.status(400).json({ erro: "nome, email e senha são obrigatórios" });
  if (!PERMISSOES[papel || "operador"]) return res.status(400).json({ erro: "papel inválido" });
  if (getUsuarioPorEmail(email)) return res.status(409).json({ erro: "já existe usuário com esse email" });
  const id = criarUsuario({ nome, email, senha_hash: sha(senha), papel: papel || "operador" });
  res.json({ ok: true, id });
});
app.patch("/api/usuario/:id", auth, exige("gerir_usuarios"), (req, res) => {
  const campos = { ...req.body };
  if (campos.senha) { campos.senha_hash = sha(campos.senha); delete campos.senha; }
  if (campos.papel && !PERMISSOES[campos.papel]) return res.status(400).json({ erro: "papel inválido" });
  atualizarUsuario(Number(req.params.id), campos);
  res.json({ ok: true });
});
app.delete("/api/usuario/:id", auth, exige("gerir_usuarios"), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.usuario.id) return res.status(400).json({ erro: "não dá pra remover você mesmo" });
  const u = getUsuario(id);
  if (!u) return res.status(404).json({ erro: "usuário não existe" });
  // ?excluir=1 apaga de vez; sem isso só desativa (mantém o vínculo no histórico)
  if (req.query.excluir === "1") {
    const ultimoAdmin = u.papel === "admin" &&
      db.prepare("SELECT COUNT(*) c FROM usuarios WHERE papel='admin' AND ativo=1 AND id <> ?").get(id).c === 0;
    if (ultimoAdmin) return res.status(400).json({ erro: "esse é o último administrador — promova outra pessoa antes" });
    // solta os vínculos (o histórico do lead fica; o dono vira "da empresa")
    const tx = db.transaction(() => {
      db.prepare("UPDATE leads SET usuario_id = NULL WHERE usuario_id = ?").run(id);
      db.prepare("UPDATE pipelines SET usuario_id = NULL WHERE usuario_id = ?").run(id);
      db.prepare("UPDATE instancias SET usuario_id = NULL WHERE usuario_id = ?").run(id);
      db.prepare("UPDATE tarefas SET usuario_id = NULL WHERE usuario_id = ?").run(id);
      db.prepare("UPDATE notas SET usuario_id = NULL WHERE usuario_id = ?").run(id);
      db.prepare("DELETE FROM usuarios WHERE id = ?").run(id);
    });
    tx();
    setConfig(`audio_oficial_u${id}`, ""); // limpa o áudio pessoal
    for (const [tok, s] of sessoes) if (s.usuarioId === id) sessoes.delete(tok); // derruba a sessão dele
    console.log(`[equipe] usuário REMOVIDO: ${u.nome} (${u.email}) por ${req.usuario.nome}`);
    return res.json({ ok: true, removido: u.nome });
  }
  atualizarUsuario(id, { ativo: 0 }); // desativa, nunca apaga (histórico do lead fica)
  for (const [tok, s] of sessoes) if (s.usuarioId === id) sessoes.delete(tok);
  res.json({ ok: true });
});

// ÁUDIO NA CONVERSA: manda um áudio gravado/escolhido pro lead (pausa a IA,
// igual mandar texto pelo painel). Aceita thread paralela.
app.post("/api/lead/:id/audio", auth, exige("conversar"), upload.single("audio"), async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) { if (req.file) unlinkSync(req.file.path); return res.status(404).json({ erro: "lead nao existe" }); }
  if (!req.file) return res.status(400).json({ erro: "arquivo nao veio" });
  try {
    const r = await enviarAudioProLead(req, lead, req.file.path, extDoAudio(req.file), "[áudio enviado]");
    if (!r.ok) return res.status(r.status).json({ erro: r.erro });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  } finally {
    try { unlinkSync(req.file.path); } catch { /* ja removido */ }
  }
});

// ENVIAR O AUDIO OFICIAL do dono (1 clique no painel, sem upload) — o mesmo
// arquivo que a IA manda na acao `audio`, mas disparado pela pessoa.
app.post("/api/lead/:id/audio-oficial", auth, exige("conversar"), async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "lead nao existe" });
  const caminho = audioDoLead(lead);
  if (!caminho || !fsExiste(caminho))
    return res.status(400).json({ erro: "áudio oficial não configurado (Configurações > Áudio)" });
  try {
    let thread = null;
    if (req.body?.thread_id) {
      thread = getThread(Number(req.body.thread_id));
      if (!thread || thread.lead_id !== lead.id) return res.status(400).json({ erro: "thread não é desse lead" });
    }
    const alvo = thread?.telefone || lead.telefone;
    const inst = instanciaDoLead(lead, thread?.instancia_id || null);
    const trava = chipBloqueado(inst, req.usuario);
    if (trava) return res.status(403).json({ erro: trava });
    const simulado = String(alvo).startsWith("0000");
    if (!inst && !simulado) return res.status(502).json({ erro: "nenhum WhatsApp conectado" });
    const ext = extname(caminho).toLowerCase().replace(".", "");
    const mime = ext === "mp3" ? "audio/mpeg" : ext === "m4a" ? "audio/mp4" : "audio/ogg";
    const b64 = readFileSync(caminho).toString("base64");
    const r = simulado ? { ok: true }
      : await enviarMidia(inst.uazapi_token, alvo, { tipo: "audio", arquivo: `data:${mime};base64,${b64}` });
    if (!r.ok) return res.status(502).json({ erro: r.erro });
    if (inst && !thread) fixarChipDoLead(lead.id, inst.id);
    atualizarLead(lead.id, { audio_enviado: 1 }); // a IA nao manda de novo
    const ins = salvarMensagem(lead.id, "assistant", "[áudio oficial enviado]", "audio");
    if (thread) db.prepare("UPDATE mensagens SET thread_id = ? WHERE id = ?").run(thread.id, ins.lastInsertRowid);
    registrarEvento(lead.id, "audio", "áudio oficial enviado pelo painel");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// CONFLITO DE AGENDA: diz se já tem reunião nesse horário (avisa, não bloqueia)
app.get("/api/agenda/conflito", auth, (req, res) => {
  const inicio = String(req.query.inicio || "").slice(0, 16); // AAAA-MM-DDTHH:MM
  if (!inicio) return res.status(400).json({ erro: "falta o horário" });
  const [dia, hora] = inicio.split("T");
  const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  const alvo = min(hora || "00:00");
  const dobradas = db.prepare(`SELECT r.inicio, r.closer, l.nome_clinica FROM reunioes r
    JOIN leads l ON l.id = r.lead_id
    WHERE r.status IN ('marcada','remarcada') AND substr(r.inicio,1,10) = ?`).all(dia)
    .filter((r) => Math.abs(min((r.inicio || "").slice(11, 16)) - alvo) < 60); // menos de 1h de distância
  res.json({ conflito: dobradas.length > 0, reunioes: dobradas });
});

// SAIR: invalida o token desta sessão
app.post("/api/logout", auth, (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  sessoes.delete(token);
  res.json({ ok: true });
});

// ---- pipelines e etapas ----
app.get("/api/pipelines", auth, (req, res) => {
  // SDR so ve funil de prospeccao; closer so ve funil de closer (admin/gestor veem tudo)
  let ps = listarPipelines().filter((p) => funilVisivel(req.usuario, p.tipo));
  // ?minhas=1 -> só os funis desta pessoa (as sem dono aparecem pra todos)
  if (req.query.minhas === "1" && req.usuario?.id)
    ps = ps.filter((p) => !p.usuario_id || p.usuario_id === req.usuario.id);
  else if (req.query.usuario_id)
    ps = ps.filter((p) => p.usuario_id === Number(req.query.usuario_id));
  res.json(ps.map((p) => ({ ...p, etapas: etapasDaPipeline(p.id) })));
});
app.post("/api/pipelines", auth, exige("editar_pipeline"), (req, res) => {
  const { nome, tipo, instancia_id, usuario_id } = req.body || {};
  if (!nome) return res.status(400).json({ erro: "nome obrigatório" });
  if (!["disparo", "ligacao", "closer"].includes(tipo || "disparo")) return res.status(400).json({ erro: "tipo tem que ser disparo, ligacao ou closer" });
  // dono: quem foi indicado, senão quem criou (cada um monta os funis dele)
  const id = criarPipeline({ nome, tipo: tipo || "disparo", instancia_id: instancia_id || null,
    usuario_id: usuario_id || req.usuario?.id || null });
  // vinculo WhatsApp <-> pipeline (o chip do funcionário)
  if (instancia_id) atualizarInstancia(Number(instancia_id), { pipeline_id: id });
  res.json({ ok: true, id, etapas: etapasDaPipeline(id) });
});
app.patch("/api/pipeline/:id", auth, exige("editar_pipeline"), (req, res) => {
  const id = Number(req.params.id);
  atualizarPipeline(id, req.body || {});
  if (req.body?.instancia_id) atualizarInstancia(Number(req.body.instancia_id), { pipeline_id: id });
  res.json({ ok: true });
});
app.delete("/api/pipeline/:id", auth, exige("editar_pipeline"), (req, res) => {
  const id = Number(req.params.id);
  const restantes = listarPipelines().filter((p) => p.id !== id);
  if (!restantes.length) return res.status(400).json({ erro: "precisa sobrar pelo menos uma pipeline" });
  const leads = db.prepare("SELECT COUNT(*) c FROM leads WHERE pipeline_id = ?").get(id).c;
  if (leads) return res.status(400).json({ erro: `essa pipeline tem ${leads} leads — mova eles antes de arquivar` });
  removerPipeline(id);
  res.json({ ok: true });
});
app.post("/api/pipeline/:id/etapas", auth, exige("editar_pipeline"), (req, res) => {
  const { nome, ordem } = req.body || {};
  if (!nome) return res.status(400).json({ erro: "nome da etapa obrigatório" });
  res.json({ ok: true, id: addEtapa(Number(req.params.id), nome, ordem) });
});
// reordenar as etapas (arrastar pelos ⠿ no personalizador de funil)
app.post("/api/pipeline/:id/etapas/ordem", auth, exige("editar_pipeline"), (req, res) => {
  const pid = Number(req.params.id);
  const ordem = Array.isArray(req.body?.ordem) ? req.body.ordem.map(Number) : null;
  if (!ordem?.length) return res.status(400).json({ erro: "falta a ordem das etapas" });
  const daPipe = new Set(etapasDaPipeline(pid).map((e) => e.id));
  if (ordem.some((id) => !daPipe.has(id))) return res.status(400).json({ erro: "etapa que não é desse funil" });
  const tx = db.transaction(() => ordem.forEach((id, i) => atualizarEtapa(id, { ordem: i })));
  tx();
  res.json({ ok: true, etapas: etapasDaPipeline(pid) });
});

app.patch("/api/etapa/:id", auth, exige("editar_pipeline"), (req, res) => {
  // a cor vai parar num atributo style do painel: so aceita #rrggbb
  if (req.body?.cor !== undefined && req.body.cor !== null && !/^#[0-9a-f]{6}$/i.test(String(req.body.cor)))
    return res.status(400).json({ erro: "cor inválida (use #rrggbb)" });
  atualizarEtapa(Number(req.params.id), req.body || {});
  res.json({ ok: true });
});
app.delete("/api/etapa/:id", auth, exige("editar_pipeline"), (req, res) => {
  const id = Number(req.params.id);
  const n = db.prepare("SELECT COUNT(*) c FROM leads WHERE etapa_id = ?").get(id).c;
  if (n) return res.status(400).json({ erro: `essa etapa tem ${n} leads — mova eles antes` });
  removerEtapa(id);
  res.json({ ok: true });
});

// ---- KANBAN ----
app.get("/api/kanban/:pipelineId", auth, (req, res) => {
  const pid = Number(req.params.pipelineId);
  const p = getPipeline(pid);
  if (!p) return res.status(404).json({ erro: "pipeline não existe" });
  // filtro de PERIODO (movimentacao): hoje | ontem | 7d | datas livres
  let desde = null, ate = null;
  const hojeSP = agoraSP().data;
  const diasAtras = (n) => {
    const d = new Date(hojeSP + "T12:00:00"); d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  if (req.query.periodo === "hoje") { desde = hojeSP; ate = hojeSP; }
  else if (req.query.periodo === "ontem") { desde = diasAtras(1); ate = diasAtras(1); }
  else if (req.query.periodo === "7d") { desde = diasAtras(6); ate = hojeSP; }
  else if (req.query.desde && req.query.ate) { desde = String(req.query.desde).slice(0, 10); ate = String(req.query.ate).slice(0, 10); }
  const filtros = {
    nicho: req.query.nicho || null,
    tag: req.query.tag || null,
    usuario_id: req.query.usuario_id ? Number(req.query.usuario_id) : null,
    busca: req.query.busca || null,
    atrasadas: req.query.atrasadas === "1",
    desde, ate,
  };
  const colunas = kanbanDaPipeline(pid, filtros);
  // METRICAS DO FUNIL (nao do sistema inteiro): eventos filtrados pelos leads
  // que estao NESTA pipeline. O topo da aba Pipeline mostra o funil trabalhado.
  const evtPipe = (tipo) => db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo = ? AND l.pipeline_id = ?`).get(tipo, pid).c;
  const ligPipe = (like) => db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo = 'ligacao' AND e.detalhe LIKE ? AND l.pipeline_id = ?`).get(like + "%", pid).c;
  const metricas = p.tipo === "ligacao"
    ? { tipo: "ligacao", ligacoes: evtPipe("ligacao"), atendeu: ligPipe("conectou") + ligPipe("decisor") + ligPipe("reuniao"),
        decisores: ligPipe("decisor") + ligPipe("reuniao"), reunioes: ligPipe("reuniao") }
    : { tipo: "disparo", disparos: evtPipe("disparo"), respostas: evtPipe("resposta"),
        reunioes: evtPipe("reuniao"), optouts: evtPipe("optout") };
  res.json({
    pipeline: p,
    colunas,
    metricas,
    total: colunas.reduce((s, c) => s + c.total, 0),
    valor_total: colunas.reduce((s, c) => s + c.valor_total, 0),
    // opções dos filtros (só o que existe nessa pipeline)
    nichos: db.prepare("SELECT DISTINCT nicho FROM leads WHERE pipeline_id = ? AND nicho IS NOT NULL AND nicho <> '' ORDER BY nicho").all(pid).map((r) => r.nicho),
    tags: db.prepare("SELECT DISTINCT tag_importacao FROM leads WHERE pipeline_id = ? AND tag_importacao IS NOT NULL AND tag_importacao <> '' ORDER BY tag_importacao").all(pid).map((r) => r.tag_importacao),
  });
});

// mover card (entre etapas E entre pipelines). Se cair na entrada de uma pipeline
// de disparo, o lead volta pra fila de envio automaticamente.
app.post("/api/lead/:id/mover", auth, exige("mover_card"), (req, res) => {
  const etapaId = Number(req.body?.etapa_id);
  if (!etapaId) return res.status(400).json({ erro: "falta etapa_id" });
  const antes = getLead(Number(req.params.id));
  const lead = moverLead(Number(req.params.id), etapaId);
  if (!lead) return res.status(404).json({ erro: "etapa não existe" });
  registrarEvento(Number(req.params.id), "moveu", `${req.usuario.nome} → ${lead.status}`);
  registrarMovimento(lead.id, antes?.etapa_id, lead.etapa_id, req.usuario, "kanban");
  res.json({ ok: true, lead });
});

// ---- mover VARIOS de uma vez (modo selecao do Kanban) ----
// Usa o mesmo moverLead do arrastar um card: e ele quem decide status, troca de
// pipeline e a volta pra fila quando o destino e a coluna de entrada de um funil
// de disparo. Aqui so repete em lote, numa transacao so (lead que sumiu no meio
// do caminho e pulado; o resto vai).
app.post("/api/leads/mover", auth, exige("mover_card"), (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  const etapaId = Number(req.body?.etapa_id);
  if (!ids.length) return res.status(400).json({ erro: "nenhum lead selecionado" });
  if (ids.length > 500) return res.status(400).json({ erro: "máximo 500 por vez" });
  if (!etapaId) return res.status(400).json({ erro: "falta etapa_id" });
  // valida a etapa ANTES da transacao: assim nao precisa abortar no meio
  const etapa = db.prepare("SELECT * FROM etapas WHERE id = ?").get(etapaId);
  if (!etapa) return res.status(404).json({ erro: "etapa não existe" });
  // o modal so oferece funil que a pessoa enxerga, mas a API tem que barrar
  // sozinha: em lote, cair na entrada de um funil de disparo reenfileira ate
  // 500 leads pra IA abordar de novo. Fecha aqui.
  const pipeDestino = getPipeline(etapa.pipeline_id);
  if (pipeDestino && !funilVisivel(req.usuario, pipeDestino.tipo))
    return res.status(403).json({ erro: "esse funil não é do teu tipo de acesso" });

  let movidos = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const antes = getLead(id);
      const lead = moverLead(id, etapaId);
      if (!lead) continue;                       // lead apagado nesse meio tempo
      registrarMovimento(id, antes?.etapa_id, lead.etapa_id, req.usuario, "em massa");
      registrarEvento(id, "moveu", `${req.usuario.nome} → ${lead.status} (em massa)`);
      movidos++;
    }
  });
  tx();
  console.log(`[leads] movidos em massa: ${movidos} → etapa ${etapa.nome} (${req.usuario?.nome || "?"})`);
  res.json({ ok: true, movidos, etapa: etapa.nome });
});

// ---- criar lead na mao (sem importar planilha) ----
app.post("/api/leads", auth, exige("editar_lead"), (req, res) => {
  const b = req.body || {};
  const nome = String(b.nome_clinica || "").trim();
  // normaliza JA AQUI: o telefone da empresa é a referência de DDI/DDD pro decisor
  const telefone = normalizarTelefone(b.telefone);
  if (!nome) return res.status(400).json({ erro: "nome da empresa é obrigatório" });
  if (!telefone) return res.status(400).json({ erro: "telefone é obrigatório" });
  const jaExiste = getLeadPorTelefone(telefone);
  if (jaExiste) return res.status(409).json({ erro: `esse telefone já está no CRM (${jaExiste.nome_clinica})`, lead_id: jaExiste.id });

  const id = upsertLead({
    nome_clinica: nome, telefone,
    cidade: b.cidade || null, nicho: b.nicho || null, site: b.site || null,
    origem_lista: b.tag_importacao || "manual",
  });
  // pipeline de destino (default: a primeira) + etapa de entrada
  const pid = Number(b.pipeline_id) || listarPipelines()[0]?.id;
  const etapa = pid ? etapaDeEntrada(pid) : null;
  const campos = {
    tag_importacao: b.tag_importacao || "manual",
    usuario_id: b.usuario_id ? Number(b.usuario_id) : req.usuario.id || null,
    valor_venda: Number(b.valor_venda) || 0,
    nome_contato: b.nome_contato || null,
    google_negocio: b.google_negocio || null,
  };
  db.prepare(`UPDATE leads SET pipeline_id = ?, etapa_id = ?, tag_importacao = ?, usuario_id = ?,
    valor_venda = ?, nome_contato = COALESCE(?, nome_contato), google_negocio = ? WHERE id = ?`)
    .run(pid || null, etapa?.id || null, campos.tag_importacao, campos.usuario_id,
      campos.valor_venda, campos.nome_contato, campos.google_negocio, id);
  addTelefone(id, telefone, "empresa", "Empresa");
  const instLM = instanciaDoLead(getLead(id));
  if (instLM) fixarChipDoLead(id, instLM.id);
  abrirThread(id, telefone, "Empresa", instLM?.id || null); // conversa principal
  if (b.telefone_decisor) {
    const dec = normalizarTelefone(b.telefone_decisor, telefone);
    addTelefone(id, dec, "decisor", b.nome_decisor || "Decisor");
    db.prepare("UPDATE leads SET telefone_decisor = ?, nome_decisor = ? WHERE id = ?").run(dec, b.nome_decisor || null, id);
  }
  // lead manual numa pipeline de DISPARO entra na fila da campanha ativa dela
  if (etapa && b.entrar_na_fila !== false) {
    const camp = db.prepare("SELECT id FROM campanhas WHERE pipeline_id = ? AND status = 'ativa' ORDER BY id LIMIT 1").get(pid);
    if (camp) db.prepare("INSERT OR IGNORE INTO campanha_leads (campanha_id, lead_id) VALUES (?,?)").run(camp.id, id);
  }
  registrarEvento(id, "lead_manual", `criado por ${req.usuario.nome}`);
  res.json({ ok: true, id, lead: getLead(id) });
});

// ---- telefones do lead ----
app.get("/api/lead/:id/telefones", auth, (req, res) => res.json(telefonesDoLead(req.params.id)));
app.post("/api/lead/:id/telefones", auth, exige("editar_lead"), (req, res) => {
  const { numero, tipo, rotulo } = req.body || {};
  if (!numero) return res.status(400).json({ erro: "número obrigatório" });
  const id = addTelefone(Number(req.params.id), numero, tipo || "empresa", rotulo || null);
  if (!id) return res.status(400).json({ erro: "número inválido" });
  res.json({ ok: true, id, telefones: telefonesDoLead(req.params.id) });
});
app.delete("/api/telefone/:id", auth, exige("editar_lead"), (req, res) => {
  removerTelefone(Number(req.params.id));
  res.json({ ok: true });
});
// corrigir numero digitado errado (atualiza lead e threads junto)
app.patch("/api/telefone/:id", auth, exige("editar_lead"), (req, res) => {
  const r = editarTelefone(Number(req.params.id), String(req.body?.numero || ""));
  if (r.erro) return res.status(400).json(r);
  res.json(r);
});

// ---- threads (conversa paralela com o decisor, no MESMO card) ----
app.get("/api/lead/:id/threads", auth, (req, res) => res.json(threadsDoLead(req.params.id)));
// checa se um numero TEM WhatsApp antes de abrir conversa (avisa em vez de
// deixar a pessoa mandar mensagem pro vazio)
app.post("/api/lead/:id/checar-whatsapp", auth, async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "lead nao existe" });
  const tel = normalizarTelefone(String(req.body?.telefone || ""), lead.telefone);
  if (!tel) return res.status(400).json({ erro: "telefone invalido" });
  if (String(tel).startsWith("0000")) return res.json({ tem: true, numero: tel }); // numero de teste
  const inst = instanciaDoLead(lead);
  if (!inst) return res.json({ tem: null, motivo: "nenhum WhatsApp conectado pra checar" });
  const r = await checarWhatsapp(inst.uazapi_token, tel).catch(() => ({ temWhatsapp: null }));
  // numero corrigido pela uazapi (9o digito): grava pra conversa sair certo
  if (r.temWhatsapp && r.numeroCorrigido && r.numeroCorrigido !== tel) {
    const linha = telefonesDoLead(lead.id).find((t) => variantesTelefone(t.numero).includes(tel));
    if (linha) editarTelefone(linha.id, r.numeroCorrigido);
  }
  res.json({ tem: r.temWhatsapp, numero: r.numeroCorrigido || tel });
});
app.post("/api/lead/:id/threads", auth, exige("conversar"), (req, res) => {
  const { telefone, rotulo, minha } = req.body || {};
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "lead não existe" });
  if (!telefone && !minha) return res.status(400).json({ erro: "telefone obrigatório" });
  // a thread sai do MESMO chip do lead (o numero que a empresa dele ja conhece),
  // SALVO com minha=1: sai pelo chip DO USUARIO LOGADO (conversa iniciada por
  // outro socio segue no numero antigo; a nova e SUA, no SEU numero)
  let inst = instanciaDoLead(lead) || null;
  if (minha) {
    const minhas = listarInstancias().filter((i) => i.usuario_id === req.usuario?.id && i.status === "conectado");
    if (!minhas.length) return res.status(400).json({ erro: "você não tem um WhatsApp seu conectado (Configurações > WhatsApps)" });
    inst = minhas[0];
  }
  const tel = normalizarTelefone(telefone || lead.telefone, lead.telefone);
  // rotulo diz O QUE e o numero (nunca o generico "Contato"): empresa, decisor ou o que veio
  const ehEmpresa = variantesTelefone(lead.telefone).includes(tel);
  const ehDecisor = !ehEmpresa && (variantesTelefone(lead.telefone_decisor || "").includes(tel)
    || telefonesDoLead(lead.id).some((t) => t.tipo === "decisor" && variantesTelefone(t.numero).includes(tel)));
  const rot0 = ehEmpresa ? "Empresa"
    : ehDecisor ? ((lead.nome_decisor || "").split(" ")[0] ? `${lead.nome_decisor.split(" ")[0]} (decisor)` : "Decisor")
    : (rotulo && rotulo !== "Contato" ? rotulo : "Outro número");
  // conversa pelo MEU chip ganha o nome do chip no rotulo (da pra ver de qual numero e)
  const rot = minha && inst ? `${rot0} · ${inst.nome}` : rot0;
  // thread criada PELO HUMANO nasce com a IA pausada: quem mandou mensagem
  // primeiro foi voce, a IA so entra se voce devolver pra ela
  const th = abrirThread(lead.id, tel, rot, inst?.id || null, { iaPausada: 1, estrita: Boolean(minha) });
  if (!ehEmpresa) addTelefone(lead.id, tel, ehDecisor ? "decisor" : "outro", rot0); // fica vinculado no card
  res.json({ ok: true, thread: th, chip: inst ? { nome: inst.nome, numero: inst.numero } : null });
});

// ============================================================
// TAREFAS manuais do lead (minhas, fora da IA: ligar pro decisor etc)
// ============================================================
app.get("/api/lead/:id/tarefas", auth, (req, res) => {
  res.json(tarefasDoLead(req.params.id));
});
app.post("/api/lead/:id/tarefas", auth, exige("criar_tarefa"), async (req, res) => {
  const texto = String(req.body?.texto || "").trim();
  if (!texto) return res.status(400).json({ erro: "tarefa vazia" });
  const leadId = Number(req.params.id);
  const quando = String(req.body?.quando || "").trim() || null;
  const hora = String(req.body?.hora || "").trim() || null;
  const tipo = ["followup", "reuniao", "ligacao"].includes(req.body?.tipo) ? req.body.tipo : "followup";
  const usuario_id = req.body?.usuario_id ? Number(req.body.usuario_id) : req.usuario.id || null;
  const id = addTarefa(leadId, texto, quando, { hora, tipo, usuario_id });
  registrarEvento(leadId, "tarefa", `${tipo}: ${texto.slice(0, 50)}`);

  // REUNIAO com data+hora sobe pra agenda conectada do responsável.
  // A agenda e por "closer" (o gcal_email do usuario guarda qual conta ele conectou);
  // sem conexao, a tarefa e criada do mesmo jeito — so nao vai pro Google.
  let agenda = null;
  if (tipo === "reuniao" && quando && hora) {
    try {
      const lead = getLead(leadId);
      const dono = usuario_id ? getUsuario(usuario_id) : req.usuario;
      const closer = (dono?.gcal_email || dono?.nome || "matheus").toLowerCase().split("@")[0].split(" ")[0];
      const { gcalConfigurado, criarEventoMeet } = await import("./lib/gcal.js");
      if (!gcalConfigurado(closer)) {
        agenda = { erro: `tarefa criada. A agenda do ${dono?.nome || closer} ainda não está conectada (aba Reuniões).` };
      } else {
        const ev = await criarEventoMeet(closer, `${quando}T${hora}`, {
          resumo: `${texto} — ${lead?.nome_clinica || "Lead"}`,
          descricao: `Lead: ${lead?.nome_clinica || ""}\nTelefone: ${lead?.telefone || ""}`,
        });
        if (ev?.id) { setTarefaGcal(id, ev.id); agenda = { id: ev.id, meet: ev.meet || null }; }
      }
    } catch (e) {
      console.error("[tarefa] não subiu pra agenda:", e.message); // nunca derruba a tarefa
      agenda = { erro: "tarefa criada, mas a agenda não aceitou o evento" };
    }
  }
  res.json({ ok: true, id, agenda });
});
// alerta de tarefas vencidas/vencendo HOJE (pro toast no canto da tela)
app.get("/api/tarefas/alerta", auth, (req, res) => {
  const hoje = agoraSP().data;
  res.json(db.prepare(`SELECT t.id, t.lead_id, t.texto, t.quando, t.hora, t.tipo, l.nome_clinica,
      CASE WHEN t.quando < ? THEN 'atrasada' ELSE 'vence_hoje' END situacao
    FROM tarefas t JOIN leads l ON l.id = t.lead_id
    WHERE t.feita = 0 AND t.quando IS NOT NULL AND t.quando <= ? AND l.eh_teste = 0
    ORDER BY t.quando ASC LIMIT 30`).all(hoje, hoje));
});
app.patch("/api/tarefa/:id", auth, (req, res) => {
  const b = req.body || {};
  const campos = {};
  if ("feita" in b) campos.feita = b.feita ? 1 : 0;
  if ("texto" in b) {
    const t = String(b.texto || "").trim();
    if (!t) return res.status(400).json({ erro: "tarefa vazia" });
    campos.texto = t;
  }
  if ("quando" in b) campos.quando = String(b.quando || "").trim() || null;
  if ("hora" in b) campos.hora = String(b.hora || "").trim() || null;
  if ("tipo" in b && ["followup", "reuniao", "ligacao"].includes(b.tipo)) campos.tipo = b.tipo;
  if ("usuario_id" in b) campos.usuario_id = b.usuario_id ? Number(b.usuario_id) : null;
  atualizarTarefa(Number(req.params.id), campos);
  res.json({ ok: true });
});
app.delete("/api/tarefa/:id", auth, (req, res) => {
  removerTarefa(Number(req.params.id));
  res.json({ ok: true });
});

// ============================================================
// DASHBOARD (funil + metricas + benchmarks Adriano Aquino)
// ============================================================
// ============================================================
// PERIODO DO DASHBOARD: dias civis de SP. O calendario do painel manda
// ?de=AAAA-MM-DD&ate=AAAA-MM-DD; sem isso vale ?dias=N (ou "hoje").
// As datas passam por regex antes de entrar no SQL, entao inline e seguro.
// ============================================================
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const somaDias = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function janelaDash(req) {
  const hoje = agoraSP().data;
  let de = String(req.query.de || ""), ate = String(req.query.ate || "");
  if (!DATA_RE.test(de) || !DATA_RE.test(ate)) {
    const n = req.query.dias === "hoje" ? 1 : Math.min(366, Math.max(1, Number(req.query.dias) || 30));
    ate = hoje; de = somaDias(hoje, -(n - 1));
  }
  if (de > ate) [de, ate] = [ate, de];
  const dias = Math.round((new Date(ate + "T12:00:00Z") - new Date(de + "T12:00:00Z")) / 864e5) + 1;
  return { de, ate, dias, cond: (col) => `date(${col}, '-3 hours') BETWEEN '${de}' AND '${ate}'` };
}
// soma dos ajustes manuais de uma metrica no periodo. Equipe toda (uid nulo) soma
// tudo; filtro por pessoa soma so os ajustes feitos no numero dela.
const METRICAS_AJUSTAVEIS = ["ligacoes", "atendeu", "decisores", "reunioes", "disparos", "respostas"];
function ajusteMetrica(metrica, J, uid = null) {
  return db.prepare(`SELECT COALESCE(SUM(delta), 0) s FROM ajustes_metrica
    WHERE metrica = ? AND dia BETWEEN ? AND ? ${uid ? "AND usuario_id = ?" : ""}`)
    .get(...[metrica, J.de, J.ate, ...(uid ? [uid] : [])]).s;
}

// SERIE DO GRAFICO: ligacoes x disparos por dia (ou por hora, se o periodo for 1 dia),
// ja com os ajustes manuais somados no dia em que foram feitos.
app.get("/api/dashboard/serie", auth, exige("ver_dashboard"), (req, res) => {
  const J = janelaDash(req);
  const uid = req.query.usuario_id ? Number(req.query.usuario_id) : null;
  const doDono = uid ? ` AND l.id IN (SELECT id FROM leads WHERE usuario_id = ${uid}
    OR pipeline_id IN (SELECT id FROM pipelines WHERE usuario_id = ${uid}))` : "";
  const porDia = db.prepare(`SELECT date(e.criado_em, '-3 hours') d,
      SUM(e.tipo='ligacao') ligacoes, SUM(e.tipo='disparo') disparos
    FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo IN ('ligacao','disparo') AND ${J.cond("e.criado_em")}${doDono} GROUP BY 1`).all();
  const ajustes = db.prepare(`SELECT dia d, metrica, SUM(delta) s FROM ajustes_metrica
    WHERE metrica IN ('ligacoes','disparos') AND dia BETWEEN ? AND ? ${uid ? "AND usuario_id = ?" : ""} GROUP BY dia, metrica`)
    .all(...[J.de, J.ate, ...(uid ? [uid] : [])]);
  const mapa = new Map(porDia.map((r) => [r.d, { ligacoes: r.ligacoes || 0, disparos: r.disparos || 0 }]));
  for (const a of ajustes) {
    const it = mapa.get(a.d) || { ligacoes: 0, disparos: 0 };
    it[a.metrica] += a.s; mapa.set(a.d, it);
  }
  const dias = [];
  for (let d = J.de; d <= J.ate; d = somaDias(d, 1)) dias.push({ d, ...(mapa.get(d) || { ligacoes: 0, disparos: 0 }) });
  let horas = null;
  if (J.dias === 1) {
    const ph = db.prepare(`SELECT CAST(strftime('%H', e.criado_em, '-3 hours') AS INTEGER) h,
        SUM(e.tipo='ligacao') ligacoes, SUM(e.tipo='disparo') disparos
      FROM eventos e JOIN leads l ON l.id = e.lead_id
      WHERE e.tipo IN ('ligacao','disparo') AND ${J.cond("e.criado_em")}${doDono} GROUP BY 1`).all();
    horas = Array.from({ length: 24 }, (_, h) => ({ h, ligacoes: 0, disparos: 0 }));
    for (const r of ph) horas[r.h] = { h: r.h, ligacoes: r.ligacoes || 0, disparos: r.disparos || 0 };
  }
  // ultimas ligacoes contadas (o mesmo evento que o card movido / botao de ligacao gera)
  const ultimas = db.prepare(`SELECT e.lead_id, e.detalhe, e.criado_em, l.nome_clinica
    FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo = 'ligacao' AND ${J.cond("e.criado_em")}${doDono} ORDER BY e.id DESC LIMIT 8`).all();
  const ajustesNoPeriodo = db.prepare(`SELECT metrica, SUM(delta) s FROM ajustes_metrica
    WHERE dia BETWEEN ? AND ? ${uid ? "AND usuario_id = ?" : ""} GROUP BY metrica`).all(...[J.de, J.ate, ...(uid ? [uid] : [])]);
  res.json({ de: J.de, ate: J.ate, dias, horas, ultimas, ajustes: Object.fromEntries(ajustesNoPeriodo.map((a) => [a.metrica, a.s])) });
});

// AJUSTE MANUAL: soma (ou subtrai) um numero numa metrica, num dia. Quem pode
// mexer em funil pode corrigir numero; o resto so ve.
app.post("/api/dashboard/ajuste", auth, exige("editar_pipeline"), (req, res) => {
  const b = req.body || {};
  const metrica = String(b.metrica || "");
  if (!METRICAS_AJUSTAVEIS.includes(metrica)) return res.status(400).json({ erro: "métrica não pode ser ajustada" });
  const dia = DATA_RE.test(String(b.dia || "")) ? String(b.dia) : agoraSP().data;
  const delta = Math.trunc(Number(b.delta));
  if (!delta || Math.abs(delta) > 100000) return res.status(400).json({ erro: "valor do ajuste inválido" });
  const uid = b.usuario_id ? Number(b.usuario_id) : null;
  db.prepare("INSERT INTO ajustes_metrica (dia, metrica, usuario_id, delta, autor_id) VALUES (?,?,?,?,?)")
    .run(dia, metrica, uid, delta, req.usuario?.id || null);
  res.json({ ok: true });
});
app.delete("/api/dashboard/ajuste", auth, exige("editar_pipeline"), (req, res) => {
  const J = janelaDash(req);
  const uid = req.query.usuario_id ? Number(req.query.usuario_id) : null;
  const r = db.prepare(`DELETE FROM ajustes_metrica WHERE dia BETWEEN ? AND ? AND ${uid ? "usuario_id = ?" : "usuario_id IS NULL"}`)
    .run(...[J.de, J.ate, ...(uid ? [uid] : [])]);
  res.json({ ok: true, removidos: r.changes });
});

// ============================================================
// MOVIMENTACOES DO DIA (CRM): quem mexeu em qual lead, de onde pra onde.
// Usa a tabela nova; antes dela existir, cai nos eventos 'moveu' antigos.
// ============================================================
app.get("/api/movimentacoes", auth, (req, res) => {
  const dia = DATA_RE.test(String(req.query.dia || "")) ? String(req.query.dia) : agoraSP().data;
  const pid = req.query.pipeline_id ? Number(req.query.pipeline_id) : null;
  const linhas = db.prepare(`SELECT m.id, m.lead_id, m.de_etapa_id, m.para_etapa_id, m.usuario_nome, m.origem, m.criado_em,
      l.nome_clinica, l.cidade, de.nome de_nome, de.cor de_cor, para.nome para_nome, para.cor para_cor, para.pipeline_id
    FROM movimentacoes m JOIN leads l ON l.id = m.lead_id
      LEFT JOIN etapas de ON de.id = m.de_etapa_id LEFT JOIN etapas para ON para.id = m.para_etapa_id
    WHERE date(m.criado_em, '-3 hours') = ? ${pid ? "AND (para.pipeline_id = ? OR de.pipeline_id = ?)" : ""}
    ORDER BY m.id DESC LIMIT 500`).all(...[dia, ...(pid ? [pid, pid] : [])]);
  // historico antigo (antes da tabela): so o texto do evento
  const antigos = db.prepare(`SELECT e.lead_id, e.detalhe, e.criado_em, l.nome_clinica, l.cidade
    FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo = 'moveu' AND date(e.criado_em, '-3 hours') = ? ${pid ? "AND l.pipeline_id = ?" : ""}
      AND NOT EXISTS (SELECT 1 FROM movimentacoes m WHERE m.lead_id = e.lead_id AND abs(strftime('%s', m.criado_em) - strftime('%s', e.criado_em)) < 3)
    ORDER BY e.id DESC LIMIT 300`).all(...[dia, ...(pid ? [pid] : [])]);
  const ligacoes = db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo = 'ligacao' AND date(e.criado_em, '-3 hours') = ? ${pid ? "AND l.pipeline_id = ?" : ""}`).get(...[dia, ...(pid ? [pid] : [])]).c;
  res.json({ dia, movimentos: linhas, antigos, ligacoes });
});

// ============================================================
// PREFERENCIAS DE TELA por usuario (ordem dos paineis do lead, layout do cartao)
// ============================================================
// FOTO DE PERFIL do usuario (Meu perfil). O painel ja manda recortada 256x256
// em JPEG; aqui so confere tipo/tamanho e guarda em dados/perfis/u<id>.jpg
const PERFIS_DIR = join(DADOS_DIR, "perfis");
mkdirSync(PERFIS_DIR, { recursive: true });
const fotoPerfilDe = (id) => join(PERFIS_DIR, `u${Number(id) || 0}.jpg`);
app.post("/api/eu/foto", auth, upload.single("foto"), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "a foto não veio" });
  const tipoOk = /^image\/(jpeg|png|webp)$/.test(req.file.mimetype || "");
  if (!tipoOk || req.file.size > 2 * 1024 * 1024) {
    try { unlinkSync(req.file.path); } catch { /* ja foi */ }
    return res.status(400).json({ erro: "use uma imagem JPG, PNG ou WebP de até 2 MB" });
  }
  renameSync(req.file.path, fotoPerfilDe(req.usuario?.id));
  res.json({ ok: true });
});
app.delete("/api/eu/foto", auth, (req, res) => {
  try { unlinkSync(fotoPerfilDe(req.usuario?.id)); } catch { /* nao tinha */ }
  res.json({ ok: true });
});
app.get("/api/usuario/:id/foto", (req, res) => {
  if (!tokenQueryValido(req.query.t)) return res.status(401).end();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 0) return res.status(404).end();
  const caminho = fotoPerfilDe(id);
  if (!fsExiste(caminho)) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=60");
  res.sendFile(caminho);
});
app.get("/api/eu/prefs", auth, (req, res) => {
  const u = req.usuario?.id ? db.prepare("SELECT prefs FROM usuarios WHERE id = ?").get(req.usuario.id) : null;
  let p = {}; try { p = JSON.parse(u?.prefs || "{}"); } catch { p = {}; }
  res.json(p);
});
app.post("/api/eu/prefs", auth, (req, res) => {
  if (!req.usuario?.id) return res.json({ ok: false, erro: "login sem usuário: preferência fica só neste navegador" });
  const atual = (() => { try { return JSON.parse(db.prepare("SELECT prefs FROM usuarios WHERE id = ?").get(req.usuario.id)?.prefs || "{}"); } catch { return {}; } })();
  const novo = { ...atual, ...(req.body && typeof req.body === "object" ? req.body : {}) };
  if ("apelido" in novo) novo.apelido = String(novo.apelido || "").trim().slice(0, 24) || null;
  if ("avatar" in novo && !(novo.avatar === "foto" || (Number.isInteger(novo.avatar) && novo.avatar >= 1 && novo.avatar <= 12))) novo.avatar = null;
  const txt = JSON.stringify(novo);
  if (txt.length > 8000) return res.status(400).json({ erro: "preferências grandes demais" });
  db.prepare("UPDATE usuarios SET prefs = ? WHERE id = ?").run(txt, req.usuario.id);
  res.json({ ok: true });
});

// ============================================================
// AUDIOS PRONTOS: gravacoes que a pessoa manda num clique pela conversa
// ============================================================
const AUDIOS_DIR = join(DADOS_DIR, "audios-prontos");
const MIDIA_DIR = join(DADOS_DIR, "midia");
mkdirSync(AUDIOS_DIR, { recursive: true });
mkdirSync(MIDIA_DIR, { recursive: true });
const ARQ_RE = /^[a-z0-9_-]+\.(ogg|mp3|m4a|webm|wav|opus)$/i;
const mimeAudio = (ext) => ({ mp3: "audio/mpeg", m4a: "audio/mp4", webm: "audio/webm", wav: "audio/wav", opus: "audio/ogg" }[ext] || "audio/ogg");
const extDoAudio = (arquivo) => {
  const ext = (extname(arquivo.originalname || "") || "").toLowerCase().replace(".", "");
  if (["ogg", "mp3", "m4a", "webm", "wav", "opus"].includes(ext)) return ext;
  const t = String(arquivo.mimetype || "");
  return t.includes("mpeg") ? "mp3" : t.includes("mp4") || t.includes("aac") ? "m4a" : t.includes("webm") ? "webm" : t.includes("wav") ? "wav" : "ogg";
};
// audio "so meu" (usuario_id preenchido) so existe pro proprio dono
function prontoVisivel(id, req) {
  const a = db.prepare("SELECT * FROM audios_prontos WHERE id = ?").get(Number(id));
  if (!a || (a.usuario_id && a.usuario_id !== req.usuario?.id)) return null;
  return a;
}
app.get("/api/audios-prontos", auth, (req, res) => {
  res.json(db.prepare(`SELECT a.id, a.nome, a.descricao, a.duracao, a.usuario_id, u.nome usuario_nome, a.criado_em
    FROM audios_prontos a LEFT JOIN usuarios u ON u.id = a.usuario_id
    WHERE a.usuario_id IS NULL OR a.usuario_id = ? ORDER BY a.id`).all(req.usuario?.id || 0));
});
app.post("/api/audios-prontos", auth, exige("conversar"), upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "o arquivo de áudio não veio" });
  const nome = String(req.body?.nome || "").trim().slice(0, 80);
  if (!nome) { unlinkSync(req.file.path); return res.status(400).json({ erro: "dá um nome pro áudio" }); }
  const ext = extDoAudio(req.file);
  const arquivo = `pronto-${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`;
  renameSync(req.file.path, join(AUDIOS_DIR, arquivo));
  const r = db.prepare("INSERT INTO audios_prontos (nome, descricao, arquivo, mime, duracao, usuario_id) VALUES (?,?,?,?,?,?)")
    .run(nome, String(req.body?.descricao || "").trim().slice(0, 200) || null, arquivo, mimeAudio(ext),
      Math.max(0, Math.round(Number(req.body?.duracao) || 0)) || null,
      req.body?.so_meu === "1" ? (req.usuario?.id || null) : null);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.patch("/api/audios-prontos/:id", auth, exige("conversar"), (req, res) => {
  const a = prontoVisivel(req.params.id, req);
  if (!a) return res.status(404).json({ erro: "áudio não existe" });
  const nome = req.body?.nome !== undefined ? String(req.body.nome).trim().slice(0, 80) : a.nome;
  if (!nome) return res.status(400).json({ erro: "o nome não pode ficar vazio" });
  const desc = req.body?.descricao !== undefined ? String(req.body.descricao).trim().slice(0, 200) : a.descricao;
  db.prepare("UPDATE audios_prontos SET nome = ?, descricao = ? WHERE id = ?").run(nome, desc || null, a.id);
  res.json({ ok: true });
});
app.delete("/api/audios-prontos/:id", auth, exige("conversar"), (req, res) => {
  const a = prontoVisivel(req.params.id, req);
  if (!a) return res.status(404).json({ erro: "áudio não existe" });
  db.prepare("DELETE FROM audios_prontos WHERE id = ?").run(a.id);
  try { if (ARQ_RE.test(a.arquivo)) unlinkSync(join(AUDIOS_DIR, a.arquivo)); } catch { /* ja nao existia */ }
  res.json({ ok: true });
});
// ouvir: link de navegacao (tag <audio>), entao o token vem em ?t=
app.get("/api/audios-prontos/:id/arquivo", (req, res) => {
  if (!tokenQueryValido(req.query.t)) return res.status(401).send("sem acesso");
  const a = db.prepare("SELECT * FROM audios_prontos WHERE id = ?").get(Number(req.params.id));
  if (!a || !ARQ_RE.test(a.arquivo) || !fsExiste(join(AUDIOS_DIR, a.arquivo))) return res.status(404).send("áudio não existe");
  res.setHeader("Content-Type", a.mime || "audio/ogg");
  res.sendFile(join(AUDIOS_DIR, a.arquivo));
});
// midia salva junto de uma mensagem (audio que o painel mandou)
app.get("/api/midia/:arquivo", (req, res) => {
  if (!tokenQueryValido(req.query.t)) return res.status(401).send("sem acesso");
  const arq = String(req.params.arquivo);
  if (!ARQ_RE.test(arq) || !fsExiste(join(MIDIA_DIR, arq))) return res.status(404).send("não existe");
  res.setHeader("Content-Type", mimeAudio(arq.split(".").pop().toLowerCase()));
  res.sendFile(join(MIDIA_DIR, arq));
});

// manda um arquivo de audio pro lead (gravado no painel, arquivo escolhido ou
// audio pronto). OGG/Opus vai como mensagem de voz (ptt), igual gravar no
// celular; outros formatos vao como audio normal.
async function enviarAudioProLead(req, lead, caminho, ext, rotulo) {
  let thread = null;
  if (req.body?.thread_id) {
    thread = getThread(Number(req.body.thread_id));
    if (!thread || thread.lead_id !== lead.id) return { status: 400, erro: "thread não é desse lead" };
  }
  const alvo = thread?.telefone || lead.telefone;
  const inst = instanciaDoLead(lead, thread?.instancia_id || null);
  const trava = chipBloqueado(inst, req.usuario);
  if (trava) return { status: 403, erro: trava };
  const simulado = String(alvo).startsWith("0000");
  if (!inst && !simulado) return { status: 502, erro: "nenhum WhatsApp conectado pra mandar esse áudio (Configurações > WhatsApp)" };
  const b64 = readFileSync(caminho).toString("base64");
  const voz = ext === "ogg" || ext === "opus";
  const r = simulado ? { ok: true } : await enviarMidia(inst.uazapi_token, alvo, { tipo: voz ? "ptt" : "audio", arquivo: `data:${mimeAudio(ext)};base64,${b64}` });
  if (!r.ok) return { status: 502, erro: `o WhatsApp recusou o áudio: ${r.erro}` };
  // guarda uma copia pra conversa mostrar o player
  const arqMidia = `msg-${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`;
  try { copyFileSync(caminho, join(MIDIA_DIR, arqMidia)); } catch { /* sem copia, so perde o player */ }
  if (inst && !thread) fixarChipDoLead(lead.id, inst.id);
  const ins = salvarMensagem(lead.id, "assistant", rotulo, "audio", arqMidia);
  if (thread) db.prepare("UPDATE mensagens SET thread_id = ? WHERE id = ?").run(thread.id, ins.lastInsertRowid);
  if (!lead.ia_pausada && !thread) { atualizarLead(lead.id, { ia_pausada: 1 }); registrarEvento(lead.id, "handoff", "painel (áudio)"); }
  if (thread && !thread.ia_pausada) db.prepare("UPDATE threads SET ia_pausada = 1 WHERE id = ?").run(thread.id);
  return { ok: true };
}
app.post("/api/lead/:id/audio-pronto", auth, exige("conversar"), async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "lead nao existe" });
  const a = prontoVisivel(req.body?.audio_id, req);
  if (!a || !ARQ_RE.test(a.arquivo) || !fsExiste(join(AUDIOS_DIR, a.arquivo))) return res.status(404).json({ erro: "esse áudio pronto não existe mais" });
  try {
    const r = await enviarAudioProLead(req, lead, join(AUDIOS_DIR, a.arquivo), a.arquivo.split(".").pop().toLowerCase(), `[áudio pronto: ${a.nome}]`);
    if (!r.ok) return res.status(r.status).json({ erro: r.erro });
    registrarEvento(lead.id, "audio", `áudio pronto "${a.nome}" enviado pelo painel`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ============================================================
// FOTO DO LEAD (avatar do card e da tela do lead). Primeiro a foto de perfil do
// WhatsApp do numero do lead (via uazapi, de graca); se nao tiver, a do Google
// Meu Negocio quando existe GOOGLE_PLACES_KEY no .env (cobrada por busca).
// Fica salva em disco e e renovada a cada 7 dias ('sem' tambem tenta de novo
// depois de 7 dias, porque o lead pode colocar foto).
// ============================================================
const PLACES_KEY = process.env.GOOGLE_PLACES_KEY || "";
const FOTOS_DIR = join(DADOS_DIR, "fotos");
mkdirSync(FOTOS_DIR, { recursive: true });
const FOTO_VALIDADE_MS = 7 * 24 * 3600 * 1000;
const fotosLigadas = () => uazapiConfigurada() || Boolean(PLACES_KEY);

async function baixarImagem(url) {
  const img = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!img.ok || !String(img.headers.get("content-type") || "").startsWith("image/")) return null;
  const buf = Buffer.from(await img.arrayBuffer());
  return buf.length > 0 && buf.length < 3_000_000 ? buf : null;
}
async function buscarFotoWhatsapp(lead) {
  // so LE a foto (nao manda nada), entao serve qualquer chip conectado
  const inst = instanciaDoLead(lead)
    || db.prepare("SELECT * FROM instancias WHERE status = 'conectado' AND uazapi_token IS NOT NULL ORDER BY id LIMIT 1").get();
  if (!inst?.uazapi_token) return null;
  for (const tel of [...new Set([lead.telefone, lead.telefone_decisor].filter(Boolean))]) {
    if (String(tel).startsWith("0000")) continue; // lead simulado
    const url = await fotoPerfilWhatsapp(inst.uazapi_token, String(tel).replace(/\D/g, ""));
    if (url) { const buf = await baixarImagem(url).catch(() => null); if (buf) return buf; }
  }
  return null;
}
async function buscarFotoGoogle(lead) {
  if (!PLACES_KEY) return null;
  const q = `${lead.nome_clinica || ""} ${lead.cidade || ""}`.trim();
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": PLACES_KEY, "X-Goog-FieldMask": "places.photos" },
    body: JSON.stringify({ textQuery: q, languageCode: "pt-BR", maxResultCount: 1 }),
    signal: AbortSignal.timeout(10_000),
  });
  const d = await r.json().catch(() => ({}));
  const foto = d?.places?.[0]?.photos?.[0]?.name;
  if (!foto || !/^places\/[\w-]+\/photos\/[\w-]+$/.test(foto)) return null;
  return baixarImagem(`https://places.googleapis.com/v1/${foto}/media?maxWidthPx=160&maxHeightPx=160&key=${encodeURIComponent(PLACES_KEY)}`);
}
// fila: no maximo 2 buscas ao mesmo tempo, com folga entre elas, pra um kanban
// cheio nao disparar centenas de consultas no WhatsApp de uma vez
const buscandoFoto = new Map();
let fotosRodando = 0;
const filaFotos = [];
function proximaFoto() {
  if (fotosRodando >= 2 || !filaFotos.length) return;
  const { lead, ok, falha } = filaFotos.shift();
  fotosRodando++;
  (async () => (await buscarFotoWhatsapp(lead).catch(() => null)) || (await buscarFotoGoogle(lead).catch(() => null)))()
    .then(ok, falha)
    .finally(() => setTimeout(() => { fotosRodando--; proximaFoto(); }, 350));
}
function buscarFotoLead(lead) {
  if (!buscandoFoto.has(lead.id)) {
    const p = new Promise((ok, falha) => { filaFotos.push({ lead, ok, falha }); proximaFoto(); });
    buscandoFoto.set(lead.id, p.then((buf) => {
      const caminho = join(FOTOS_DIR, `${lead.id}.jpg`);
      if (buf) writeFileSync(caminho, buf);
      db.prepare("UPDATE leads SET foto_status = ?, foto_em = datetime('now') WHERE id = ?").run(buf || fsExiste(caminho) ? "ok" : "sem", lead.id);
      return buf;
    }).finally(() => setTimeout(() => buscandoFoto.delete(lead.id), 1000)));
  }
  return buscandoFoto.get(lead.id);
}
const fotoVencida = (lead) => !lead.foto_em || Date.now() - new Date(lead.foto_em.replace(" ", "T") + "Z").getTime() > FOTO_VALIDADE_MS;

app.get("/api/lead/:id/foto", async (req, res) => {
  if (!tokenQueryValido(req.query.t)) return res.status(401).end();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
  const lead = getLead(id);
  if (!lead) return res.status(404).end();
  const caminho = join(FOTOS_DIR, `${id}.jpg`);
  const servir = () => { res.setHeader("Cache-Control", "private, max-age=86400"); res.sendFile(caminho); };
  if (fsExiste(caminho)) {
    if (fotosLigadas() && fotoVencida(lead)) buscarFotoLead(lead).catch(() => {}); // renova por tras, serve a antiga
    return servir();
  }
  if (!fotosLigadas() || (lead.foto_status === "sem" && !fotoVencida(lead))) return res.status(404).end();
  try {
    const buf = await buscarFotoLead(lead);
    if (!buf) return res.status(404).end();
    servir();
  } catch (e) {
    console.error("[foto] falhou:", e.message);
    res.status(404).end();
  }
});

// ============================================================
// INTEGRACOES > META ADS (API de Conversoes). Logica em lib/meta.js.
// O token nunca volta pro navegador: so os 4 ultimos caracteres.
// ============================================================
// contato novo que chamou num chip com "Receber contatos novos" ligado
function criarLeadDeEntrada(telefone, body, inst, anuncio = null) {
  if (naBlocklist(telefone)) return null;
  // chip falando com outro chip nosso nao e lead
  const nossos = listarInstancias().map((i) => String(i.numero || "").replace(/\D/g, "")).filter(Boolean);
  if (nossos.some((n) => variantesTelefone(n).includes(telefone) || variantesTelefone(telefone).includes(n))) return null;
  const funil = getPipeline(inst.funil_novos || inst.pipeline_id || 0);
  const entrada = funil ? etapaDeEntrada(funil.id) : null;
  if (!entrada) { console.log(`[entrada] contato novo em ${inst.nome} ignorado: escolha o funil em Integrações > WhatsApp`); return null; }
  // TETO DIARIO por chip: disparo em massa pro numero do cliente nao vira
  // centenas de leads (nem centenas de respostas da IA na conta de token dele)
  const teto = Number(inst.limite_novos_dia) || 30;
  const hoje = db.prepare(`SELECT COUNT(*) n FROM leads WHERE instancia_id = ? AND tag_importacao = 'Entrou em contato'
    AND date(criado_em, '-3 hours') = date('now', '-3 hours')`).get(inst.id).n;
  if (hoje >= teto) {
    const chaveAviso = `teto_novos_${inst.id}`;
    if (getConfig(chaveAviso, "") !== agoraSP().data) {
      setConfig(chaveAviso, agoraSP().data);
      Promise.resolve().then(() => alertar(`O WhatsApp ${inst.nome} chegou no limite de ${teto} contatos novos hoje. Os próximos ficam de fora até amanhã (dá pra aumentar em Integrações > WhatsApp).`, { usuarioId: inst.usuario_id || null })).catch(() => {});
    }
    console.log(`[entrada] ${inst.nome}: limite de ${teto} contatos novos/dia atingido, ${telefone} ignorado`);
    return null;
  }
  const msg = body?.message || body?.data?.message || body || {};
  const nome = String(msg.senderName || msg.pushName || body?.chat?.name || "").trim().slice(0, 80) || "Novo contato";
  const id = upsertLead({ nome_clinica: nome, telefone, origem_lista: "Entrou em contato" });
  if (!id) return null;
  const iaLigada = inst.ia_novos !== 0;
  db.prepare(`UPDATE leads SET pipeline_id = ?, etapa_id = ?, status = 'respondeu', tag_importacao = 'Entrou em contato',
    origem_tipo = 'quente', instancia_id = ?, usuario_id = COALESCE(?, ?, usuario_id), ia_pausada = ?, aguardando_humano = ?,
    atualizado_em = datetime('now') WHERE id = ?`)
    .run(funil.id, entrada.id, inst.id, inst.usuario_id || null, funil.usuario_id || null, iaLigada ? 0 : 1, iaLigada ? 0 : 1, id);
  if (anuncio) marcarLeadQuente(id, anuncio);
  registrarEvento(id, "entrada", `chamou no WhatsApp ${inst.nome}${anuncio ? " (veio de anúncio)" : ""}`);
  if (!iaLigada) Promise.resolve().then(() => alertar(`Novo contato no WhatsApp ${inst.nome}: ${nome} (${telefone}). Está esperando alguém responder.`, { usuarioId: inst.usuario_id || funil.usuario_id || null })).catch(() => {});
  return getLead(id);
}
function criarLeadDeAnuncio(telefone, anuncio, body, inst) {
  const cfg = configMeta();
  const funil = cfg.funilAnuncio ? getPipeline(cfg.funilAnuncio) : null;
  const entrada = funil ? etapaDeEntrada(funil.id) : null;
  if (!entrada) { console.log("[meta] lead de anúncio ignorado: escolha o funil em Integrações > Meta Ads"); return null; }
  const msg = body?.message || body?.data?.message || body || {};
  const nome = String(msg.senderName || msg.pushName || body?.chat?.name || "").trim().slice(0, 80) || "Lead de anúncio";
  const id = upsertLead({ nome_clinica: nome, telefone, origem_lista: "Anúncio Meta" });
  if (!id) return null;
  marcarLeadQuente(id, anuncio);
  db.prepare(`UPDATE leads SET pipeline_id = ?, etapa_id = ?, status = 'respondeu', tag_importacao = 'Anúncio Meta',
    instancia_id = COALESCE(?, instancia_id), usuario_id = COALESCE(?, usuario_id), ia_pausada = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(funil.id, entrada.id, inst?.id || null, funil.usuario_id || null, cfg.iaAnuncio ? 0 : 1, id);
  registrarEvento(id, "anuncio", anuncio.titulo ? `chegou pelo anúncio: ${anuncio.titulo}` : "chegou por anúncio da Meta");
  return getLead(id);
}
app.get("/api/meta", auth, exige("editar_campanha"), (req, res) => {
  const c = configMeta();
  res.json({
    ativo: c.ativo, pronta: metaPronta(c), pixel: c.pixel, teste: c.teste, waba: c.waba, quais: c.quais,
    funil_anuncio: c.funilAnuncio, ia_anuncio: c.iaAnuncio, mapa: c.mapa,
    token_final: c.token ? c.token.slice(-4) : null,
    eventos: EVENTOS_META, resumo: resumoMeta(), ultimos: ultimosEventosMeta(40),
  });
});
app.post("/api/meta", auth, exige("editar_campanha"), (req, res) => {
  // mandar telefone de lead pra Meta e decisao do cliente: ligar a integracao
  // ou abrir pra TODOS os leads (lista fria inclusa) pede a senha de quem esta logado
  const atual = configMeta(), b = req.body || {};
  const sensivel = (b.ativo === true && !atual.ativo) || (b.quais === "todos" && atual.quais !== "todos");
  if (sensivel) {
    const conf = senhaConfere(req, b.senha);
    if (!conf.ok) return res.status(403).json({ erro: conf.erro, precisa_senha: true });
    registrarEvento(null, "seguranca", `${req.usuario?.nome || "dono"} ${b.ativo === true && !atual.ativo ? "LIGOU a integração com a Meta" : "liberou TODOS os leads para a Meta"}`);
  }
  const { senha, ...semSenha } = b;
  const erros = salvarConfigMeta(semSenha);
  if (erros.length) return res.status(400).json({ erro: erros.join(" · ") });
  res.json({ ok: true });
});
app.post("/api/meta/testar", auth, exige("editar_campanha"), async (req, res) => res.json(await testarConexaoMeta()));
app.post("/api/meta/reenviar/:id", auth, exige("editar_campanha"), (req, res) => res.json({ ok: reenviarEvento(req.params.id) > 0 }));

app.get("/api/dashboard", auth, (req, res) => {
  // periodo em DIAS CIVIS de SP: ?de=AAAA-MM-DD&ate=AAAA-MM-DD (ou ?dias=N/hoje)
  const J = janelaDash(req);
  const dias = J.dias;
  // filtro por pessoa (dono do lead ou da pipeline)
  const uidD = req.query.usuario_id ? Number(req.query.usuario_id) : null;
  const aj = (m) => ajusteMetrica(m, J, uidD);
  const doDonoD = uidD ? ` AND l.id IN (SELECT id FROM leads WHERE usuario_id = ${uidD}
    OR pipeline_id IN (SELECT id FROM pipelines WHERE usuario_id = ${uidD}))` : "";
  const contaEvt = (tipo) => db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo = ? AND ${J.cond("e.criado_em")}${doDonoD}`).get(tipo).c;

  const disparos = contaEvt("disparo") + aj("disparos");
  const respostas = contaEvt("resposta") + aj("respostas");
  const reunioes = contaEvt("reuniao") + aj("reunioes");
  const optouts = contaEvt("optout");
  const followups = contaEvt("followup");
  const decisores = contaEvt("responsavel") + db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo='decisor_contato' AND ${J.cond("e.criado_em")}${doDonoD}`).get().c + aj("decisores");

  // funil por status (foto atual)
  const porStatus = {};
  for (const r of db.prepare(`SELECT l.status, COUNT(*) c FROM leads l WHERE l.eh_teste = 0${doDonoD} GROUP BY l.status`).all()) porStatus[r.status] = r.c;

  // taxas
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const taxaResposta = pct(respostas, disparos);
  const taxaDecisor = pct(decisores, disparos);
  const taxaReuniao = pct(reunioes, respostas);
  const taxaReuniaoDisparo = pct(reunioes, disparos);

  // BENCHMARKS de outbound WhatsApp:
  //  disparo->decisor 8-12% · decisor->reuniao 40-50% · follow->decisor 30-40% · min 40 disparos/dia
  const bench = {
    disparo_decisor: { min: 8, max: 12, atual: taxaDecisor, ok: taxaDecisor >= 8 },
    decisor_reuniao: { min: 40, max: 50, atual: pct(reunioes, decisores), ok: pct(reunioes, decisores) >= 40 },
    disparos_dia: { min: 40, atual: Math.round(disparos / dias), ok: Math.round(disparos / dias) >= 40 },
  };

  // serie diaria (disparos x respostas x reunioes) pros ultimos N dias
  const serie = db.prepare(`
    SELECT date(e.criado_em, '-3 hours') d,
      SUM(e.tipo='disparo') disparos, SUM(e.tipo='resposta') respostas, SUM(e.tipo='reuniao') reunioes
    FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE ${J.cond("e.criado_em")}${doDonoD} GROUP BY 1 ORDER BY d`).all();

  // por instancia (split/rotacao)
  const porWhats = listarInstancias().map((i) => ({ nome: i.nome, disparos_hoje: i.disparos_hoje || 0, cota_dia: i.cota_dia || 0, status: i.status }));

  // motivos de perda
  const motivosPerda = db.prepare("SELECT motivo_perda m, COUNT(*) c FROM leads WHERE status IN ('perdido','descartado') AND motivo_perda IS NOT NULL GROUP BY motivo_perda ORDER BY c DESC LIMIT 6").all();

  res.json({
    dias, de: J.de, ate: J.ate, disparos, respostas, reunioes, optouts, followups, decisores,
    taxaResposta, taxaDecisor, taxaReuniao, taxaReuniaoDisparo,
    porStatus, bench, serie, porWhats, motivosPerda,
    guia: { disparo: BENCH.disparo, followup: BENCH.followup },
    leadsComTarefa: db.prepare("SELECT COUNT(*) c FROM leads WHERE followup_em IS NOT NULL AND ia_pausada = 0").get().c,
  });
});

// ============================================================
// LIGACOES (prospeccao manual) — o SDR registra o resultado de cada ligacao.
// E o que alimenta o funil topo/meio/fundo do dashboard de prospeccao.
// ============================================================
app.post("/api/lead/:id/ligacao", auth, exige("conversar"), (req, res) => {
  const leadId = Number(req.params.id);
  const lead = getLead(leadId);
  if (!lead) return res.status(404).json({ erro: "lead não existe" });
  const resultado = String(req.body?.resultado || "");
  if (!RESULTADOS_LIGACAO.includes(resultado))
    return res.status(400).json({ erro: `resultado tem que ser um de: ${RESULTADOS_LIGACAO.join(", ")}` });

  const obs = String(req.body?.obs || "").trim();
  registrarEvento(leadId, "ligacao", `${resultado}${obs ? " · " + obs : ""}`);
  if (obs) db.prepare("INSERT INTO notas (lead_id, texto, usuario_id) VALUES (?,?,?)")
    .run(leadId, `Ligação: ${obs}`, req.usuario.id || null);

  // move o card sozinho conforme o resultado. Prioridade:
  //   1) mapa configurado na pipeline (clique -> etapa que o usuario escolheu)
  //   2) fallback pelas chaves padrao (conectou/decisor/reuniao/perdido)
  const pipe = lead.pipeline_id ? getPipeline(lead.pipeline_id) : null;
  let etapaAlvo = null;
  if (pipe?.mapa_ligacao) {
    try {
      const mapa = JSON.parse(pipe.mapa_ligacao);
      if (mapa[resultado]) etapaAlvo = db.prepare("SELECT * FROM etapas WHERE id = ? AND pipeline_id = ?").get(Number(mapa[resultado]), pipe.id);
    } catch { /* mapa invalido: cai no padrao */ }
  }
  if (!etapaAlvo && pipe) {
    const chave = { conectou: "conectou", decisor: "decisor", reuniao: "reuniao", recusou: "perdido" }[resultado];
    if (chave) etapaAlvo = db.prepare("SELECT * FROM etapas WHERE pipeline_id = ? AND chave = ?").get(pipe.id, chave);
  }
  if (etapaAlvo) { moverLead(leadId, etapaAlvo.id); registrarMovimento(leadId, lead.etapa_id, etapaAlvo.id, req.usuario, "ligação"); }

  // "NAO ATENDEU (IA DISPARA)": a ligacao ja foi CONTABILIZADA acima; agora o
  // lead vai pro funil de disparo do usuario e entra na fila da campanha — a IA
  // tenta por WhatsApp o que a ligacao nao alcancou. (Mover na mao nao contava
  // a ligacao — por isso o numero de ligacoes ficava baixo nas metricas.)
  let disparo = null;
  if (req.body?.disparar && resultado === "nao_atendeu") {
    const pipeDisparo =
      listarPipelines().find((p) => p.tipo === "disparo" && p.usuario_id === req.usuario?.id) ||
      listarPipelines().find((p) => p.tipo === "disparo");
    if (!pipeDisparo) {
      disparo = { erro: "nenhum funil de disparo existe ainda" };
    } else {
      const etapaEntrada = etapaDeEntrada(pipeDisparo.id);
      const camp = db.prepare("SELECT id, status, nome FROM campanhas WHERE pipeline_id = ? AND status IN ('ativa','pausada') ORDER BY id DESC LIMIT 1").get(pipeDisparo.id);
      db.prepare("UPDATE leads SET pipeline_id = ?, etapa_id = ?, status = 'novo' WHERE id = ?")
        .run(pipeDisparo.id, etapaEntrada?.id || null, leadId);
      if (camp) db.prepare("INSERT OR IGNORE INTO campanha_leads (campanha_id, lead_id) VALUES (?,?)").run(camp.id, leadId);
      registrarEvento(leadId, "ligacao_para_disparo", `nao atendeu -> fila da IA (${pipeDisparo.nome})`);
      disparo = {
        pipeline: pipeDisparo.nome,
        na_fila: Boolean(camp),
        aviso: !camp ? "foi pro funil de disparo, mas ele não tem campanha — cria uma pra IA começar a enviar"
          : camp.status === "pausada" ? `entrou na fila da campanha "${camp.nome}", que está PAUSADA — ativa ela pra sair` : null,
      };
    }
  }
  res.json({ ok: true, lead: getLead(leadId), moveu_para: etapaAlvo?.nome || null, disparo });
});

// ============================================================
// DASHBOARD DE PROSPECCAO (canal LIGACAO) — funil topo/meio/fundo
// contra os Benchmarks de Mercado.
// ============================================================
app.get("/api/dashboard/prospeccao", auth, (req, res) => {
  const J = janelaDash(req);
  const dias = J.dias;
  // FILTRO POR PESSOA: conta só os leads de quem for pedido (usuario_id do lead
  // ou dono da pipeline). Sem filtro = a equipe toda.
  const uid = req.query.usuario_id ? Number(req.query.usuario_id) : null;
  const doDono = uid ? ` AND l.id IN (SELECT id FROM leads WHERE usuario_id = ${uid}
    OR pipeline_id IN (SELECT id FROM pipelines WHERE usuario_id = ${uid}))` : "";
  const conta = (like) => db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo='ligacao' AND e.detalhe LIKE ? AND ${J.cond("e.criado_em")}${doDono}`).get(like + "%").c;
  const aj = (m) => ajusteMetrica(m, J, uid);

  const ligacoes = db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo='ligacao' AND ${J.cond("e.criado_em")}${doDono}`).get().c + aj("ligacoes");
  const naoAtendeu = conta("nao_atendeu");
  const conectou = conta("conectou") + conta("decisor") + conta("reuniao") + aj("atendeu"); // quem falou com alguém
  const decisores = conta("decisor") + conta("reuniao") + aj("decisores");                  // chegou no decisor
  const reunioes = conta("reuniao") + aj("reunioes");
  const recusou = conta("recusou");

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const topo = pct(conectou, ligacoes);      // atendeu / ligou
  const meio = pct(decisores, conectou);     // decisor / conectou
  const fundo = pct(reunioes, decisores);    // reunião / decisor

  const B = BENCH.ligacao;
  const diagnostico = [];
  if (ligacoes >= 10) {
    if (topo < B.topo_conexao_pct.min) diagnostico.push({ nivel: "topo", txt: B.topo_conexao_pct.abaixo, atual: topo, meta: B.topo_conexao_pct.min });
    if (conectou >= 5 && meio < B.meio_decisor_pct.min) diagnostico.push({ nivel: "meio", txt: B.meio_decisor_pct.abaixo, atual: meio, meta: B.meio_decisor_pct.min });
    if (decisores >= 3 && fundo < B.fundo_reuniao_pct.min) diagnostico.push({ nivel: "fundo", txt: B.fundo_reuniao_pct.abaixo, atual: fundo, meta: B.fundo_reuniao_pct.min });
  }

  // série diária + produtividade
  const serie = db.prepare(`SELECT date(e.criado_em, '-3 hours') d, COUNT(*) ligacoes,
      SUM(e.detalhe LIKE 'reuniao%') reunioes, SUM(e.detalhe LIKE 'decisor%' OR e.detalhe LIKE 'reuniao%') decisores
    FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo='ligacao' AND ${J.cond("e.criado_em")}${doDono} GROUP BY 1 ORDER BY d`).all();
  const diasComLigacao = serie.length || 1;
  const porDia = Math.round(ligacoes / diasComLigacao);

  // ranking por pessoa (quem está ligando e convertendo)
  // ranking sempre com a equipe TODA (é o comparativo entre as pessoas)
  const porPessoa = db.prepare(`SELECT COALESCE(u.nome, dono.nome, '—') pessoa, COUNT(*) ligacoes,
      SUM(e.detalhe LIKE 'reuniao%') reunioes
    FROM eventos e LEFT JOIN leads l ON l.id = e.lead_id
      LEFT JOIN usuarios u ON u.id = l.usuario_id
      LEFT JOIN pipelines p ON p.id = l.pipeline_id
      LEFT JOIN usuarios dono ON dono.id = p.usuario_id
    WHERE e.tipo='ligacao' AND ${J.cond("e.criado_em")}
    GROUP BY COALESCE(u.id, dono.id) ORDER BY ligacoes DESC LIMIT 8`).all();

  res.json({
    dias, de: J.de, ate: J.ate, ligacoes, naoAtendeu, conectou, decisores, reunioes, recusou,
    topo, meio, fundo, porDia,
    // quantas ligações o mercado gasta pra 1 reunião vs quantas você gastou
    ligacoesPorReuniao: reunioes ? Math.round(ligacoes / reunioes) : null,
    benchmarks: {
      topo: { atual: topo, meta: B.topo_conexao_pct.min, rotulo: B.topo_conexao_pct.rotulo, ok: topo >= B.topo_conexao_pct.min },
      meio: { atual: meio, meta: B.meio_decisor_pct.min, rotulo: B.meio_decisor_pct.rotulo, ok: meio >= B.meio_decisor_pct.min },
      fundo: { atual: fundo, meta: B.fundo_reuniao_pct.min, ideal: B.fundo_reuniao_pct.ideal, rotulo: B.fundo_reuniao_pct.rotulo, ok: fundo >= B.fundo_reuniao_pct.min },
      volume: { atual: porDia, meta: B.ligacoes_dia.min, ideal: B.ligacoes_dia.ideal, rotulo: B.ligacoes_dia.rotulo, ok: porDia >= B.ligacoes_dia.min },
    },
    mercado: { ligacoes_por_reuniao: B.mercado_ligacoes_por_reuniao },
    // guia do método (rotina, horários de ouro, follow-up) — alimenta os cards do dashboard
    guia: { rotina: BENCH.rotina, horarios: BENCH.horarios_ouro, evitar: BENCH.evitar, followup: BENCH.followup, ligacao: BENCH.ligacao },
    diagnostico, serie, porPessoa,
    usuario_id: uid,
    // fila de trabalho: quem está pra ligar hoje
    aLigar: db.prepare(`SELECT COUNT(*) c FROM leads l JOIN pipelines p ON p.id = l.pipeline_id
      WHERE p.tipo='ligacao' AND l.status IN ('novo','tentativa') AND l.eh_teste=0${doDono}`).get().c,
  });
});

// ============================================================
// DASHBOARD GERAL — junta os dois canais
// ============================================================
app.get("/api/dashboard/geral", auth, (req, res) => {
  const J = janelaDash(req);
  const dias = J.dias;
  // filtro por pessoa (mesma regra do dashboard de prospecção)
  const uid = req.query.usuario_id ? Number(req.query.usuario_id) : null;
  const doDono = uid ? ` AND l.id IN (SELECT id FROM leads WHERE usuario_id = ${uid}
    OR pipeline_id IN (SELECT id FROM pipelines WHERE usuario_id = ${uid}))` : "";
  const evt = (tipo) => db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo=? AND ${J.cond("e.criado_em")}${doDono}`).get(tipo).c;
  const lig = (like) => db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo='ligacao' AND e.detalhe LIKE ? AND ${J.cond("e.criado_em")}${doDono}`).get(like + "%").c;
  const aj = (m) => ajusteMetrica(m, J, uid);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

  // canal DISPARO
  const disparos = evt("disparo") + aj("disparos");
  const respostasD = evt("resposta") + aj("respostas");
  const reunioesD = evt("reuniao");
  // canal LIGACAO
  const ligacoes = db.prepare(`SELECT COUNT(*) c FROM eventos e JOIN leads l ON l.id = e.lead_id
    WHERE e.tipo='ligacao' AND ${J.cond("e.criado_em")}${doDono}`).get().c + aj("ligacoes");
  const reunioesL = lig("reuniao");
  const decisoresL = lig("decisor") + reunioesL + aj("decisores");

  const toques = disparos + ligacoes;
  const reunioes = reunioesD + reunioesL + aj("reunioes");

  // dinheiro: o que está em jogo e o que fechou
  const valor = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN e.e_ganho=1 THEN l.valor_venda END),0) ganho,
      COALESCE(SUM(CASE WHEN e.e_ganho=0 AND e.e_perdido=0 THEN l.valor_venda END),0) aberto,
      COALESCE(SUM(CASE WHEN e.e_perdido=1 THEN l.valor_venda END),0) perdido
    FROM leads l LEFT JOIN etapas e ON e.id = l.etapa_id WHERE l.eh_teste=0${doDono}`).get();

  // por pipeline (quanto cada funil vale) — filtrado pelo dono quando pedido
  const porPipeline = db.prepare(`SELECT p.nome, p.tipo, COUNT(l.id) leads,
      COALESCE(SUM(l.valor_venda),0) valor,
      (SELECT nome FROM usuarios u WHERE u.id = p.usuario_id) dono
    FROM pipelines p LEFT JOIN leads l ON l.pipeline_id = p.id AND l.eh_teste=0
    WHERE p.arquivada=0 ${uid ? `AND (p.usuario_id = ${uid} OR p.usuario_id IS NULL)` : ""}
    GROUP BY p.id ORDER BY valor DESC`).all();

  res.json({
    dias, de: J.de, ate: J.ate,
    canais: {
      disparo: { toques: disparos, respostas: respostasD, reunioes: reunioesD, taxa: pct(reunioesD, disparos) },
      ligacao: { toques: ligacoes, decisores: decisoresL, reunioes: reunioesL, taxa: pct(reunioesL, ligacoes) },
    },
    totais: {
      toques, reunioes, taxaGeral: pct(reunioes, toques),
      toquesPorReuniao: reunioes ? Math.round(toques / reunioes) : null,
    },
    // qual canal está trazendo mais reunião (pra decidir onde investir tempo)
    melhorCanal: reunioesL === reunioesD ? "empate" : (reunioesL > reunioesD ? "ligacao" : "disparo"),
    valor, porPipeline,
    equipe: db.prepare(`SELECT u.nome,
        (SELECT COUNT(*) FROM leads l WHERE l.usuario_id = u.id AND l.eh_teste=0) leads,
        (SELECT COUNT(*) FROM tarefas t WHERE t.usuario_id = u.id AND t.feita=0) tarefas_abertas
      FROM usuarios u WHERE u.ativo=1`).all(),
    mercado: { disparos_por_reuniao: BENCH.disparo.mercado_disparos_por_reuniao, ligacoes_por_reuniao: BENCH.ligacao.mercado_ligacoes_por_reuniao },
  });
});

// ============================================================
// ENTREVISTA (monta o cerebro conversando)
// ============================================================
app.post("/api/entrevista", auth, async (req, res) => {
  try {
    const { entrevistaTurno } = await import("./lib/agente.js");
    const r = await entrevistaTurno(Array.isArray(req.body?.historico) ? req.body.historico : []);
    // persiste os blocos que o entrevistador atualizou
    for (const k of ["treino_geral", "treino_pitch", "treino_objecoes"])
      if (typeof r.campos?.[k] === "string" && r.campos[k].trim()) setConfig(k, r.campos[k]);
    res.json({ mensagem: r.mensagem, campos: Object.keys(r.campos || {}), concluido: Boolean(r.concluido) });
  } catch (e) {
    res.status(500).json({ erro: "IA indisponível: " + e.message });
  }
});

// ============================================================
// CHAVE ANTHROPIC (containers de cliente; interno usa o plano)
// ============================================================
const MODO_IA = process.env.SDR_IA_MODO || "plano";

app.get("/api/chave", auth, (req, res) => {
  res.json({
    modo: MODO_IA,
    configurada: Boolean(getConfig("anthropic_key", "") || (MODO_IA === "api" && process.env.ANTHROPIC_API_KEY)),
    origem: getConfig("anthropic_key", "") ? "painel" : (process.env.ANTHROPIC_API_KEY ? "provisionamento" : "nenhuma"),
    // setado pelo agente quando a Anthropic recusa por saldo/chave; painel mostra o aviso
    sem_saldo: getConfig("anthropic_sem_saldo", "") === "1",
  });
});

app.post("/api/chave", auth, async (req, res) => {
  const chave = String(req.body?.chave || "").trim();
  if (!chave.startsWith("sk-ant-")) return res.status(422).json({ erro: "formato inválido (começa com sk-ant-)" });
  // valida com uma chamada minima na API da Anthropic
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "oi" }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 401) return res.status(422).json({ erro: "chave inválida ou revogada" });
    if (r.status === 400) {
      // 400 de modelo prova autenticacao ok; 400 de workspace e outra historia:
      // chave "vinculada a identidade" exige header extra. Orienta a criar a padrao.
      const corpo = await r.text().catch(() => "");
      if (/workspace-id/i.test(corpo))
        return res.status(422).json({ erro: "essa chave é vinculada a identidade/workspace e não serve aqui. Em console.anthropic.com → API Keys, cria uma chave padrão (Default workspace) e cola de novo." });
    }
    if (r.ok) { /* autenticou */ }
    else if (r.status === 429 || r.status === 402) return res.status(422).json({ erro: "chave sem saldo — recarregue em console.anthropic.com" });
  } catch (e) {
    return res.status(502).json({ erro: "não consegui validar agora: " + e.message });
  }
  setConfig("anthropic_key", chave);
  setConfig("anthropic_sem_saldo", ""); // chave nova validada: limpa o aviso de saldo
  res.json({ ok: true });
});

// tutorial publico de como gerar a chave (pra mandar pro cliente)
app.get("/tutorial-chave", (req, res) => {
  res.type("html").send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Como gerar sua chave de IA</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#14201a;line-height:1.6}h1{color:#166534}ol li{margin-bottom:14px}code{background:#eef1ef;padding:2px 6px;border-radius:4px}.dica{background:#e8f7ee;border-radius:8px;padding:12px 16px;font-size:14px}</style></head><body>
<h1>🔑 Como gerar sua chave de IA (Anthropic)</h1>
<p>Sua IA de prospecção usa a <b>sua</b> conta da Anthropic (a empresa do Claude). Você paga só o que usar: centavos por conversa. Leva 5 minutos:</p>
<ol>
<li>Acesse <a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a> e crie sua conta (pode entrar com Google).</li>
<li>No menu, vá em <b>Billing</b> (Cobrança) e adicione um crédito inicial. <b>US$5 já rodam centenas de conversas.</b></li>
<li>Vá em <b>API Keys</b> → <b>Create Key</b>. Dê um nome (ex: "Prospecta") e clique em criar.</li>
<li><b>Copie a chave</b> (começa com <code>sk-ant-</code>). Ela só aparece uma vez!</li>
<li>Cole a chave no seu painel do Prospecta, em <b>Config → Chave da IA</b>, e clique em validar.</li>
</ol>
<div class="dica">💡 Quando o crédito acabar, a IA para de responder. É só recarregar em Billing que volta na hora. Dica: ative o "auto reload" pra nunca parar.</div>
</body></html>`);
});

// ============================================================
// ASSINATURA (Stripe por link ate automatizar)
// ============================================================
app.get("/api/assinatura", auth, (req, res) => {
  const whats = listarInstancias().length || 1;
  res.json({
    modo: MODO_IA, // so faz sentido em container de cliente
    status: getConfig("assinatura_status", "trial"),
    preco_base: 100, preco_whats: 20,
    whats,
    total: 100 + Math.max(0, whats - 1) * 20,
    link: process.env.STRIPE_LINK || getConfig("stripe_link", ""),
    pausada: getConfig("conta_pausada", "") === "1",
  });
});

// ============================================================
// ADMIN (so funciona no SDR interno da VPS: le os containers dos clientes)
// ============================================================
app.get("/api/admin/clientes", auth, async (req, res) => {
  const { readdirSync, existsSync: ex, readFileSync: rf } = await import("node:fs");
  const BASE = "/root/sdr-clientes";
  if (!ex(BASE)) return res.status(404).json({ erro: "sem clientes aqui (rota exclusiva do interno)" });
  const Database = (await import("better-sqlite3")).default;
  const clientes = [];
  for (const slug of readdirSync(BASE)) {
    const dir = `${BASE}/${slug}`;
    if (!ex(`${dir}/.env`)) continue;
    const envTxt = rf(`${dir}/.env`, "utf8");
    const pega = (k) => (envTxt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1] || "";
    const c = { slug, nome: pega("CLIENTE_NOME") || slug, email: pega("PAINEL_EMAIL"), url: pega("APP_URL"),
      leads: 0, disparos: 0, respostas: 0, reunioes: 0, whats_conectados: 0, pausada: false, erro: null };
    try {
      const cdb = new Database(`${dir}/dados/sdr.db`, { readonly: true, fileMustExist: true });
      c.leads = cdb.prepare("SELECT COUNT(*) c FROM leads WHERE eh_teste = 0").get().c;
      c.disparos = cdb.prepare("SELECT COUNT(*) c FROM eventos WHERE tipo = 'disparo'").get().c;
      c.respostas = cdb.prepare("SELECT COUNT(*) c FROM eventos WHERE tipo = 'resposta'").get().c;
      c.reunioes = cdb.prepare("SELECT COUNT(*) c FROM eventos WHERE tipo = 'reuniao'").get().c;
      try { c.whats_conectados = cdb.prepare("SELECT COUNT(*) c FROM instancias WHERE status = 'conectado'").get().c; } catch {}
      try { c.pausada = cdb.prepare("SELECT valor FROM config WHERE chave = 'conta_pausada'").get()?.valor === "1"; } catch {}
      cdb.close();
    } catch (e) { c.erro = e.message.slice(0, 60); }
    clientes.push(c);
  }
  res.json({ clientes, mrr_estimado: clientes.length * 100 });
});

// ENTRAR NA CONTA de um cliente (suporte/acompanhamento). Devolve a URL da API
// e o token mestre daquele container pro painel trocar de sessao. So no interno
// (esta pasta so existe na VPS) e so pra admin.
app.post("/api/admin/entrar", auth, async (req, res) => {
  if (req.usuario?.papel !== "admin") return res.status(403).json({ erro: "só admin" });
  const { existsSync: ex, readFileSync: rf } = await import("node:fs");
  const slug = String(req.body?.slug || "").replace(/[^a-z0-9-]/g, "");
  const dir = `/root/sdr-clientes/${slug}`;
  if (!slug || !ex(`${dir}/.env`)) return res.status(404).json({ erro: "cliente não encontrado" });
  const envTxt = rf(`${dir}/.env`, "utf8");
  const pega = (k) => (envTxt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1] || "";
  const url = pega("APP_URL"), token = pega("PAINEL_SENHA");
  if (!url || !token) return res.status(500).json({ erro: "container sem APP_URL/PAINEL_SENHA" });
  registrarEvento(null, "admin", `entrou na conta ${slug}`);
  res.json({ ok: true, url, token, nome: pega("CLIENTE_NOME") || slug });
});

// ============================================================
// MARCA (painel troca o nome conforme o deploy: interno vs cliente)
// ============================================================
app.get("/api/marca", (req, res) => {
  res.json({
    produto: process.env.SDR_MARCA || "Prospecta AI",
    cliente: process.env.CLIENTE_NOME || "",
    // fonte da verdade do modo: container de cliente roda com SDR_IA_MODO=api.
    // (antes o painel deduzia pelo NOME do produto — fragil, quebrava se padronizasse a marca)
    interno: MODO_IA !== "api",
    suporte: process.env.SUPORTE_WHATS || "",
    // foto do lead nos cards: WhatsApp (uazapi) e/ou Google Meu Negocio
    fotos: fotosLigadas(),
  });
});

// ============================================================
// TERMOS DE USO + PRIVACIDADE (LGPD)
// ============================================================
const paginaLegal = (titulo, corpo) => `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo} — Prospecta</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#14201a;line-height:1.65;font-size:15px}h1{color:#166534}h2{color:#166534;font-size:17px;margin-top:26px}</style></head><body><h1>${titulo}</h1>${corpo}<p style="margin-top:30px;color:#5f6f66;font-size:13px">Última atualização: agosto de 2026.</p></body></html>`;

app.get("/termos", (req, res) => {
  res.type("html").send(paginaLegal("Termos de Uso", `
<p>Ao usar o Prospecta, você ("Cliente") concorda com estes termos.</p>
<h2>1. O serviço</h2><p>O Prospecta é uma ferramenta de prospecção que envia mensagens via WhatsApp e conduz conversas com apoio de inteligência artificial, sob configuração e responsabilidade do Cliente.</p>
<h2>2. Responsabilidades do Cliente</h2><p>O Cliente é o único responsável: (a) pelas listas de contatos que importa, garantindo base legal para o contato (LGPD, art. 7º); (b) pelo conteúdo das mensagens e do treinamento da IA; (c) pelo número de WhatsApp conectado, ciente de que envio em massa pode violar os termos do WhatsApp e resultar em bloqueio do número, risco que o Cliente assume; (d) pela chave de API de IA e seus custos.</p>
<h2>3. Opt-out obrigatório</h2><p>O sistema honra automaticamente pedidos de descadastro ("pare de mandar"). O Cliente não deve contornar esse mecanismo.</p>
<h2>4. Pagamento</h2><p>Assinatura mensal conforme plano contratado. Inadimplência suspende os disparos, preservando os dados por 30 dias.</p>
<h2>5. Limitação</h2><p>O serviço é fornecido "como está". Não garantimos resultados comerciais, entregabilidade de mensagens ou disponibilidade ininterrupta.</p>
<h2>6. Encerramento</h2><p>O Cliente pode cancelar a qualquer momento. Dados são excluídos definitivamente 30 dias após o cancelamento, salvo obrigação legal.</p>`));
});

app.get("/privacidade", (req, res) => {
  res.type("html").send(paginaLegal("Política de Privacidade (LGPD)", `
<h2>1. Papéis</h2><p>Na operação do Prospecta, o <b>Cliente é o Controlador</b> dos dados pessoais dos contatos que importa e prospecta. O Prospecta atua como <b>Operador</b>, processando esses dados exclusivamente conforme instruções do Cliente (LGPD, arts. 37-39).</p>
<h2>2. Dados tratados</h2><p>Nome, telefone e conteúdo de conversas de contatos comerciais importados pelo Cliente; dados cadastrais do próprio Cliente (email, dados de pagamento).</p>
<h2>3. Finalidade</h2><p>Exclusivamente a prospecção comercial configurada pelo Cliente. Não vendemos nem compartilhamos dados com terceiros, exceto suboperadores necessários ao serviço (infraestrutura de servidor, API de WhatsApp e API de IA).</p>
<h2>4. Direitos dos titulares</h2><p>Pedidos de descadastro são honrados automaticamente e o número entra em lista de bloqueio permanente. Titulares podem solicitar acesso, correção ou exclusão dos seus dados através do Cliente (Controlador) ou pelo nosso contato.</p>
<h2>5. Segurança e retenção</h2><p>Dados isolados por cliente, backups diários criptografados em trânsito, retenção durante a vigência do contrato e por 30 dias após o cancelamento.</p>
<h2>6. Contato do encarregado</h2><p>suporte via WhatsApp/email do Prospecta.</p>`));
});

// o painel mora DENTRO do servidor: o cliente abre o proprio endereco e pronto
// (o painel na Vercel continua funcionando como espelho, apontando via "avancado")
// painel SEM cache: senao o navegador segura a versao antiga depois de um deploy
// e o usuario nao ve as mudancas (aconteceu — nao remover esses headers).
app.get("/", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(join(__dirname, "painel", "index.html"));
});

app.get("/health", (req, res) => res.json({ ok: true, agora: agoraSP() }));

// ---------- DIAGNOSTICO DE ERRO 500 ----------
// Qualquer excecao nao tratada numa rota cai aqui: log completo no journal E
// registro no banco (tabela erros_api), pra achar a causa sem depender de repro.
db.exec(`CREATE TABLE IF NOT EXISTS erros_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rota TEXT, metodo TEXT, usuario TEXT, corpo TEXT,
  mensagem TEXT, stack TEXT,
  criado_em TEXT DEFAULT (datetime('now'))
)`);
app.use((err, req, res, _next) => {
  const dado = {
    rota: req.originalUrl, metodo: req.method,
    usuario: req.usuario?.nome || "?",
    corpo: JSON.stringify(req.body || {}).slice(0, 500),
    mensagem: String(err?.message || err).slice(0, 500),
    stack: String(err?.stack || "").slice(0, 2000),
  };
  console.error(`[500] ${dado.metodo} ${dado.rota} (${dado.usuario}): ${dado.mensagem}\n${dado.stack}`);
  try {
    db.prepare(`INSERT INTO erros_api (rota, metodo, usuario, corpo, mensagem, stack)
      VALUES (@rota, @metodo, @usuario, @corpo, @mensagem, @stack)`).run(dado);
  } catch { /* nunca deixa o log derrubar a resposta */ }
  if (!res.headersSent) res.status(500).json({ erro: dado.mensagem });
});
// promessa rejeitada sem catch (async solto) tambem vai pro log
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e?.stack || e);
  try {
    db.prepare("INSERT INTO erros_api (rota, metodo, mensagem, stack) VALUES ('(async)','-',?,?)")
      .run(String(e?.message || e).slice(0, 500), String(e?.stack || "").slice(0, 2000));
  } catch {}
});
// ultimos erros pra eu consultar do painel/curl: /api/erros?t=<senha>
app.get("/api/erros", (req, res) => {
  if (!tokenQueryValido(String(req.query.t || ""))) return res.status(401).end();
  res.json(db.prepare("SELECT * FROM erros_api ORDER BY id DESC LIMIT 30").all());
});

// na VPS direto: 127.0.0.1 (Caddy local). Em container: BIND_HOST=0.0.0.0
app.listen(PORT, process.env.BIND_HOST || "127.0.0.1", () => {
  console.log(`[sdr] servidor na porta ${PORT}`);
  iniciarWorker();
  iniciarMeta(); // eventos do funil -> API de Conversoes da Meta
});
