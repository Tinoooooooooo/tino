// Conector uazapi — portado do Facilita (lm/produtos/ia-clinicas/lib/uazapi.ts).
// Mesmo servidor pago: facilitaaiclinicas.uazapi.com. Instancia propria do SDR.
const UAZAPI_URL = process.env.UAZAPI_URL || "";
const UAZAPI_ADMIN_TOKEN = process.env.UAZAPI_ADMIN_TOKEN || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const APP_URL = process.env.APP_URL || ""; // https://sdr.2-25-138-60.sslip.io

export const uazapiConfigurada = () => Boolean(UAZAPI_URL);

// markdown da IA -> formatacao do WhatsApp (**x** vira *x*)
export function markdownParaWhatsapp(texto) {
  return String(texto || "")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "_$1_");
}

export async function enviarTexto(instanceToken, telefone, texto) {
  const textoFmt = markdownParaWhatsapp(texto);
  if (!uazapiConfigurada()) {
    console.log(`[uazapi DEMO] -> ${telefone}: ${textoFmt}`);
    return { ok: true, demo: true };
  }
  try {
    const res = await fetch(`${UAZAPI_URL}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({ number: telefone, text: textoFmt }),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, erro: `HTTP ${res.status}`, raw };
    return { ok: true, raw };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// "digitando..." (presence composing) — best-effort, alguns segundos por chamada
export async function mostrarDigitando(instanceToken, telefone) {
  if (!uazapiConfigurada()) return;
  try {
    await fetch(`${UAZAPI_URL}/message/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({ number: telefone, presence: "composing" }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* best-effort */ }
}

// encerra o "digitando" na hora (sem isso o WhatsApp so apaga quando expira)
export async function pararDigitando(instanceToken, telefone) {
  if (!uazapiConfigurada()) return;
  try {
    await fetch(`${UAZAPI_URL}/message/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({ number: telefone, presence: "paused" }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* best-effort */ }
}

// tipo "audio" = nota de voz (bolinha de play). arquivo = data-url base64 ou URL http.
export async function enviarMidia(instanceToken, telefone, m) {
  if (!uazapiConfigurada()) {
    console.log(`[uazapi DEMO] midia ${m.tipo} -> ${telefone}`);
    return { ok: true, demo: true };
  }
  try {
    const res = await fetch(`${UAZAPI_URL}/send/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({
        number: telefone,
        type: m.tipo,
        file: m.arquivo,
        ...(m.nomeArquivo ? { docName: m.nomeArquivo } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (typeof raw?.message === "string" && raw.message) ||
        (typeof raw?.error === "string" && raw.error) || `HTTP ${res.status}`;
      return { ok: false, erro: msg, raw };
    }
    return { ok: true, raw };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// CRITICO: sem webhook configurado o WhatsApp conecta mas a IA nunca recebe nada
export async function configurarWebhook(instanceToken) {
  if (!uazapiConfigurada() || !WEBHOOK_SECRET || !APP_URL) return false;
  try {
    const res = await fetch(`${UAZAPI_URL}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({
        url: `${APP_URL}/webhook?secret=${WEBHOOK_SECRET}`,
        enabled: true,
        events: ["messages"],
        addUrlTypesMedia: ["audio", "image", "video", "document", "ptt"],
        excludeMessages: [],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch (e) {
    console.warn("[uazapi] falha ao configurar webhook:", e.message);
    return false;
  }
}

export async function criarInstancia(nome) {
  if (!uazapiConfigurada()) return { token: `demo-token-${nome}`, demo: true };
  try {
    const res = await fetch(`${UAZAPI_URL}/instance/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json", admintoken: UAZAPI_ADMIN_TOKEN },
      body: JSON.stringify({ name: nome }),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) return { erro: raw?.error || raw?.message || `HTTP ${res.status}` };
    const token = raw?.token || raw?.instance?.token;
    if (token) {
      // instancia nova nasce com proxy gerenciado sem rota BR: ja poe em direto,
      // senao o QR nunca aparece (19/08 — chip do Valentino travou nisso)
      await desligarProxyGerenciado(token);
      await configurarWebhook(token);
    }
    return { token };
  } catch (e) {
    return { erro: e.message };
  }
}

export const statusConectado = (s) => s === "connected" || s === "open" || s === "conectado";

export async function statusInstanciaLive(instanceToken) {
  if (!uazapiConfigurada()) return { conectado: true, status: "demo" };
  try {
    const res = await fetch(`${UAZAPI_URL}/instance/status`, {
      headers: { token: instanceToken },
      signal: AbortSignal.timeout(8_000),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) return { conectado: false, status: String(raw?.message || raw?.error || `HTTP ${res.status}`) };
    const i = raw?.instance || raw;
    const st = String(i?.status || "desconhecido");
    return { conectado: statusConectado(st), status: st };
  } catch (e) {
    return { conectado: false, status: e.message };
  }
}

const _jaTentouProxy = new Set(); // evita loop: 1 tentativa de desligar proxy por token
export async function conectarInstancia(instanceToken) {
  if (!uazapiConfigurada()) return { status: "demo", qrcode: null };
  try {
    const res = await fetch(`${UAZAPI_URL}/instance/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({}),
    });
    const raw = await res.json().catch(() => ({}));
    const msgErro = String(raw?.error || raw?.message || "").toLowerCase();
    if (res.status === 401 || res.status === 403 || msgErro.includes("invalid token")) {
      return { status: "token_invalido", tokenInvalido: true, erro: raw?.error || `HTTP ${res.status}` };
    }
    if (!res.ok) return { status: "erro", erro: raw?.error || `HTTP ${res.status}` };
    const i = raw?.instance || raw;
    // sem QR e travada no proxy gerenciado? desliga o proxy e tenta 1x de novo
    const travouNoProxy = !i?.qrcode && String(i?.lastDisconnectReason || "").includes("plainproxies");
    if (travouNoProxy && !_jaTentouProxy.has(instanceToken)) {
      _jaTentouProxy.add(instanceToken);
      console.warn("[uazapi] instancia travada no proxy gerenciado (sem rota BR) — desligando proxy e reconectando");
      if (await desligarProxyGerenciado(instanceToken)) {
        await new Promise((r) => setTimeout(r, 1500));
        return conectarInstancia(instanceToken);
      }
    }
    return { status: i?.status || "desconhecido", qrcode: i?.qrcode || null, paircode: i?.paircode || null, owner: i?.owner };
  } catch (e) {
    return { status: "erro", erro: e.message };
  }
}

// PROXY GERENCIADO: instancia nova nasce com proxy da uazapi e o provedor nao
// tem rota pro Brasil ("region route country unsupported: country=br") — ela
// nunca inicia a sessao e o QR NUNCA aparece. Isso poe em modo direto.
export async function desligarProxyGerenciado(instanceToken) {
  if (!uazapiConfigurada() || !instanceToken) return false;
  try {
    const res = await fetch(`${UAZAPI_URL}/instance/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({ mode: "none", confirm_no_proxy: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}

export async function desconectarInstancia(instanceToken) {
  if (!uazapiConfigurada() || !instanceToken) return false;
  try {
    const res = await fetch(`${UAZAPI_URL}/instance/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch { return false; }
}

// Checa se um numero TEM WhatsApp (evita disparar pra fixo/numero morto = queima chip).
// Retorna { temWhatsapp, numeroCorrigido } — a uazapi ja devolve o jid certo (com/sem 9o digito).
export async function checarWhatsapp(instanceToken, telefone) {
  if (!uazapiConfigurada()) return { temWhatsapp: true, numeroCorrigido: telefone }; // demo: nao bloqueia
  try {
    const res = await fetch(`${UAZAPI_URL}/chat/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({ numbers: [telefone] }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { temWhatsapp: null, erro: `HTTP ${res.status}` }; // null = incerto (nao bloqueia)
    const arr = await res.json().catch(() => []);
    const r = Array.isArray(arr) ? arr[0] : arr;
    const jid = String(r?.jid || "");
    return {
      temWhatsapp: Boolean(r?.isInWhatsapp),
      numeroCorrigido: jid ? jid.replace(/@.*$/, "").replace(/\D/g, "") : telefone,
    };
  } catch (e) {
    return { temWhatsapp: null, erro: e.message }; // erro de rede: incerto, nao bloqueia o disparo
  }
}

// FOTO DE PERFIL do WhatsApp de um numero. Tenta /chat/details (uazapi v2) e cai
// pro /chat/GetNameAndImageURL (versoes antigas). Devolve a URL da imagem
// (pps.whatsapp.net, expira em alguns dias) ou null quando o perfil nao tem foto
// ou esconde dos desconhecidos.
export async function fotoPerfilWhatsapp(instanceToken, telefone) {
  if (!uazapiConfigurada() || !instanceToken || !telefone) return null;
  const pegar = (d) => {
    const r = Array.isArray(d) ? d[0] : d;
    const url = r?.image || r?.imageUrl || r?.profilePicUrl || r?.imagePreview || "";
    return /^https:\/\//.test(url) ? url : null;
  };
  for (const [rota, corpo] of [["/chat/details", { number: telefone, preview: true }], ["/chat/GetNameAndImageURL", { number: telefone }]]) {
    try {
      const res = await fetch(`${UAZAPI_URL}${rota}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token: instanceToken },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 404 || res.status === 405) continue; // rota nao existe nessa versao
      if (!res.ok) return null;
      return pegar(await res.json().catch(() => null));
    } catch {
      return null;
    }
  }
  return null;
}

// Normaliza o payload do webhook (mesma logica batalhada do Facilita:
// eco da propria IA, grupos, figurinha, legenda de imagem, id pra dedup)
export function parseWebhook(body) {
  const msg = body?.message || body?.data?.message || body;
  if (!msg) return null;

  const fromMe = Boolean(msg.fromMe ?? msg.key?.fromMe);
  const enviadaPelaApi = Boolean(
    msg.fromApi ?? msg.wasSentByApi ?? msg.sentByApi ?? msg.api ??
    (typeof msg.source === "string" && /api/i.test(msg.source))
  );
  const chatidRaw = String(msg.chatid || msg.sender || msg.from || msg.key?.remoteJid || "");
  const ehGrupo = chatidRaw.includes("@g.us") || Boolean(msg.isGroup) || Boolean(msg.isgroup) ||
    Boolean(msg.key?.remoteJid?.includes?.("@g.us"));

  const textoRaw = msg.text ?? msg.body ?? msg.caption ??
    msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ??
    msg.message?.imageMessage?.caption ?? msg.message?.videoMessage?.caption ??
    msg.message?.documentMessage?.caption ?? "";
  const texto = typeof textoRaw === "string" ? textoRaw : "";

  const messageId = String(
    msg.id || msg.messageid || msg.messageId || msg.key?.id || msg.message?.key?.id || ""
  ) || null;

  const chatid = msg.chatid || msg.sender || msg.from || msg.key?.remoteJid || "";
  const telefone = String(chatid).replace(/@.*$/, "").replace(/\D/g, "");

  const rawTipo = String(msg.messageType || msg.type || Object.keys(msg.message || {})[0] || "").toLowerCase();
  let tipo = "texto";
  if (!texto) {
    if (rawTipo.includes("sticker")) tipo = "figurinha";
    else if (rawTipo.includes("audio") || rawTipo.includes("ptt")) tipo = "audio";
    else if (rawTipo.includes("image") || rawTipo.includes("imagem")) tipo = "imagem";
    else tipo = "outro";
  }

  // URL da midia (o webhook e configurado com addUrlTypesMedia, entao audio/imagem
  // chegam com link pronto). So aceita http — .enc do WhatsApp nao da pra abrir.
  const midiaUrl = [msg.content, msg.fileURL, msg.fileUrl, msg.mediaUrl, msg.file, msg.url]
    .find((v) => typeof v === "string" && /^https?:\/\//.test(v) && !v.includes(".enc")) || null;

  if (!telefone) return null;
  return { telefone, texto, tipo, fromMe, enviadaPelaApi, ehGrupo, messageId, midiaUrl };
}

// baixa o arquivo de uma mensagem de midia: tenta a URL do webhook, senao pede
// pra uazapi via /message/download (aceita resposta em arquivo, URL ou base64)
export async function baixarMidia(instanceToken, { midiaUrl, messageId } = {}) {
  try {
    if (midiaUrl) {
      const r = await fetch(midiaUrl, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    }
    if (!uazapiConfigurada() || !messageId || !instanceToken) return null;
    const r = await fetch(`${UAZAPI_URL}/message/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instanceToken },
      body: JSON.stringify({ id: messageId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) return Buffer.from(await r.arrayBuffer()); // veio o arquivo direto
    const j = await r.json().catch(() => null);
    if (!j) return null;
    const url = [j.fileURL, j.fileUrl, j.url, j.file, j.link]
      .find((v) => typeof v === "string" && /^https?:\/\//.test(v));
    if (url) {
      const r2 = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (r2.ok) return Buffer.from(await r2.arrayBuffer());
    }
    const b64 = j.base64 || j.data || (typeof j.content === "string" && !/^https?:\/\//.test(j.content) ? j.content : null);
    if (b64) return Buffer.from(String(b64).replace(/^data:.*?;base64,/, ""), "base64");
    return null;
  } catch {
    return null;
  }
}
