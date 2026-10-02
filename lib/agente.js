// Agente SDR — cerebro da conversa.
// Roda o Claude Code headless (`claude -p`) da VPS usando a CONTA/PLANO logado
// (nao a API). O ANTHROPIC_API_KEY e removido do env do processo filho de
// proposito: com ele setado o CLI cobraria na API paga.
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  db, getLead, atualizarLead, salvarMensagem, historicoLead, marcarReuniao,
  reunioesAtivas, getConfig, setConfig, registrarEvento, bloquear, agoraSP, agendarFollowupLead,
  audioDoLead, normalizarTelefone, addTelefone, abrirThread, getThread, getPipeline,
  getUsuario, addTarefa, entregarPraCloser,
} from "./db.js";
import { enviarTexto, enviarMidia, mostrarDigitando } from "./uazapi.js";
import { alertar } from "./telegram.js";
import { criarEventoMeet, apagarEventoMeet } from "./gcal.js";
import { chamarAPI, precisaModeloForte } from "./ia-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EH_FACILITA = !String(process.env.CLIENTE_NOME || "").trim(); // instalacao original
// SDR_PROMPT permite escolher o prompt sem depender do modo de IA (plano vs API)
const ARQ_PROMPT = process.env.SDR_PROMPT || (EH_FACILITA ? "sdr.md" : "sdr-generico.md");
const PROMPT_SDR = readFileSync(join(__dirname, "..", "prompts", ARQ_PROMPT), "utf8");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || ""; // vazio = default do plano

// PERSONA: a IA se identifica como o DONO DO NUMERO que envia (chip do lead);
// sem dono no chip, cai pro dono do funil; ultimo recurso "Matheus".
// Mensagem saindo no numero do Valentino NUNCA pode se apresentar como Matheus.
export function personaDoLead(lead) {
  // 1) COERENCIA COM O QUE JA FOI DITO: se a abertura ja se apresentou com um
  // nome, a IA mantem esse nome nessa conversa (trocar no meio confunde o lead).
  // Cobre o caso do template errado ter saido pelo chip de outra pessoa.
  const abertura = lead?.id
    ? db.prepare("SELECT texto FROM mensagens WHERE lead_id = ? AND role = 'assistant' ORDER BY id LIMIT 1").get(lead.id)?.texto
    : null;
  if (abertura) {
    const limpa = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const t = limpa(abertura);
    for (const u of db.prepare("SELECT nome FROM usuarios WHERE ativo = 1").all()) {
      const nome = limpa(u.nome).split(" ")[0];
      if (nome.length >= 3 && new RegExp(`(^|[^a-z])${nome}([^a-z]|$)`).test(t)) return u.nome;
    }
  }
  // 2) padrao: dono do NUMERO que envia > dono do funil > fallback
  const donoChip = lead?.instancia_id
    ? db.prepare("SELECT usuario_id FROM instancias WHERE id = ?").get(lead.instancia_id)?.usuario_id
    : null;
  const donoFunil = lead?.pipeline_id ? getPipeline(lead.pipeline_id)?.usuario_id : null;
  const dono = donoChip || donoFunil || lead?.usuario_id || null;
  // fallback: em container de CLIENTE nunca pode cair em "Matheus" — usa o
  // primeiro nome do dono da conta (CLIENTE_NOME do provisionamento)
  const fallback = EH_FACILITA
    ? "Matheus"
    : (String(process.env.CLIENTE_NOME || "").trim().split(/\s+/)[0] || "o responsável");
  return (dono ? getUsuario(dono)?.nome : null) || fallback;
}

// DONO do lead (pra rotear o alerta do Telegram): dono do chip > dono do funil.
// Sem isso, aviso de lead do Matheus caia no Telegram do Valentino e vice-versa.
export function donoDoLeadId(lead) {
  const donoChip = lead?.instancia_id
    ? db.prepare("SELECT usuario_id FROM instancias WHERE id = ?").get(lead.instancia_id)?.usuario_id
    : null;
  const donoFunil = lead?.pipeline_id ? getPipeline(lead.pipeline_id)?.usuario_id : null;
  return donoChip || donoFunil || lead?.usuario_id || null;
}

// ---------- horarios de reuniao ----------
// Slots por closer na config: "slots_matheus" = "1,2,3,4,5|10:00,11:00,15:00,16:00"
// (dias da semana | horas). Disponivel = slots dos proximos 7 dias MENOS reunioes ativas.
function slotsDoCloser(closer) {
  const cfg = getConfig(`slots_${closer}`, "1,2,3,4,5|10:00,11:00,15:00,16:00");
  const [diasStr, horasStr] = cfg.split("|");
  const dias = (diasStr || "1,2,3,4,5").split(",").map(Number);
  const horas = (horasStr || "").split(",").map((h) => h.trim()).filter(Boolean);
  return { dias, horas };
}

export function horariosDisponiveis() {
  const closers = ["matheus", "valentino"].filter((c) => getConfig(`closer_${c}_ativo`, "1") === "1");
  const ocupados = new Set(reunioesAtivas().map((r) => `${r.closer}|${r.inicio}`));
  const { data, hora } = agoraSP();
  const hoje = new Date(`${data}T00:00:00`);
  const out = [];
  for (let d = 0; d < 8 && out.length < 12; d++) {
    const dia = new Date(hoje.getTime() + d * 86400_000);
    const diaISO = dia.toISOString().slice(0, 10);
    const dow = ((dia.getDay() + 6) % 7) + 1; // 1=seg..7=dom
    for (const closer of closers) {
      const { dias, horas } = slotsDoCloser(closer);
      if (!dias.includes(dow)) continue;
      for (const h of horas) {
        if (d === 0 && h <= hora) continue; // hoje: so horario futuro (folga implicita)
        const inicio = `${diaISO}T${h}`;
        if (!ocupados.has(`${closer}|${inicio}`)) out.push({ inicio, closer, dow });
      }
    }
  }
  // round-robin leve: ordena por data/hora; em empate de horario alterna closer
  out.sort((a, b) => a.inicio.localeCompare(b.inicio));
  return out.slice(0, 10);
}

const DIAS_PT = { 1: "segunda", 2: "terça", 3: "quarta", 4: "quinta", 5: "sexta", 6: "sábado", 7: "domingo" };

// ---------- treinamento do dono da conta (aba Cérebro do painel) ----------
// Tudo que ele escrever entra no prompt com prioridade MAXIMA sobre o metodo base.
function blocoTreinamento() {
  const secoes = [
    ["Diretrizes gerais (como falar, o que nunca fazer)", getConfig("treino_geral", "")],
    ["Pitch, produto e preço (o que dizer sobre a sua empresa e o que ela vende)", getConfig("treino_pitch", "")],
    ["Objeções e como responder cada uma", getConfig("treino_objecoes", "")],
    ["Exemplo de conversa perfeita (imitar esse estilo)", getConfig("treino_exemplo", "")],
  ].filter(([, v]) => v.trim());
  if (!secoes.length) return "";
  return `\n## TREINAMENTO DO DONO DA CONTA (PRIORIDADE MÁXIMA — quando conflitar com qualquer instrução acima, o que está aqui VENCE)\n` +
    secoes.map(([t, v]) => `\n### ${t}\n${v.trim()}`).join("\n");
}

// nome da EMPRESA do dono: aparece na abordagem automatica do decisor e no titulo
// do evento da agenda. Cliente configura em Configuracoes (empresa_nome); sem
// config, o cliente NAO ganha empresa inventada — o interno segue "Facilita AI".
// como o SDR chama o lead no prompt: "Clínica", "Delivery", "Empresa"...
// (a coluna do banco segue nome_clinica; isso e so o rotulo que a IA le)
function termoLead() {
  return String(getConfig("termo_lead", "") || "").trim() || (EH_FACILITA ? "Clínica" : "Empresa");
}

function empresaNome() {
  const cfg = String(getConfig("empresa_nome", "") || "").trim();
  if (cfg) return cfg;
  return EH_FACILITA ? "Facilita AI" : "";
}

// ---------- montagem do prompt ----------
function montarPrompt(lead, thread = null) {
  const hist = historicoLead(lead.id);
  // marca de qual CANAL e cada mensagem: sem isso a IA lia respostas dadas no
  // numero da empresa como se ja tivesse respondido o decisor (e ficava calada)
  const conversa = hist.map((m) => {
    const quem = m.role === "user" ? "LEAD" : m.role === "assistant" ? "VOCÊ" : "SISTEMA";
    const canal = thread
      ? (m.thread_id === thread.id ? "[com o decisor] " : "[com a recepção] ")
      : "";
    return `${canal}${quem}: ${m.texto}`;
  }).join("\n");
  // ultima mensagem do canal ATUAL (pra IA saber se esta devendo resposta)
  const ultimaDoCanal = thread
    ? db.prepare("SELECT role, texto FROM mensagens WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(thread.id)
    : db.prepare("SELECT role, texto FROM mensagens WHERE lead_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT 1").get(lead.id);

  const horarios = horariosDisponiveis()
    .map((h) => `- ${h.inicio} (${DIAS_PT[h.dow]}) com ${h.closer}`)
    .join("\n") || "- (nenhum horário disponível — colete o melhor horário do lead e use passar_pra_humano)";

  const { data, hora, diaSemana } = agoraSP();

  // NOTAS escritas pela equipe: contexto que so o humano sabe (o que ele
  // descobriu no telefone, combinados, nome de quem atendeu...). A IA le pra
  // nao repetir pergunta ja respondida fora do WhatsApp.
  const notas = db.prepare("SELECT texto, criado_em FROM notas WHERE lead_id = ? ORDER BY id DESC LIMIT 8").all(lead.id);
  const blocoNotas = notas.length
    ? `\n## NOTAS DA EQUIPE (contexto interno, NUNCA cite que existe uma anotacao)\n` +
      notas.reverse().map((n) => `- [${String(n.criado_em).slice(5, 16)}] ${String(n.texto).replace(/\s+/g, " ").slice(0, 300)}`).join("\n") + "\n"
    : "";
  // telefones cadastrados no card (empresa, decisor, outros)
  const tels = db.prepare("SELECT numero, tipo, rotulo FROM telefones WHERE lead_id = ? ORDER BY principal DESC, id").all(lead.id);
  const blocoTels = tels.length
    ? `- Telefones do card: ${tels.map((t) => `${t.numero} (${t.tipo}${t.rotulo ? ": " + t.rotulo : ""})`).join(" · ")}`
    : "";

  // sistema = pedaco FIXO (identico em toda chamada) -> cacheavel
  // usuario = pedaco VOLATIL (lead, hora, conversa) -> muda sempre
  const sistema = `${PROMPT_SDR}
${blocoTreinamento()}`;
  const usuario = `## PERSONA (OBRIGATÓRIO)
Nesta conversa VOCÊ É ${personaDoLead(lead)} — a mensagem sai no número dele. Apresente-se e assine SEMPRE como ${personaDoLead(lead)}, nunca como outro nome (mesmo que o treinamento cite outro diretor como exemplo).

## AGORA
Data/hora em São Paulo: ${data} ${hora} (${DIAS_PT[diaSemana]})

## LEAD
- ${termoLead()}: ${lead.nome_clinica}${lead.cidade ? ` (${lead.cidade})` : ""}
- Nicho: ${lead.nicho || termoLead().toLowerCase()}
- Contato: ${lead.nome_contato || "ainda não sabemos o nome"}
- Atendente (quem responde): ${lead.nome_atendente || "NÃO REGISTRADO — pergunte o nome de quem te atende e registre em nome_atendente"}
- Decisor (responsável): ${lead.nome_decisor || "NÃO REGISTRADO — descubra o nome do responsável e registre em nome_decisor ANTES de pedir o contato"}
- É o responsável? ${lead.eh_responsavel ? "SIM (confirmado)" : "ainda não confirmado"}
- Áudio oficial já enviado? ${lead.audio_enviado ? "SIM (não envie de novo)" : (audioDoLead(lead) ? "não (disponível pra enviar)" : "INDISPONÍVEL: áudio não configurado — NUNCA mencione áudio, conduza tudo por texto")}
- Dor mapeada: ${lead.dor || "nenhuma ainda"}
- Status: ${lead.status}
${blocoTels}
- LINK_APRESENTACAO: ${getConfig("link_apresentacao", "") || "(não configurado — NUNCA mencione link de apresentação)"}
- LINK_SITE: ${getConfig("link_site", EH_FACILITA ? "https://facilitaai-lp.lovable.app" : "") || "(não configurado — se pedirem site/Instagram, ofereça mandar o material por aqui)"}

${blocoNotas}## HORARIOS_DISPONIVEIS
${horarios}

${thread ? `## CANAL ATUAL: CONVERSA DIRETA COM O DECISOR
Você AGORA está falando com ${lead.nome_decisor || thread.rotulo || "o decisor"} no número dele (${thread.telefone}) — NÃO é mais a atendente.
- Você já se apresentou e disse quem passou o contato. NÃO se reapresente.
- Objetivo: 1 pergunta de dor no máximo e já conduzir pra reunião (2 opções de horário).
- Se ele pedir LIGAÇÃO ("me liga", "pode ligar"), responda UMA linha confirmando ("Te ligo em instantes!") E use a ação pedir_ligacao junto.
- As mensagens marcadas VOCÊ incluem a conversa anterior com a atendente — é contexto, a mesma voz sua.
- **ATENÇÃO AO CANAL**: cada linha do histórico diz se foi [com o decisor] ou [com a recepção]. Só conta como "já respondi" o que está marcado [com o decisor]. O que você falou com a recepção o decisor NUNCA leu.
- **Status deste canal**: ${ultimaDoCanal?.role === "user"
    ? `o DECISOR falou por último e está esperando sua resposta — responda AGORA, não retorne ações vazias.`
    : `você falou por último aqui; se não há nada novo a dizer, retorne ações vazias.`}
` : ""}## CONVERSA ATÉ AGORA
${conversa}

Responda com o JSON de ações.`;
  return { sistema, usuario };
}

// ---------- chamada headless ----------
// PROBLEMA DE CHAVE (so no modo api): a Anthropic recusou por saldo/chave invalida.
// Marca a config (painel mostra banner + checklist) e avisa no Telegram UMA vez.
function detectarProblemaChave(saida) {
  if (process.env.SDR_IA_MODO !== "api") return;
  const s = String(saida || "");
  if (!/credit balance|billing|purchase credits|invalid x-api-key|authentication_error/i.test(s)) return;
  if (getConfig("anthropic_sem_saldo", "") === "1") return; // ja avisado
  setConfig("anthropic_sem_saldo", "1");
  registrarEvento(null, "erro", "chave Anthropic sem saldo/invalida — IA parada");
  alertar("⚠️ <b>IA parada: problema na chave Anthropic</b>\nA chave está sem saldo ou foi revogada. Recarregue em console.anthropic.com e salve a chave de novo em Configurações.").catch(() => {});
}
// Alerta de IA quebrada COM FREIO. Em 21/09/26 o binario do claude sumiu na
// troca de VPS e esse aviso saiu a cada poucos minutos por 9 dias: virou ruido,
// o Valentino parou de ler e a IA ficou muda sem ninguem perceber. Agora a mesma
// falha avisa 1x por hora e conta quantas vezes repetiu no intervalo.
const FREIO_ALERTA_MS = 60 * 60 * 1000;
// a assinatura precisa ser CURTA (o stderr do CLI pode vir com megabytes e isso
// aqui vai pro banco de config, lido a cada boot) e ESTAVEL: sem os numeros, pra
// "retry em 3s" e "retry em 7s" contarem como a mesma falha e nao furarem o freio
const assinar = (e) => String(e || "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
async function alertarFalhaIA(msg, assinatura) {
  const agora = Date.now();
  const sig = assinar(assinatura);
  const ultimo = Number(getConfig("alerta_ia_ts", "0")) || 0;
  const mesma = getConfig("alerta_ia_sig", "") === sig;
  const repetiu = Number(getConfig("alerta_ia_n", "0")) || 0;
  if (mesma && agora - ultimo < FREIO_ALERTA_MS) {
    setConfig("alerta_ia_n", String(repetiu + 1));
    return;
  }
  setConfig("alerta_ia_sig", sig);
  setConfig("alerta_ia_ts", String(agora));
  setConfig("alerta_ia_n", "0");
  await alertar(mesma && repetiu
    ? `${msg}\n\n(e mais ${repetiu}x na última hora — segue quebrado)`
    : msg);
}

async function chamarClaude(prompt, ultimaDoLead = "", forcarForte = false) {
  const obj = prompt && typeof prompt === "object";
  // MODO CLIENTE: API Messages direta (sem o overhead do Claude Code CLI, que
  // media 18.768 tokens por chamada — 74% do custo do cliente era isso)
  if (process.env.SDR_IA_MODO === "api") {
    const sistema = obj ? prompt.sistema : "Você é um assistente objetivo. Responda exatamente o que for pedido.";
    const usuario = obj ? prompt.usuario : String(prompt);
    return chamarAPI(sistema, usuario, ultimaDoLead, forcarForte);
  }
  // MODO INTERNO (Matheus/Valentino): segue no `claude -p` do plano, de graça.
  // Objeção na última fala do lead recebe o mesmo lembrete que o modo cliente
  // (senão a IA aceitava a 1ª recusa e encerrava — 7 leads do Valentino em 3 dias)
  let usuarioInt = obj ? prompt.usuario : String(prompt);
  if (obj && precisaModeloForte(ultimaDoLead)) usuarioInt = `## OBJEÇÃO DETECTADA NA ÚLTIMA MENSAGEM DO LEAD
NÃO aceite e NÃO encerre a conversa. Aplique os 3As (Aceitar → Associar com um caso/argumento do TREINAMENTO → devolver UMA pergunta). Só use \`perder\` se esta já for a SEGUNDA recusa clara do lead, ou se a recusa for definitiva/agressiva.

${usuarioInt}`;
  const textoUnico = obj ? `${prompt.sistema}\n\n${usuarioInt}` : usuarioInt;
  return chamarClaudeCLI(textoUnico);
}

function chamarClaudeCLI(prompt) {
  return new Promise((resolve, reject) => {
    // so roda no modo interno: conta/plano logado na VPS, nunca API paga
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const args = ["-p", "--output-format", "json"];
    if (CLAUDE_MODEL) args.push("--model", CLAUDE_MODEL);
    const child = execFile(CLAUDE_BIN, args, {
      env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      detectarProblemaChave(`${stdout || ""}\n${stderr || ""}\n${err?.message || ""}`);
      if (err && !stdout) return reject(err);
      try {
        const out = JSON.parse(stdout);
        const texto = String(out.result ?? out.content ?? stdout);
        // resposta boa depois de um aviso de saldo = cliente recarregou: limpa o flag
        if (!out.is_error && getConfig("anthropic_sem_saldo", "") === "1" &&
            !/credit balance|invalid x-api-key/i.test(texto)) setConfig("anthropic_sem_saldo", "");
        resolve(texto);
      } catch { resolve(String(stdout)); }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// extrai o objeto {"acoes": [...]} mesmo se vier com texto/cerca de codigo em volta
function parseAcoes(saida) {
  const s = String(saida || "");
  const inicio = s.indexOf("{");
  if (inicio === -1) return null;
  for (let fim = s.lastIndexOf("}"); fim > inicio; fim = s.lastIndexOf("}", fim - 1)) {
    try {
      const obj = JSON.parse(s.slice(inicio, fim + 1));
      if (Array.isArray(obj?.acoes)) return obj.acoes;
    } catch { /* tenta fechar antes */ }
  }
  return null;
}

// ---------- execucao das acoes ----------
// Quando a IA acaba de conquistar o NUMERO do decisor (ainda no chat da atendente),
// ela tende a ja cumprimentar o decisor — e essa mensagem sairia pro numero da
// ATENDENTE, em duplicata com a abordagem automatica. Derruba esses textos.
export function filtrarSaudacaoAoDecisor(acoes, lead, thread) {
  if (thread) return acoes; // no canal do decisor a saudacao e legitima
  const cap = acoes.find((a) => a.tipo === "atualizar_lead" && a.campos?.telefone_decisor);
  if (!cap) return acoes;
  const nomeDec = String(cap.campos.nome_decisor || lead.nome_decisor || "").trim().split(/\s+/)[0];
  const pareceProDecisor = (t) => {
    const s = String(t || "");
    if (nomeDec && nomeDec.length >= 3 && new RegExp(`\\b${nomeDec}\\b`, "i").test(s)) return true;
    if (/\b(dr|dra|doutor|doutora)\b\.?/i.test(s)) return true;
    return /me passou (o |seu |teu )?(contato|n[uú]mero)/i.test(s);
  };
  return acoes.filter((a) => {
    if (a.tipo !== "texto" || !pareceProDecisor(a.texto)) return true;
    registrarEvento(lead.id, "guarda", `saudação ao decisor no chat da atendente suprimida: "${String(a.texto).slice(0, 80)}"`);
    return false;
  });
}

async function executarAcoes(lead, acoes, instanceToken, thread = null, opts = {}) {
  acoes = filtrarSaudacaoAoDecisor(acoes, lead, thread);
  // com THREAD (conversa direta com o decisor), tudo sai pro numero DELA
  const alvoTel = thread?.telefone || lead.telefone;
  // ids das bolhas que a PROPRIA IA salvou nesta rodada: a checagem "humano falou
  // depois" precisa ignora-las, senao a 1a bolha da IA derruba a 2a (bug: toda
  // resposta em varias bolhas perdia da segunda em diante como "handoff")
  const idsDaIA = new Set();
  const salvarMsg = (role, texto, tipo) => {
    const r = salvarMensagem(lead.id, role, texto, tipo);
    idsDaIA.add(r.lastInsertRowid);
    if (thread) db.prepare("UPDATE mensagens SET thread_id = ? WHERE id = ?").run(thread.id, r.lastInsertRowid);
    return r;
  };
  // telefone 0000... = lead de SIMULACAO (teste E2E sem WhatsApp real): nada sai pra rede
  const simulado = String(alvoTel).startsWith("0000");
  // se e o 2o bot_detectado, o lead vira perdido e NAO mandamos texto (nao adianta falar com bot)
  const segundoBot = acoes.some((a) => a.tipo === "bot_detectado") && (getLead(lead.id).pedidos_humano || 0) >= 1;
  // HUMANO ASSUMIU NO MEIO? A pausa pode chegar enquanto o Claude pensa (10-30s)
  // ou entre uma bolha e outra — re-checa ANTES de cada envio pra parada ser
  // imediata (sem isso, clicar "assumir" e a IA mandava mensagem mesmo assim).
  const humanoAssumiu = () =>
    Boolean(getLead(lead.id)?.ia_pausada) || (thread ? Boolean(getThread(thread.id)?.ia_pausada) : false);
  // HUMANO FALOU ENQUANTO A IA PENSAVA: se depois do inicio do processamento
  // entrou mensagem NOSSA que a IA nao escreveu (o dono respondeu pelo celular),
  // a resposta dela ficou desatualizada — segura, senao fala por cima.
  const humanoFalouDepois = () => {
    const ult = thread
      ? db.prepare("SELECT id, role FROM mensagens WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(thread.id)
      : db.prepare("SELECT id, role FROM mensagens WHERE lead_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT 1").get(lead.id);
    return Boolean(ult && ult.role === "assistant" && ult.id > (opts.msgIdInicial || 0) && !idsDaIA.has(ult.id));
  };
  for (const acao of acoes) {
    if (segundoBot && acao.tipo === "texto") continue; // 2o bot: nao responde a maquina
    if (["texto", "audio"].includes(acao.tipo) && (humanoAssumiu() || humanoFalouDepois())) {
      registrarEvento(lead.id, "handoff", "IA segurou a resposta: humano falou antes (pelo celular ou painel)");
      return { reprocessar: false }; // sempre devolve o contrato esperado
    }
    if (acao.tipo === "texto" && acao.texto) {
      const r = simulado ? { ok: true } : await enviarTexto(instanceToken, alvoTel, acao.texto);
      if (r.ok) salvarMsg("assistant", acao.texto);
      else { registrarEvento(lead.id, "erro", `envio falhou: ${r.erro}`); await alertar(`⚠️ SDR: falha ao enviar msg pra ${lead.nome_clinica}: ${r.erro}`, { usuarioId: donoDoLeadId(lead) }); }
      if (lead.status === "respondeu") atualizarLead(lead.id, { status: "em_conversa" });
      await new Promise((r2) => setTimeout(r2, 2500 + Math.random() * 2500)); // pausa entre bolhas
    }

    if (acao.tipo === "audio") {
      // ÁUDIO DA PESSOA CERTA: usa o áudio do dono do lead (ou da pipeline dele).
      // Assim o lead do Valentino ouve a voz do Valentino, e o meu ouve a minha.
      const caminho = audioDoLead(lead);
      if (!caminho || !existsSync(caminho)) {
        registrarEvento(lead.id, "erro", "audio oficial nao configurado");
        continue; // o prompt ja mandou texto junto; sem audio configurado segue so no texto
      }
      const b64 = readFileSync(caminho).toString("base64");
      const ext = caminho.split(".").pop().toLowerCase();
      const mime = ext === "mp3" ? "audio/mpeg" : ext === "m4a" ? "audio/mp4" : "audio/ogg";
      const r = simulado ? { ok: true } : await enviarMidia(instanceToken, alvoTel, { tipo: "audio", arquivo: `data:${mime};base64,${b64}` });
      if (r.ok) {
        atualizarLead(lead.id, { audio_enviado: 1 });
        const atual = getLead(lead.id);
        // so vira "Contato c/ decisor" pelo audio se a pessoa REALMENTE confirmou ser responsavel
        if (atual.eh_responsavel && ["respondeu", "em_conversa"].includes(atual.status))
          atualizarLead(lead.id, { status: "decisor" });
        salvarMensagem(lead.id, "assistant", "[🎙️ áudio oficial enviado]", "audio");
        registrarEvento(lead.id, "audio", "audio oficial enviado");
      } else {
        registrarEvento(lead.id, "erro", `audio falhou: ${r.erro}`);
        await alertar(`⚠️ SDR: áudio oficial falhou pra ${lead.nome_clinica}: ${r.erro}`, { usuarioId: donoDoLeadId(lead) });
      }
    }

    if (acao.tipo === "pedir_ligacao") {
      // o decisor pediu LIGACAO: avisa no Telegram e cria tarefa pro dono do funil
      const dono = getPipeline(lead.pipeline_id)?.usuario_id || lead.usuario_id || null;
      const quem = dono ? (getUsuario(dono)?.nome || "") : "";
      const tel = thread?.telefone || lead.telefone_decisor || lead.telefone;
      addTarefa(lead.id, `ligar pro ${lead.nome_decisor || lead.nome_contato || "decisor"} (pediu ligação)`,
        agoraSP().data, { hora: null, tipo: "ligacao", usuario_id: dono });
      await alertar(`📞 PEDIU LIGAÇÃO!\n${lead.nome_clinica}\n${lead.nome_decisor || lead.nome_contato || "decisor"}: ${tel}\nTarefa criada${quem ? " pro " + quem : ""} — liga assim que puder.`, { usuarioId: donoDoLeadId(lead) });
      registrarEvento(lead.id, "pediu_ligacao", tel);
    }

    if (acao.tipo === "atualizar_lead" && acao.campos) {
      const { etapa, ...campos } = acao.campos;
      if (campos.telefone_decisor) campos.telefone_decisor = String(campos.telefone_decisor).replace(/\D/g, "");
      atualizarLead(lead.id, campos);
      if (campos.eh_responsavel) registrarEvento(lead.id, "responsavel", campos.nome_decisor || campos.nome_contato || "");
      // pegou o NUMERO do decisor -> sinaliza (Telegram + fica no card pra abordar)
      if (campos.telefone_decisor) {
        const nomeDec = campos.nome_decisor || campos.nome_contato || null;
        registrarEvento(lead.id, "decisor_contato", campos.telefone_decisor);
        await alertar(`📞 CONTATO DO DECISOR!\n${lead.nome_clinica} (${lead.cidade || "?"})\nResponsável: ${nomeDec || "?"}\nWhatsApp: ${campos.telefone_decisor}\n➡️ a IA já vai chamar ele na segunda conversa do card`, { usuarioId: donoDoLeadId(lead) });
        // ABORDAGEM AUTOMATICA: abre a thread e a propria IA chama o decisor
        abordarDecisor(lead.id, campos.telefone_decisor, nomeDec, instanceToken)
          .catch((e) => registrarEvento(lead.id, "erro", "abordagem do decisor falhou: " + e.message));
      }
      // pipeline automatica. "Contato c/ decisor" quando:
      //  - a pessoa CONFIRMOU ser a responsavel (eh_responsavel=1), OU
      //  - conseguimos o NUMERO do decisor (contato conquistado, mesmo via secretaria).
      // etapa "decisor" sozinha NAO basta (IA pode errar com bot/secretaria).
      const atual = getLead(lead.id);
      const podeMover = !["reuniao_marcada", "compareceu", "trial", "fechado", "perdido", "optout", "descartado"].includes(atual.status);
      if (podeMover) {
        if (etapa === "negociando") atualizarLead(lead.id, { status: "negociando" });
        else if (atual.eh_responsavel || atual.telefone_decisor) atualizarLead(lead.id, { status: "decisor" });
      }
    }

    if (acao.tipo === "marcar_reuniao" && acao.inicio) {
      const closer = acao.closer === "valentino" ? "valentino" : "matheus";
      // Google Calendar do closer: evento com Meet AUTOMATICO (best-effort).
      // Fallback: link fixo da config, se existir. Simulado nunca cria evento real.
      let meet = getConfig(`meet_${closer}`, "");
      let gcalId = null;
      if (!simulado) {
        // convidados: o outro socio SEMPRE recebe o convite (os dois na agenda);
        // e-mails em config `convidados_reuniao` (separados por virgula) entram junto
        const convidados = [
          getConfig(`gcal_email_${closer === "matheus" ? "valentino" : "matheus"}`, ""),
          ...String(getConfig("convidados_reuniao", "") || "").split(",").map((x) => x.trim()),
        ].filter((e) => e && e.includes("@"));
        const ev = await criarEventoMeet(closer, acao.inicio, {
          resumo: `${empresaNome() || personaDoLead(lead)} × ${lead.nome_clinica}`,
          descricao: `Reunião marcada pelo SDR.\nClínica: ${lead.nome_clinica} (${lead.cidade || "?"})\nContato: ${lead.nome_contato || "?"} · ${lead.telefone}\nDor: ${lead.dor || "ver conversa no painel"}`,
          convidados,
        });
        if (ev) { gcalId = ev.eventId; if (ev.meet) meet = ev.meet; }
      }
      const r = marcarReuniao(lead.id, closer, acao.inicio, meet, gcalId);
      if (!r.ok && gcalId) await apagarEventoMeet(closer, gcalId); // corrida: desfaz o evento
      if (r.ok) {
        registrarEvento(lead.id, "reuniao", `${acao.inicio} com ${closer}`);
        // passa o bastao: sai do funil do SDR, entra no funil do closer (reveza
        // entre eles quando ha mais de um). Sem funil de closer, nada muda.
        try {
          const ent = entregarPraCloser(lead.id);
          if (ent) registrarEvento(lead.id, "closer", `entregue pro funil ${ent.pipeline_nome}`);
        } catch (e) { console.warn("[closer] entrega falhou:", e.message); }
        await alertar(`📅 REUNIÃO MARCADA!\n${lead.nome_clinica} (${lead.cidade || "?"})\n${acao.inicio} com ${closer}\nDor: ${lead.dor || "ver conversa"}\nTel: ${lead.telefone}`, { usuarioId: donoDoLeadId(lead) });
        if (meet) {
          const msg = `Aqui o link da nossa conversa: ${meet}\nQualquer coisa antes, é só chamar aqui.`;
          const rr = simulado ? { ok: true } : await enviarTexto(instanceToken, lead.telefone, msg);
          if (rr.ok) salvarMensagem(lead.id, "assistant", msg);
        }
      } else {
        // horario ocupado (corrida): registra e avisa o modelo via mensagem de sistema
        salvarMensagem(lead.id, "sistema", `marcar_reuniao falhou (${r.erro}) — ofereça outro horário da lista`);
        registrarEvento(lead.id, "erro", `reuniao falhou: ${r.erro}`);
        return { reprocessar: true };
      }
    }

    if (acao.tipo === "passar_pra_humano") {
      atualizarLead(lead.id, { ia_pausada: 1 });
      registrarEvento(lead.id, "handoff", acao.motivo || "");
      await alertar(`🙋 SDR passou pra humano: ${lead.nome_clinica}\nMotivo: ${acao.motivo || "?"}\nTel: ${lead.telefone}\n(responda pelo painel ou pelo WhatsApp; IA pausada)`, { usuarioId: donoDoLeadId(lead) });
    }

    // BOT do outro lado: a IA pede humano. 2 pedidos sem humano aparecer = so ha
    // maquina do outro lado -> PERDIDO automatico (nao da pra dar tratamento).
    if (acao.tipo === "bot_detectado") {
      const atual = getLead(lead.id);
      const n = (atual.pedidos_humano || 0) + 1;
      atualizarLead(lead.id, { pedidos_humano: n });
      if (n >= 2) {
        atualizarLead(lead.id, { status: "perdido", ia_pausada: 1, motivo_perda: "só atendimento automático (bot) do outro lado" });
        registrarEvento(lead.id, "perdido", "2 pedidos de humano sem sucesso (bot)");
        // NAO manda mais mensagem (nao adianta falar com bot)
      } else {
        // 1o pedido: manda a mensagem pedindo humano (o texto veio nas outras acoes)
        registrarEvento(lead.id, "bot", `pedido de humano ${n}/2`);
      }
    }

    if (acao.tipo === "descartar") {
      atualizarLead(lead.id, { status: "descartado", motivo_perda: acao.motivo || "descartado pela IA" });
      registrarEvento(lead.id, "descarte", acao.motivo || "");
    }

    if (acao.tipo === "perder") {
      // recusa explicita -> Perdidos + IA cala (nao responde pesquisa/menu que vier depois)
      atualizarLead(lead.id, { status: "perdido", ia_pausada: 1, motivo_perda: acao.motivo || "sem interesse" });
      registrarEvento(lead.id, "perdido", acao.motivo || "sem interesse");
    }

    if (acao.tipo === "agendar_followup") {
      agendarFollowupLead(lead.id, acao.horas, acao.mensagem);
      registrarEvento(lead.id, "followup", `agendado +${acao.horas || 5}h pela IA`);
    }

    if (acao.tipo === "optout") {
      bloquear(lead.telefone, "pediu pra parar");
      atualizarLead(lead.id, { status: "optout", ia_pausada: 1 });
      registrarEvento(lead.id, "optout", "");
    }
  }
  return { reprocessar: false };
}

// ---------- ENTREVISTA: monta o cerebro conversando ----------
const PROMPT_ENTREVISTA = `Você é um consultor que ajuda um empresário a configurar a IA de prospecção dele (um SDR que conversa com leads no WhatsApp). Conduza uma ENTREVISTA curta e amigável, UMA pergunta por vez, pra descobrir: o que a empresa vende e o que resolve; como a IA deve se apresentar (nome/cargo); objetivo da conversa com o lead; preço (o que responder); prova social/caso; objeções comuns e como responder; tom de voz; link de material se houver.

Conforme ele responde, você ESCREVE o cérebro do SDR em 3 blocos de texto (sempre o conteúdo COMPLETO atualizado, não só o novo pedaço):
- treino_geral: quem a IA é/como se apresenta + tom de voz + regras de estilo
- treino_pitch: o que vende, o que resolve, preço, prova social, links, objetivo da conversa
- treino_objecoes: uma objeção por linha no formato "objeção -> como responder"

Quando tiver o essencial (o que vende + objetivo + tom + 1 objeção), pergunte se pode finalizar. Ele confirmando, concluido=true.
Não invente nada: só use o que ele disse. Linguagem simples, brasileira. Nunca use travessão.

FORMATO (responda SOMENTE JSON válido, sem markdown):
{"mensagem":"sua próxima fala/pergunta","campos":{"treino_geral":"...","treino_pitch":"...","treino_objecoes":"..."},"concluido":false}
"campos" leva só os blocos que você atualizou AGORA (pode ser {}).`;

export async function entrevistaTurno(historico) {
  const atual = ["treino_geral", "treino_pitch", "treino_objecoes"]
    .map((k) => `### ${k} (conteúdo atual)\n${getConfig(k, "") || "(vazio)"}`)
    .join("\n\n");
  const conversa = (historico || [])
    .map((m) => `${m.role === "user" ? "EMPRESÁRIO" : "VOCÊ"}: ${m.content}`)
    .join("\n") ||
    "(início — faça a primeira pergunta, dando boas-vindas curtas)";
  const prompt = `${PROMPT_ENTREVISTA}

## CÉREBRO ATUAL
${atual}

## CONVERSA
${conversa}

Responda com o JSON.`;
  const saida = await chamarClaude(prompt);
  const s2 = String(saida || "");
  const ini = s2.indexOf("{");
  for (let fim = s2.lastIndexOf("}"); fim > ini && ini >= 0; fim = s2.lastIndexOf("}", fim - 1)) {
    try {
      const obj = JSON.parse(s2.slice(ini, fim + 1));
      if (obj && typeof obj.mensagem === "string") return obj;
    } catch { /* tenta fechar antes */ }
  }
  return { mensagem: s2.slice(0, 500), campos: {}, concluido: false };
}

// ---------- RESUMO da conversa (cacheado; regenera so se a conversa andou) ----------
export async function resumoDaConversa(leadId) {
  const lead = getLead(leadId);
  if (!lead) return null;
  const hist = historicoLead(leadId, 40);
  const doLead = hist.filter((m) => m.role === "user");
  if (doLead.length < 1) return null; // sem conversa util
  // cache valido se a ultima msg e anterior ao resumo salvo
  const ultimaMsg = hist.length ? hist[hist.length - 1].criado_em : null;
  if (lead.resumo && lead.resumo_em && ultimaMsg && lead.resumo_em >= ultimaMsg) return lead.resumo;

  const conversa = hist.map((m) => `${m.role === "user" ? "LEAD" : "NÓS"}: ${m.texto}`).join("\n");
  const prompt = `Resuma esta conversa de prospecção em 2-4 bullets curtos (o essencial pro vendedor bater o olho e saber o que rolou e o próximo passo). Português, direto, sem enrolação. Comece cada bullet com "• ". Responda SÓ os bullets.\n\n${conversa}`;
  try {
    const saida = await chamarClaude(prompt);
    const resumo = String(saida || "").trim().slice(0, 600);
    if (resumo) db.prepare("UPDATE leads SET resumo = ?, resumo_em = datetime('now') WHERE id = ?").run(resumo, leadId);
    return resumo || null;
  } catch { return lead.resumo || null; }
}

// ---------- entrada principal ----------
// Chamado pelo webhook DEPOIS do debounce. Monta prompt, chama o Claude do plano,
// executa as acoes. Uma tentativa de reprocesso se um horario foi tomado no meio.
// A IA CHAMA O DECISOR sozinha: abre a segunda conversa do card e manda a
// abertura no estilo da casa (saudacao + quem e + quem passou o contato).
// A persona e o DONO DO FUNIL do lead (Matheus nos dele, Valentino nos dele).
export async function abordarDecisor(leadId, telefoneCru, nomeDecisor, instanceToken) {
  const lead = getLead(leadId);
  if (!lead) return;
  const tel = normalizarTelefone(telefoneCru, lead.telefone);
  if (!tel || tel === lead.telefone) return;
  // ja existe conversa com esse numero? nao chama de novo
  const jaTem = db.prepare("SELECT id FROM threads WHERE lead_id = ? AND telefone = ?").get(leadId, tel);
  if (jaTem) return;

  // persona = dono do NUMERO que envia (nunca se apresentar como outro socio)
  const persona = personaDoLead(lead);
  // A cota do chip protege contra DISPARO FRIO em massa. A abordagem do decisor
  // e um contato QUENTE (a recepcao acabou de passar o numero) e sao 1-3 msgs/dia:
  // segurar isso por cota jogava fora o momento mais valioso do funil (3 casos
  // no chip do Valentino em 01/09). Passa sempre; fica so o registro pra auditoria.
  const instEnvio = db.prepare("SELECT * FROM instancias WHERE uazapi_token = ?").get(instanceToken || "") || null;
  if (instEnvio && instEnvio.cota_dia && (instEnvio.disparos_hoje || 0) >= instEnvio.cota_dia)
    registrarEvento(leadId, "decisor_acima_cota", `abordagem do decisor com a cota do chip ${instEnvio.nome} já batida (${instEnvio.disparos_hoje}/${instEnvio.cota_dia}) — enviada mesmo assim`);
  const nomeDecCompleto = nomeDecisor || lead.nome_decisor || null;
  // primeiro nome SEM o titulo: "Dr Carlos" -> "Carlos" (saia "Bom dia Dr, tudo certo?")
  const primeiroNome = (s) => String(s || "").replace(/^\s*(dr|dra|doutor|doutora|sr|sra|prof)\.?\s+/i, "").trim().split(/\s+/)[0] || null;
  const decisor = primeiroNome(nomeDecCompleto);
  // atendente = quem passou o contato; nunca usar o proprio nome do decisor aqui
  const atendenteCompleto = lead.nome_atendente ||
    (lead.nome_contato && lead.nome_contato !== nomeDecCompleto ? lead.nome_contato : null);
  const atendente = primeiroNome(atendenteCompleto);

  addTelefone(leadId, tel, "decisor", nomeDecCompleto || "Decisor");
  const th = abrirThread(leadId, tel, decisor ? `${decisor} (decisor)` : "Decisor", lead.instancia_id || null);
  atualizarLead(leadId, { nome_decisor: nomeDecCompleto });

  const h = agoraSP().hora;
  const sauda = h < "12:00" ? "Bom dia" : h < "18:00" ? "Boa tarde" : "Boa noite";
  const msgs = [
    `${sauda}${decisor ? " " + decisor : ""}, tudo certo contigo?`,
    `Me chamo ${persona}${empresaNome() ? `, sou da ${empresaNome()}` : ""}. ${atendente ? `A ${atendente} da ${lead.nome_clinica} me passou teu contato` : `Me passaram teu contato na ${lead.nome_clinica}`}, disseram que é contigo que eu falo. Consigo te explicar o motivo em 1 minuto?`,
  ];
  const simulado = String(tel).startsWith("0000");
  for (const m of msgs) {
    const r = simulado ? { ok: true } : await enviarTexto(instanceToken, tel, m);
    if (!r.ok) { registrarEvento(leadId, "erro", `abordagem decisor falhou: ${r.erro}`); return; }
    const ins = salvarMensagem(leadId, "assistant", m);
    db.prepare("UPDATE mensagens SET thread_id = ? WHERE id = ?").run(th.id, ins.lastInsertRowid);
    await new Promise((r2) => setTimeout(r2, 2500 + Math.random() * 2000));
  }
  registrarEvento(leadId, "decisor_abordado", tel);
  if (!simulado && instEnvio) db.prepare("UPDATE instancias SET disparos_hoje = disparos_hoje + 1 WHERE id = ?").run(instEnvio.id);
  await alertar(`🤖➡️📞 IA chamou o decisor da ${lead.nome_clinica} (${tel}) como ${persona}. A conversa segue na aba do card.`, { usuarioId: donoDoLeadId(lead) });
}

export async function responderLead(leadId, instanceToken, opts = {}) {
  const lead = getLead(leadId);
  if (!lead || lead.ia_pausada) return;
  const thread = opts.threadId ? getThread(opts.threadId) : null;
  if (thread?.ia_pausada) return; // thread pausada: humano no comando ali
  // MARCO: ultima mensagem ANTES de a IA comecar a pensar. Se aparecer mensagem
  // nossa depois disso, foi o humano pelo celular — a IA nao fala por cima.
  const marco = (thread
    ? db.prepare("SELECT id FROM mensagens WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(thread.id)
    : db.prepare("SELECT id FROM mensagens WHERE lead_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT 1").get(leadId))?.id || 0;

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    let saida;
    try {
      // ultima fala do lead decide o modelo: script normal = Haiku (barato),
      // objecao de verdade = Sonnet (raro, medido em <6% das mensagens)
      const ultimaLead = (thread
        ? db.prepare("SELECT texto FROM mensagens WHERE thread_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(thread.id)
        : db.prepare("SELECT texto FROM mensagens WHERE lead_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(leadId))?.texto || "";
      // com o DECISOR na linha, vale o modelo forte (config ia_forte_no_decisor, padrao 1):
      // e onde a conversa deixa de ser script e a reuniao e ganha ou perdida
      const forteNoDecisor = Boolean(thread) && getConfig("ia_forte_no_decisor", "1") === "1";
      saida = await chamarClaude(montarPrompt(getLead(leadId), thread), ultimaLead, forteNoDecisor);
    } catch (e) {
      registrarEvento(leadId, "erro", `claude falhou: ${e.message}`);
      // mensagem certa pra cada mundo: cliente cuida da chave, interno do login
      await alertarFalhaIA(process.env.SDR_IA_MODO === "api"
        ? `🔴 SDR: a IA falhou (${e.message}). Confere a chave da Anthropic em Configurações.`
        : `🔴 SDR: Claude da VPS falhou (${e.message}). Verifica se a conta está logada (claude /login).`, e.message);
      return;
    }
    const acoes = parseAcoes(saida);
    if (!acoes) {
      registrarEvento(leadId, "erro", `saida sem JSON: ${String(saida).slice(0, 200)}`);
      if (tentativa === 0) continue; // segunda chance
      await alertar(`⚠️ SDR: resposta da IA sem JSON pra ${lead.nome_clinica} (lead ${leadId}). Ver logs.`, { usuarioId: donoDoLeadId(lead) });
      return;
    }
    const { reprocessar } = await executarAcoes(getLead(leadId), acoes, instanceToken, thread, { msgIdInicial: marco });
    if (!reprocessar) return;
  }
}
