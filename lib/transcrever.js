// Transcricao de audio dos leads — fala com o servico local de whisper na VPS
// (faster-whisper, systemd `whisper-svc`, porta 8977). Sem API paga: roda na CPU.
// Se o servico estiver fora, retorna null e a conversa segue com o fallback
// ("pede pra pessoa escrever") — NUNCA derruba o webhook.
import { baixarMidia } from "./uazapi.js";

const SVC_URL = process.env.TRANSCRICAO_URL || "http://127.0.0.1:8977/transcrever";

export async function transcreverBuffer(buffer) {
  if (!buffer || !buffer.length) return null;
  if (buffer.length > 25 * 1024 * 1024) return null; // 25MB: nao e nota de voz
  try {
    const res = await fetch(SVC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buffer,
      signal: AbortSignal.timeout(180_000), // audio longo em CPU leva tempo
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const t = String(j?.texto || "").trim();
    return t || null;
  } catch {
    return null;
  }
}

// caminho completo: baixa o audio da mensagem e transcreve
export async function transcreverAudioMensagem(instanceToken, m) {
  const buf = await baixarMidia(instanceToken, { midiaUrl: m.midiaUrl, messageId: m.messageId });
  if (!buf) return null;
  return transcreverBuffer(buf);
}
