// Alertas no Telegram (lead quente, reuniao marcada, erro, chip caiu).
//
// MULTI-BOT: cada pessoa pode ter o PROPRIO bot. Um destino = par (token, chat).
//   - principal: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID do .env (Matheus)
//   - extras: config `telegram_destinos` = JSON [{nome, token, chat}] (Valentino
//     usa o bot dele; se o token do extra vier vazio, cai no bot principal —
//     compativel com quem so quer outro CHAT no mesmo bot)
// Cada alerta e enviado pra todos os destinos; falha em um nao derruba os outros.
import { getConfig, setConfig } from "./db.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const escaparHTML = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function extrasSalvos() {
  // formato novo: JSON [{nome, token, chat}]
  const bruto = String(getConfig("telegram_destinos", "") || "").trim();
  if (bruto.startsWith("[")) {
    try {
      return JSON.parse(bruto)
        .filter((d) => d && d.chat)
        .map((d) => ({
          nome: d.nome || "extra",
          token: String(d.token || "").trim() || TOKEN,
          chat: String(d.chat).trim(),
          usuario_id: d.usuario_id ? Number(d.usuario_id) : null,
        }));
    } catch { /* json quebrado: ignora */ }
  }
  // formato antigo (so chat_id no bot principal): continua valendo
  return String(getConfig("telegram_chats_extras", "") || "")
    .split(",").map((c) => c.trim()).filter(Boolean)
    .map((chat) => ({ nome: "extra", token: TOKEN, chat }));
}

// lista de destinos (bot + chat), sem duplicar o mesmo par
export function destinos() {
  const donoPrincipal = Number(getConfig("telegram_usuario_principal", "") || 0) || null;
  const todos = [{ nome: "principal", token: TOKEN, chat: CHAT_ID, usuario_id: donoPrincipal }, ...extrasSalvos()];
  const vistos = new Set();
  return todos.filter((d) => {
    if (!d.token || !d.chat) return false;
    const k = `${d.token}|${d.chat}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

// compat: paineis/rotas antigos que so queriam os chat_ids
export const chatsDestino = () => destinos().map((d) => d.chat);

export function salvarDestinos(lista) {
  setConfig("telegram_destinos", JSON.stringify(
    (lista || []).filter((d) => d?.chat).map((d) => ({
      nome: String(d.nome || "extra").slice(0, 40),
      token: String(d.token || "").trim(),
      chat: String(d.chat).trim(),
      usuario_id: d.usuario_id ? Number(d.usuario_id) : null,
    }))
  ));
  setConfig("telegram_chats_extras", ""); // migrou pro formato novo
}
export const destinosExtras = () => extrasSalvos();

// envia pra UM destino (usado pelo alertar e pela mensagem de teste do cadastro)
export async function enviarPara({ token, chat }, texto) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: escaparHTML(texto), parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    const corpo = await res.text().catch(() => "");
    console.warn(`[telegram] falha no chat ${chat}:`, res.status, corpo);
    return { ok: false, erro: `HTTP ${res.status}: ${corpo.slice(0, 200)}` };
  } catch (e) {
    console.warn(`[telegram] erro no chat ${chat}:`, e.message);
    return { ok: false, erro: e.message };
  }
}

// alertar(texto) -> vai pra todos (avisos do sistema: chip caiu, erro da IA).
// alertar(texto, { usuarioId }) -> vai SO pro Telegram daquela pessoa (avisos do
// lead dela: decisor, reuniao, pediu ligacao). Quem nao tem dono cadastrado
// continua recebendo tudo, pra nunca sumir aviso por config faltando.
export async function alertar(texto, opts = {}) {
  const todos = destinos();
  if (!todos.length) { console.log("[telegram DEMO]", texto); return false; }
  let alvos = todos;
  if (opts.usuarioId) {
    const doDono = todos.filter((d) => d.usuario_id === Number(opts.usuarioId));
    const semDono = todos.filter((d) => !d.usuario_id);
    // com destino do dono cadastrado, so ele recebe; senao cai no comportamento antigo
    alvos = doDono.length ? doDono : (semDono.length ? semDono : todos);
  }
  let algumOk = false;
  for (const d of alvos) if ((await enviarPara(d, texto)).ok) algumOk = true;
  return algumOk;
}

// quem mandou mensagem pro bot recentemente (pra descobrir o chat_id de quem
// quer receber os alertas — a pessoa manda /start e aparece aqui).
// token opcional: checa OUTRO bot (cadastro do bot proprio de alguem).
export async function chatsRecentes(token = TOKEN) {
  if (!token) return [];
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
    const d = await res.json().catch(() => null);
    if (!d?.ok) return [];
    const vistos = new Map();
    for (const u of d.result || []) {
      const c = u.message?.chat || u.my_chat_member?.chat;
      if (c?.id) vistos.set(String(c.id), { id: String(c.id), nome: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.title || c.username || String(c.id) });
    }
    return [...vistos.values()];
  } catch {
    return [];
  }
}

// nome do bot dono de um token (confirma no cadastro que o token e valido)
export async function nomeDoBot(token) {
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const d = await res.json().catch(() => null);
    return d?.ok ? (d.result.username || d.result.first_name || null) : null;
  } catch {
    return null;
  }
}
