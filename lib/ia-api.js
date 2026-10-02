// Chamada DIRETA à API Messages da Anthropic — usada só no modo cliente (SaaS).
//
// Por que existe: o modo cliente chamava `claude -p` (Claude Code CLI), que
// carrega o system prompt do CLI + as definicoes de todas as ferramentas dele
// (ler arquivo, bash, editar codigo) que o SDR NUNCA usa. Medido em 02/09/26:
// 18.768 tokens de overhead por chamada, contra 6.492 do prompt real do SDR —
// 74% do que o cliente pagava era lixo. Custava US$ 0,058 por resposta.
//
// Aqui vai so o que o SDR precisa, com duas economias em cima:
//   1. HAIKU por padrao (script de prospeccao e repetitivo; nao precisa de mais)
//      e SONNET so quando o lead traz objecao de verdade — que e raro (medido:
//      menos de 6% das mensagens, e a maioria disso e autoresposta de clinica).
//   2. PROMPT CACHING no bloco fixo (prompt base + cerebro do cliente): esse
//      pedaco e identico em toda chamada, entao vai cacheado a 10% do preco.
import { getConfig, setConfig, registrarEvento } from "./db.js";
import { alertar } from "./telegram.js";

const API = "https://api.anthropic.com/v1/messages";
// modelos: o barato faz o trabalho do dia a dia, o forte entra so na objecao.
// Da pra trocar por config no painel sem mexer no codigo.
const MODELO_PADRAO = () => getConfig("ia_modelo_padrao", "") || "claude-haiku-4-5";
const MODELO_FORTE = () => getConfig("ia_modelo_forte", "") || "claude-sonnet-5";

// ---------- detector de objeção ----------
// So escala pro modelo forte quando a ULTIMA mensagem do lead e realmente uma
// objecao de venda. Autoresposta de clinica ("Somos do DR. EXAME", "informe sua
// duvida") e longa mas NAO e objecao — por isso a lista de exclusao vem antes.
const AUTORESPOSTA = new RegExp([
  "atendimento humanizado", "hor[áa]rio de (atendimento|funcionamento)",
  "em breve (um|nosso)", "assim que poss[íi]vel", "para agilizar", "nosso setor",
  "estamos com alta demanda", "mensagem autom[áa]tica", "aguarde", "protocolo",
  "n[uú]mero de atendimento", "atendimento foi encerrado", "falta de interatividade",
  // saudacao/boas-vindas da recepcao: longa, mas nao e objecao nenhuma
  "seja (muito )?bem[- ]vindo", "que bom ter voc[êe]", "como (posso|podemos) (te )?ajudar",
  "sou (a )?(secret[áa]ria|atendente|recepcionista)", "canal de atendimento",
  "agradece (o )?(seu|pelo) contato", "informa[çc][õo]es importantes",
].join("|"), "i");

const OBJECAO = new RegExp([
  // preço
  "\\b(car[oa]|caro demais|sal[gt]ad[oa]|pre[çc]o alto|acima do (or[çc]amento|meu))\\b",
  "\\b(quanto (custa|fica|sai|é)|qual o (valor|pre[çc]o|investimento))\\b",
  "\\b(sem (or[çc]amento|verba|condi[çc][õo]es)|n[ãa]o tenho (dinheiro|verba|como pagar))\\b",
  // já tem / concorrente
  "\\b(j[áa] (tenho|temos|uso|usamos|trabalho|trabalhamos|fa[çc]o|fechei) )",
  "\\b(fornecedor|concorrente|outra (empresa|ag[êe]ncia)|contratei outro)\\b",
  // recusa e desinteresse
  "\\b(n[ãa]o (tenho|temos) interesse|sem interesse|n[ãa]o (quero|queremos|preciso|precisamos))\\b",
  "\\b(n[ãa]o (funciona|acredito|confio|vejo valor)|n[ãa]o serve (pra|para) mim)\\b",
  // desconfiança e prova
  "\\b(golpe|fraude|desconfi|é seguro|tem garantia|funciona mesmo|d[áa] resultado)\\b",
  "\\b(algum (case|exemplo|cliente)|prova|depoimento|quem j[áa] usou|refer[êe]ncia)\\b",
  // adiamento
  "\\b(vou pensar|preciso (pensar|analisar|ver com|conversar com)|me chama (depois|em)|mais (pra|para) frente)\\b",
  "\\b(agora n[ãa]o|momento (ruim|dif[íi]cil)|semana que vem|m[êe]s que vem|depois eu)\\b",
  // contrato / risco
  "\\b(fidelidade|contrato|multa|cancelar|rescis[ãa]o|permanência)\\b",
].join("|"), "i");

// true = essa mensagem merece o modelo forte
export function precisaModeloForte(textoDoLead) {
  const t = String(textoDoLead || "").trim();
  if (!t) return false;
  if (AUTORESPOSTA.test(t)) return false;        // robô de clínica, não é objeção
  return OBJECAO.test(t);                        // só objeção explícita escala
}

// ---------- aviso de chave sem saldo (mesma UX do modo CLI) ----------
function avisarProblemaChave(msg) {
  if (getConfig("anthropic_sem_saldo", "") === "1") return; // já avisado
  setConfig("anthropic_sem_saldo", "1");
  registrarEvento(null, "erro", `chave Anthropic: ${String(msg).slice(0, 120)}`);
  alertar("⚠️ <b>IA parada: problema na chave Anthropic</b>\nA chave está sem saldo ou foi revogada. Recarregue em console.anthropic.com e salve a chave de novo em Configurações.").catch(() => {});
}

/**
 * Chama a API Messages com o prompt do SDR.
 * @param {string} sistema  bloco FIXO (prompt base + cérebro) — vai cacheado
 * @param {string} usuario  bloco VOLÁTIL (lead, horários, conversa)
 * @param {string} ultimaDoLead  última mensagem do lead (decide o modelo)
 */
export async function chamarAPI(sistema, usuario, ultimaDoLead = "", forcarForte = false) {
  const chave = getConfig("anthropic_key", "") || process.env.ANTHROPIC_API_KEY || "";
  if (!chave) throw new Error("sem chave Anthropic configurada");

  const objecao = precisaModeloForte(ultimaDoLead);
  const forte = objecao || forcarForte;
  const modelo = forte ? MODELO_FORTE() : MODELO_PADRAO();
  // objecao detectada: alem do modelo forte, um lembrete explicito no prompt —
  // sem isso a IA tendia a aceitar a recusa e encerrar ("qualquer coisa me chama")
  if (objecao) usuario = `## OBJEÇÃO DETECTADA NA ÚLTIMA MENSAGEM DO LEAD
NÃO aceite e NÃO encerre a conversa. Aplique os 3As (Aceitar → Associar com um caso/argumento do TREINAMENTO → devolver UMA pergunta) usando a seção "Objeções" do TREINAMENTO. Só use \`perder\` se esta já for a SEGUNDA recusa clara do lead, ou se a recusa for definitiva/agressiva.

${usuario}`;

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": chave,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: modelo,
      max_tokens: 2000,
      // o bloco fixo (base + cérebro) é idêntico em toda chamada: cacheia.
      // TTL de 1h porque as respostas do SDR são espaçadas — com 5min o cache
      // expiraria entre um lead e outro e a gente pagaria a escrita à toa.
      system: [{ type: "text", text: sistema, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: usuario }],
    }),
  });

  const d = await res.json().catch(() => ({}));

  if (!res.ok) {
    let erro = d?.error?.message || `HTTP ${res.status}`;
    if (/workspace-id/i.test(erro))
      erro = "a chave é vinculada a identidade/workspace. Cria uma chave padrão em console.anthropic.com → API Keys e cola em Configurações.";
    if (/credit balance|billing|purchase credits|invalid x-api-key|authentication|workspace-id/i.test(erro))
      avisarProblemaChave(erro);
    throw new Error(`API Anthropic: ${erro}`);
  }

  // resposta boa depois de aviso de saldo = cliente recarregou: limpa o flag
  if (getConfig("anthropic_sem_saldo", "") === "1") setConfig("anthropic_sem_saldo", "");

  const texto = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const u = d.usage || {};
  // telemetria de custo: fica no log pra dar pra auditar gasto por conversa
  console.log(`[ia] ${modelo}${objecao ? " (objeção)" : forcarForte ? " (decisor)" : ""} · in ${u.input_tokens || 0}` +
    ` cache_w ${u.cache_creation_input_tokens || 0} cache_r ${u.cache_read_input_tokens || 0}` +
    ` out ${u.output_tokens || 0}`);
  return texto;
}
