// Google Calendar do closer — evento com Meet AUTOMATICO na criacao.
// Estrategia: reusa a autorizacao Google que o Matheus JA deu dentro do Facilita
// (tabela profissionais no Supabase do ia-clinicas, coluna gcal_refresh_token).
// O refresh token e buscado EM RUNTIME pelo servidor (nunca transita fora daqui)
// e cacheado na config local. Valentino: conectar o Google dele no Facilita e
// setar GCAL_PROF_VALENTINO, ou aguardar rota OAuth propria (backlog).
import { getConfig, setConfig } from "./db.js";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SUPABASE_URL = process.env.FACILITA_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.FACILITA_SUPABASE_KEY || "";
const PROF_IDS = {
  matheus: process.env.GCAL_PROF_MATHEUS || "",
  valentino: process.env.GCAL_PROF_VALENTINO || "",
};

export const gcalConfigurado = (closer) =>
  Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && (PROF_IDS[closer] || getConfig(`gcal_refresh_${closer}`)));

// refresh token do closer: cache local -> Supabase do Facilita
async function refreshTokenDoCloser(closer) {
  const cache = getConfig(`gcal_refresh_${closer}`, "");
  if (cache) return cache;
  const profId = PROF_IDS[closer];
  if (!profId || !SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profissionais?id=eq.${profId}&select=gcal_refresh_token`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, signal: AbortSignal.timeout(10_000) }
    );
    const rows = await res.json();
    const token = rows?.[0]?.gcal_refresh_token || null;
    if (token) setConfig(`gcal_refresh_${closer}`, token);
    return token;
  } catch (e) {
    console.warn("[gcal] falha ao buscar refresh no Facilita:", e.message);
    return null;
  }
}

async function accessToken(closer) {
  const refresh = await refreshTokenDoCloser(closer);
  if (!refresh) return null;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refresh, grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const d = await res.json();
    if (!d.access_token) {
      console.warn("[gcal] refresh falhou:", JSON.stringify(d).slice(0, 200));
      if (d.error === "invalid_grant") setConfig(`gcal_refresh_${closer}`, ""); // token revogado: limpa cache
      return null;
    }
    return d.access_token;
  } catch (e) {
    console.warn("[gcal] erro no token:", e.message);
    return null;
  }
}

/**
 * Cria evento de 30min no calendario primario do closer com Meet automatico.
 * inicio = "AAAA-MM-DDTHH:MM" (hora de parede SP). Best-effort: null em falha.
 */
export async function criarEventoMeet(closer, inicio, { resumo, descricao, duracaoMin = 30, convidados = [] } = {}) {
  const token = await accessToken(closer);
  if (!token) return null;
  const fim = new Date(new Date(`${inicio}:00-03:00`).getTime() + duracaoMin * 60_000)
    .toISOString(); // fim em UTC; o Google aceita com timeZone no start
  try {
    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: resumo || `Reunião ${process.env.CLIENTE_NOME || "Facilita"}`,
          description: descricao || "",
          start: { dateTime: `${inicio}:00`, timeZone: "America/Sao_Paulo" },
          end: { dateTime: fim },
          conferenceData: { createRequest: { requestId: `sdr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, conferenceSolutionKey: { type: "hangoutsMeet" } } },
          // convidados (o socio recebe o convite na agenda dele tambem)
          ...(convidados.length ? { attendees: convidados.map((email) => ({ email })) } : {}),
          reminders: { useDefault: true },
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    const ev = await res.json();
    if (!res.ok) { console.warn("[gcal] criar evento falhou:", JSON.stringify(ev).slice(0, 300)); return null; }
    const meet = ev.hangoutLink ||
      ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri || null;
    return { eventId: ev.id, meet };
  } catch (e) {
    console.warn("[gcal] erro ao criar evento:", e.message);
    return null;
  }
}

/** Testa se a agenda do closer esta funcional (consegue emitir access token). */
export async function statusConexao(closer) {
  return Boolean(await accessToken(closer));
}

/** Lista os eventos da agenda do closer numa janela de dias (espelho no painel).
 *  Retorna [] se a agenda nao estiver conectada — nunca quebra a tela. */
export async function listarEventos(closer, { dias = 14, desdeDias = 1 } = {}) {
  const token = await accessToken(closer);
  if (!token) return [];
  const inicio = new Date(Date.now() - desdeDias * 864e5).toISOString();
  const fim = new Date(Date.now() + dias * 864e5).toISOString();
  const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    + `?timeMin=${encodeURIComponent(inicio)}&timeMax=${encodeURIComponent(fim)}`
    + "&singleEvents=true&orderBy=startTime&maxResults=100";
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.items || [])
      .filter((e) => e.status !== "cancelled")
      .map((e) => ({
        id: e.id,
        titulo: e.summary || "(sem título)",
        inicio: e.start?.dateTime || e.start?.date || null,
        fim: e.end?.dateTime || e.end?.date || null,
        diaInteiro: !e.start?.dateTime,
        meet: e.hangoutLink || null,
        link: e.htmlLink || null,
        convidados: (e.attendees || []).length,
        organizador: e.organizer?.email || null,
      }));
  } catch { return []; }
}

/** Apaga o evento (cancelamento/no-show remarcado). Best-effort. */
export async function apagarEventoMeet(closer, eventId) {
  if (!eventId) return false;
  const token = await accessToken(closer);
  if (!token) return false;
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
    );
    return res.ok || res.status === 404 || res.status === 410;
  } catch { return false; }
}
